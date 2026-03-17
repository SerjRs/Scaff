use std::time::{Duration, Instant};

/// Silence detector using RMS (Root Mean Square) over a sliding window.
pub struct SilenceDetector {
    /// Linear amplitude threshold (converted from dB at construction).
    threshold_linear: f32,
    /// How long silence must persist before triggering.
    timeout: Duration,
    /// When continuous silence started (None = not silent).
    silence_start: Option<Instant>,
}

/// Convert a dB threshold to linear amplitude.
/// dB = 20 * log10(linear), so linear = 10^(dB/20).
pub fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

/// Calculate RMS of a sample buffer.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|&s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

impl SilenceDetector {
    pub fn new(threshold_db: f32, timeout_secs: u64) -> Self {
        Self {
            threshold_linear: db_to_linear(threshold_db),
            timeout: Duration::from_secs(timeout_secs),
            silence_start: None,
        }
    }

    /// Feed a buffer of samples. Returns true if silence timeout has been reached.
    pub fn process(&mut self, samples: &[f32]) -> bool {
        let level = rms(samples);

        if level < self.threshold_linear {
            // Below threshold → silence
            if self.silence_start.is_none() {
                self.silence_start = Some(Instant::now());
            }
            if let Some(start) = self.silence_start {
                return start.elapsed() >= self.timeout;
            }
        } else {
            // Above threshold → reset
            self.silence_start = None;
        }

        false
    }

    /// Reset the silence tracker (e.g., on new session).
    pub fn reset(&mut self) {
        self.silence_start = None;
    }

    /// Check if currently in a silence period (but not yet timed out).
    pub fn is_silent(&self) -> bool {
        self.silence_start.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_db_to_linear() {
        // 0 dB = 1.0 linear
        let lin = db_to_linear(0.0);
        assert!((lin - 1.0).abs() < 0.001);

        // -20 dB = 0.1 linear
        let lin = db_to_linear(-20.0);
        assert!((lin - 0.1).abs() < 0.001);

        // -50 dB ≈ 0.00316
        let lin = db_to_linear(-50.0);
        assert!((lin - 0.00316).abs() < 0.001);
    }

    #[test]
    fn test_rms_silence() {
        let samples = vec![0.0; 100];
        assert_eq!(rms(&samples), 0.0);
    }

    #[test]
    fn test_rms_constant_signal() {
        let samples = vec![0.5; 100];
        let r = rms(&samples);
        assert!((r - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_rms_empty() {
        assert_eq!(rms(&[]), 0.0);
    }

    #[test]
    fn test_silence_detector_loud_signal() {
        let mut detector = SilenceDetector::new(-50.0, 1);
        // Loud signal should not trigger silence
        let loud = vec![0.5; 1000];
        assert!(!detector.process(&loud));
        assert!(!detector.is_silent());
    }

    #[test]
    fn test_silence_detector_quiet_no_timeout() {
        let mut detector = SilenceDetector::new(-50.0, 60);
        // Very quiet signal — should be silent but not timed out
        let quiet = vec![0.0001; 1000];
        assert!(!detector.process(&quiet)); // timeout=60s, hasn't elapsed
        assert!(detector.is_silent());
    }

    #[test]
    fn test_silence_detector_reset_on_loud() {
        let mut detector = SilenceDetector::new(-50.0, 60);
        let quiet = vec![0.0001; 100];
        let loud = vec![0.5; 100];

        detector.process(&quiet);
        assert!(detector.is_silent());

        detector.process(&loud);
        assert!(!detector.is_silent());
    }

    #[test]
    fn test_silence_detector_reset() {
        let mut detector = SilenceDetector::new(-50.0, 60);
        let quiet = vec![0.0; 100];
        detector.process(&quiet);
        assert!(detector.is_silent());

        detector.reset();
        assert!(!detector.is_silent());
    }

    #[test]
    fn test_silence_timeout_fires() {
        // Use 0-second timeout so it fires immediately
        let mut detector = SilenceDetector::new(-50.0, 0);
        let quiet = vec![0.0; 100];
        assert!(detector.process(&quiet));
    }
}
