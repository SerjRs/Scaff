use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
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
            let mut sent: HashSet<PathBuf> = HashSet::new();
            let mut check_interval = tokio::time::interval(std::time::Duration::from_millis(500));

            // Scan for pre-existing files before entering event loop
            let existing = scan_existing_files(&outbox);
            for p in existing {
                let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                pending.insert(p, (size, Instant::now()));
            }

            loop {
                tokio::select! {
                    _ = check_interval.tick() => {
                        // Drain notify events
                        while let Ok(evt) = notify_rx.try_recv() {
                            match evt.kind {
                                EventKind::Create(_) | EventKind::Modify(_) => {
                                    for p in &evt.paths {
                                        if is_wav(p) && !is_in_failed_dir(p, &outbox) && !sent.contains(p) {
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
                        for (path, (last_size, last_changed)) in &mut pending {
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
                            if path.exists() && !sent.contains(path) {
                                sent.insert(path.clone());
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

/// Scan the outbox directory for existing `.wav` files, excluding `failed/`.
/// Returns sorted paths (ensures chunk ordering).
pub fn scan_existing_files(outbox: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(outbox) {
        for entry in entries.flatten() {
            let path = entry.path();
            if is_wav(&path) && !is_in_failed_dir(&path, outbox) {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

/// Count files in the outbox that belong to a given session (excluding failed/).
/// Used by drain logic to check if uploads are still pending.
pub fn pending_for_session(outbox_dir: &Path, session_id: &str) -> usize {
    scan_existing_files(outbox_dir)
        .iter()
        .filter(|p| {
            parse_chunk_filename(p)
                .map(|(sid, _)| sid == session_id)
                .unwrap_or(false)
        })
        .count()
}

/// Parse session_id and sequence from a chunk filename.
/// Supported formats:
///   {session_id}_chunk-{seq:04}_{timestamp}.wav  (capture engine output)
///   {session_id}_chunk_{seq:04}.wav              (legacy/test format)
pub fn parse_chunk_filename(path: &Path) -> Option<(String, u32)> {
    let stem = path.file_stem()?.to_str()?;

    // Try capture engine format first: _chunk-{seq}_{ts}
    if let Some(idx) = stem.rfind("_chunk-") {
        let session_id = &stem[..idx];
        let after = &stem[idx + 7..]; // skip "_chunk-"
        // after = "0001_1710700000" — take digits before the first underscore
        let seq_str = after.split('_').next()?;
        let sequence = seq_str.parse::<u32>().ok()?;
        return Some((session_id.to_string(), sequence));
    }

    // Fallback: legacy format _chunk_{seq}
    if let Some(idx) = stem.rfind("_chunk_") {
        let session_id = &stem[..idx];
        let seq_str = &stem[idx + 7..];
        let sequence = seq_str.parse::<u32>().ok()?;
        return Some((session_id.to_string(), sequence));
    }

    None
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
    fn parse_capture_engine_format() {
        // Real capture engine output: {session}_chunk-{seq}_{timestamp}.wav
        let p = Path::new("/tmp/outbox/abc123_chunk-0001_1710700000.wav");
        let (sid, seq) = parse_chunk_filename(p).unwrap();
        assert_eq!(sid, "abc123");
        assert_eq!(seq, 1);

        let p2 = Path::new("/tmp/outbox/my-uuid-session_chunk-0042_1710700999.wav");
        let (sid2, seq2) = parse_chunk_filename(p2).unwrap();
        assert_eq!(sid2, "my-uuid-session");
        assert_eq!(seq2, 42);
    }

    #[test]
    fn parse_legacy_format() {
        // Legacy/test format: {session}_chunk_{seq}.wav
        let p = Path::new("/tmp/outbox/sess-abc_chunk_0001.wav");
        let (sid, seq) = parse_chunk_filename(p).unwrap();
        assert_eq!(sid, "sess-abc");
        assert_eq!(seq, 1);
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

    #[test]
    fn scan_existing_files_finds_wavs_sorted_excludes_failed() {
        let tmp = tempfile::tempdir().unwrap();
        let outbox = tmp.path();

        // Create wav files (out of alphabetical order)
        let mut f1 = std::fs::File::create(outbox.join("b_chunk_0002.wav")).unwrap();
        f1.write_all(b"RIFF").unwrap();
        let mut f2 = std::fs::File::create(outbox.join("a_chunk_0001.wav")).unwrap();
        f2.write_all(b"RIFF").unwrap();

        // Non-wav file (should be excluded)
        std::fs::File::create(outbox.join("readme.txt")).unwrap();

        // Failed dir with a wav (should be excluded)
        std::fs::create_dir_all(outbox.join("failed")).unwrap();
        let mut f3 = std::fs::File::create(outbox.join("failed").join("bad_chunk_0001.wav")).unwrap();
        f3.write_all(b"RIFF").unwrap();

        let files = scan_existing_files(outbox);
        assert_eq!(files.len(), 2);
        assert!(files[0].to_string_lossy().contains("a_chunk_0001.wav"));
        assert!(files[1].to_string_lossy().contains("b_chunk_0002.wav"));
    }

    #[test]
    fn scan_existing_files_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let files = scan_existing_files(tmp.path());
        assert!(files.is_empty());
    }

    #[test]
    fn pending_for_session_counts_matching_files() {
        let tmp = tempfile::tempdir().unwrap();
        let outbox = tmp.path();

        // Create files for two sessions
        std::fs::write(outbox.join("sess-a_chunk_0001.wav"), b"RIFF").unwrap();
        std::fs::write(outbox.join("sess-a_chunk_0002.wav"), b"RIFF").unwrap();
        std::fs::write(outbox.join("sess-b_chunk_0001.wav"), b"RIFF").unwrap();

        assert_eq!(pending_for_session(outbox, "sess-a"), 2);
        assert_eq!(pending_for_session(outbox, "sess-b"), 1);
        assert_eq!(pending_for_session(outbox, "sess-c"), 0);
    }

    #[test]
    fn pending_for_session_excludes_failed() {
        let tmp = tempfile::tempdir().unwrap();
        let outbox = tmp.path();

        std::fs::write(outbox.join("sess-a_chunk_0001.wav"), b"RIFF").unwrap();
        std::fs::create_dir_all(outbox.join("failed")).unwrap();
        std::fs::write(outbox.join("failed").join("sess-a_chunk_0002.wav"), b"RIFF").unwrap();

        assert_eq!(pending_for_session(outbox, "sess-a"), 1);
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
