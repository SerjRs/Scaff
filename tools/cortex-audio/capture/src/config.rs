use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::CaptureError;

/// Configuration for the audio capture engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureConfig {
    /// Maximum size of each WAV chunk file in bytes (default: 10 MB).
    #[serde(default = "default_max_chunk_size")]
    pub max_chunk_size_bytes: usize,

    /// Seconds of silence before auto-ending a session (default: 60).
    #[serde(default = "default_silence_timeout")]
    pub silence_timeout_secs: u64,

    /// Silence threshold in dB (default: -50.0).
    #[serde(default = "default_silence_threshold")]
    pub silence_threshold_db: f32,

    /// Sample rate in Hz (default: 44100).
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,

    /// Directory where WAV chunk files are written.
    pub outbox_dir: PathBuf,
}

fn default_max_chunk_size() -> usize {
    10 * 1024 * 1024
}

fn default_silence_timeout() -> u64 {
    60
}

fn default_silence_threshold() -> f32 {
    -50.0
}

fn default_sample_rate() -> u32 {
    44100
}

impl CaptureConfig {
    /// Create a new config with defaults, only requiring the outbox directory.
    pub fn new(outbox_dir: PathBuf) -> Self {
        Self {
            max_chunk_size_bytes: default_max_chunk_size(),
            silence_timeout_secs: default_silence_timeout(),
            silence_threshold_db: default_silence_threshold(),
            sample_rate: default_sample_rate(),
            outbox_dir,
        }
    }

    /// Validate the configuration, returning an error if any values are invalid.
    pub fn validate(&self) -> Result<(), CaptureError> {
        if self.max_chunk_size_bytes == 0 {
            return Err(CaptureError::InvalidConfig(
                "max_chunk_size_bytes must be greater than 0".into(),
            ));
        }
        if self.silence_timeout_secs == 0 {
            return Err(CaptureError::InvalidConfig(
                "silence_timeout_secs must be greater than 0".into(),
            ));
        }
        if self.silence_threshold_db > 0.0 {
            return Err(CaptureError::InvalidConfig(
                "silence_threshold_db must be <= 0 dB".into(),
            ));
        }
        if self.sample_rate == 0 {
            return Err(CaptureError::InvalidConfig(
                "sample_rate must be greater than 0".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = CaptureConfig::new(PathBuf::from("/tmp/outbox"));
        assert_eq!(config.max_chunk_size_bytes, 10 * 1024 * 1024);
        assert_eq!(config.silence_timeout_secs, 60);
        assert_eq!(config.silence_threshold_db, -50.0);
        assert_eq!(config.sample_rate, 44100);
    }

    #[test]
    fn test_valid_config() {
        let config = CaptureConfig::new(PathBuf::from("/tmp/outbox"));
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_zero_chunk_size_rejected() {
        let mut config = CaptureConfig::new(PathBuf::from("/tmp/outbox"));
        config.max_chunk_size_bytes = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_zero_sample_rate_rejected() {
        let mut config = CaptureConfig::new(PathBuf::from("/tmp/outbox"));
        config.sample_rate = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_zero_silence_timeout_rejected() {
        let mut config = CaptureConfig::new(PathBuf::from("/tmp/outbox"));
        config.silence_timeout_secs = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_positive_threshold_rejected() {
        let mut config = CaptureConfig::new(PathBuf::from("/tmp/outbox"));
        config.silence_threshold_db = 10.0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_zero_threshold_accepted() {
        let mut config = CaptureConfig::new(PathBuf::from("/tmp/outbox"));
        config.silence_threshold_db = 0.0;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_serde_roundtrip() {
        let config = CaptureConfig::new(PathBuf::from("/tmp/outbox"));
        let json = serde_json::to_string(&config).unwrap();
        let parsed: CaptureConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.max_chunk_size_bytes, config.max_chunk_size_bytes);
        assert_eq!(parsed.sample_rate, config.sample_rate);
    }
}
