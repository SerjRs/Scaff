use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio::sync::mpsc;

/// Tracks file sizes to detect write-completion (stable for `stability_ms`).
pub struct OutboxWatcher {
    _watcher: RecommendedWatcher,
    rx: mpsc::Receiver<PathBuf>,
}

/// Minimum time (in ms) a file's size must remain unchanged before it's
/// considered fully written.
const STABILITY_MS: u64 = 2_000;

impl OutboxWatcher {
    /// Start watching `outbox_dir` for new `.wav` files.
    /// Returns ready file paths via the internal channel.
    pub fn new(outbox_dir: &Path) -> Result<Self, notify::Error> {
        let (notify_tx, notify_rx) = std::sync::mpsc::channel::<Event>();
        let (tx, rx) = mpsc::channel::<PathBuf>(256);

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(evt) = res {
                    let _ = notify_tx.send(evt);
                }
            },
            notify::Config::default(),
        )?;

        watcher.watch(outbox_dir, RecursiveMode::NonRecursive)?;

        // Spawn a background task that tracks file stability
        let outbox = outbox_dir.to_path_buf();
        tokio::spawn(async move {
            let mut pending: HashMap<PathBuf, (u64, Instant)> = HashMap::new();
            let mut check_interval = tokio::time::interval(std::time::Duration::from_millis(500));

            loop {
                tokio::select! {
                    _ = check_interval.tick() => {
                        // Drain notify events
                        while let Ok(evt) = notify_rx.try_recv() {
                            match evt.kind {
                                EventKind::Create(_) | EventKind::Modify(_) => {
                                    for p in &evt.paths {
                                        if is_wav(p) && !is_in_failed_dir(p, &outbox) {
                                            let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
                                            pending.insert(p.clone(), (size, Instant::now()));
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }

                        // Check stability
                        let now = Instant::now();
                        let mut ready = Vec::new();
                        for (path, (last_size, last_changed)) in &mut *&mut pending {
                            if !path.exists() {
                                ready.push(path.clone());
                                continue;
                            }
                            let current_size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                            if current_size != *last_size {
                                *last_size = current_size;
                                *last_changed = now;
                            } else if now.duration_since(*last_changed).as_millis() >= STABILITY_MS as u128 {
                                ready.push(path.clone());
                            }
                        }

                        for path in &ready {
                            pending.remove(path);
                            if path.exists() {
                                let _ = tx.send(path.clone()).await;
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            _watcher: watcher,
            rx,
        })
    }

    /// Receive the next stable WAV file path.
    pub async fn next_file(&mut self) -> Option<PathBuf> {
        self.rx.recv().await
    }
}

fn is_wav(p: &Path) -> bool {
    p.extension()
        .map(|e| e.eq_ignore_ascii_case("wav"))
        .unwrap_or(false)
}

fn is_in_failed_dir(p: &Path, outbox: &Path) -> bool {
    p.starts_with(outbox.join("failed"))
}

/// Parse session_id and sequence from a chunk filename.
/// Expected format: `{session_id}_chunk_{sequence:04}.wav`
pub fn parse_chunk_filename(path: &Path) -> Option<(String, u32)> {
    let stem = path.file_stem()?.to_str()?;
    let idx = stem.rfind("_chunk_")?;
    let session_id = &stem[..idx];
    let seq_str = &stem[idx + 7..]; // skip "_chunk_"
    let sequence = seq_str.parse::<u32>().ok()?;
    Some((session_id.to_string(), sequence))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parse_chunk_names() {
        let p = Path::new("/tmp/outbox/sess-abc_chunk_0001.wav");
        let (sid, seq) = parse_chunk_filename(p).unwrap();
        assert_eq!(sid, "sess-abc");
        assert_eq!(seq, 1);

        let p2 = Path::new("/tmp/outbox/my-session_chunk_0042.wav");
        let (sid2, seq2) = parse_chunk_filename(p2).unwrap();
        assert_eq!(sid2, "my-session");
        assert_eq!(seq2, 42);
    }

    #[test]
    fn parse_invalid_names() {
        assert!(parse_chunk_filename(Path::new("foo.wav")).is_none());
        assert!(parse_chunk_filename(Path::new("sess_chunk_abc.wav")).is_none());
        assert!(parse_chunk_filename(Path::new("noext")).is_none());
    }

    #[test]
    fn is_wav_check() {
        assert!(is_wav(Path::new("foo.wav")));
        assert!(is_wav(Path::new("FOO.WAV")));
        assert!(!is_wav(Path::new("foo.mp3")));
        assert!(!is_wav(Path::new("foo")));
    }

    #[test]
    fn failed_dir_check() {
        let outbox = Path::new("/tmp/outbox");
        assert!(is_in_failed_dir(
            Path::new("/tmp/outbox/failed/chunk.wav"),
            outbox
        ));
        assert!(!is_in_failed_dir(
            Path::new("/tmp/outbox/chunk.wav"),
            outbox
        ));
    }

    #[tokio::test]
    async fn watcher_detects_new_file() {
        let tmp = tempfile::tempdir().unwrap();
        let outbox = tmp.path().to_path_buf();
        let mut w = OutboxWatcher::new(&outbox).unwrap();

        // Write a file after a short delay
        let out = outbox.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let p = out.join("sess1_chunk_0001.wav");
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(b"RIFF....WAVEfmt ").unwrap();
        });

        // Should receive it after stability period (~2.5s)
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), w.next_file()).await;
        assert!(result.is_ok());
        let path = result.unwrap().unwrap();
        assert!(path.to_string_lossy().contains("sess1_chunk_0001.wav"));
    }
}
