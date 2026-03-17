use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::{fs, io};

/// Tray app configuration — persisted to %LOCALAPPDATA%\CortexAudio\config.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrayConfig {
    #[serde(rename = "maxChunkSizeMB", default = "default_max_chunk_size_mb")]
    pub max_chunk_size_mb: u32,

    #[serde(rename = "silenceTimeoutSeconds", default = "default_silence_timeout_seconds")]
    pub silence_timeout_seconds: u64,

    #[serde(rename = "silenceThresholdDb", default = "default_silence_threshold_db")]
    pub silence_threshold_db: f32,

    #[serde(rename = "sampleRate", default = "default_sample_rate")]
    pub sample_rate: u32,

    #[serde(rename = "serverUrl", default = "default_server_url")]
    pub server_url: String,

    #[serde(rename = "apiKey", default)]
    pub api_key: String,

    #[serde(rename = "outboxDir", default = "default_outbox_dir")]
    pub outbox_dir: PathBuf,

    #[serde(rename = "maxRetries", default = "default_max_retries")]
    pub max_retries: u32,

    #[serde(rename = "initialBackoffMs", default = "default_initial_backoff_ms")]
    pub initial_backoff_ms: u64,

    #[serde(rename = "maxBackoffMs", default = "default_max_backoff_ms")]
    pub max_backoff_ms: u64,
}

fn default_max_chunk_size_mb() -> u32 {
    10
}
fn default_silence_timeout_seconds() -> u64 {
    60
}
fn default_silence_threshold_db() -> f32 {
    -50.0
}
fn default_sample_rate() -> u32 {
    44100
}
fn default_server_url() -> String {
    "https://cortex.internal:9500".to_string()
}
fn default_outbox_dir() -> PathBuf {
    // Relative to exe location for portable deployments
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("capture")))
        .unwrap_or_else(|| PathBuf::from("capture"))
}

fn default_max_retries() -> u32 {
    3
}
fn default_initial_backoff_ms() -> u64 {
    1000
}
fn default_max_backoff_ms() -> u64 {
    30000
}

impl Default for TrayConfig {
    fn default() -> Self {
        Self {
            max_chunk_size_mb: default_max_chunk_size_mb(),
            silence_timeout_seconds: default_silence_timeout_seconds(),
            silence_threshold_db: default_silence_threshold_db(),
            sample_rate: default_sample_rate(),
            server_url: default_server_url(),
            api_key: String::new(),
            outbox_dir: default_outbox_dir(),
            max_retries: default_max_retries(),
            initial_backoff_ms: default_initial_backoff_ms(),
            max_backoff_ms: default_max_backoff_ms(),
        }
    }
}

impl TrayConfig {
    /// Convert to a ShipperConfig suitable for the chunk shipper.
    pub fn to_shipper_config(&self) -> shipper::ShipperConfig {
        shipper::ShipperConfig {
            server_url: self.server_url.clone(),
            api_key: self.api_key.clone(),
            outbox_dir: self.outbox_dir.clone(),
            max_retries: self.max_retries,
            initial_backoff_ms: self.initial_backoff_ms,
            max_backoff_ms: self.max_backoff_ms,
        }
    }

    /// Convert to a CaptureConfig suitable for the capture engine.
    pub fn to_capture_config(&self) -> capture::CaptureConfig {
        let mut cc = capture::CaptureConfig::new(self.outbox_dir.clone());
        cc.max_chunk_size_bytes = (self.max_chunk_size_mb as usize) * 1024 * 1024;
        cc.silence_timeout_secs = self.silence_timeout_seconds;
        cc.silence_threshold_db = self.silence_threshold_db;
        cc.sample_rate = self.sample_rate;
        cc
    }
}

/// Returns the app data directory: %LOCALAPPDATA%\CortexAudio
pub fn app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("CortexAudio")
}

/// Path to the config file.
/// Checks for `config.json` next to the exe first, then falls back to %LOCALAPPDATA%\CortexAudio\.
pub fn config_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let local = dir.join("config.json");
            if local.exists() {
                return local;
            }
        }
    }
    app_data_dir().join("config.json")
}

/// Load config from disk. Returns defaults if file is missing; errors on invalid JSON.
pub fn load_config() -> Result<TrayConfig, ConfigError> {
    load_config_from(&config_path())
}

/// Load config from a specific path (for testing).
pub fn load_config_from(path: &Path) -> Result<TrayConfig, ConfigError> {
    match fs::read_to_string(path) {
        Ok(contents) => {
            let config: TrayConfig =
                serde_json::from_str(&contents).map_err(ConfigError::InvalidJson)?;
            Ok(config)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(TrayConfig::default()),
        Err(e) => Err(ConfigError::Io(e)),
    }
}

/// Save config to the default path, creating the directory if needed.
pub fn save_config(config: &TrayConfig) -> Result<(), ConfigError> {
    save_config_to(config, &config_path())
}

/// Save config to a specific path (for testing).
pub fn save_config_to(config: &TrayConfig, path: &Path) -> Result<(), ConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(ConfigError::Io)?;
    }
    let json = serde_json::to_string_pretty(config).map_err(ConfigError::InvalidJson)?;
    fs::write(path, json).map_err(ConfigError::Io)?;
    Ok(())
}

#[derive(Debug)]
pub enum ConfigError {
    Io(io::Error),
    InvalidJson(serde_json::Error),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Io(e) => write!(f, "I/O error: {e}"),
            ConfigError::InvalidJson(e) => write!(f, "Invalid JSON: {e}"),
        }
    }
}

impl std::error::Error for ConfigError {}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_defaults() {
        let config = TrayConfig::default();
        assert_eq!(config.max_chunk_size_mb, 10);
        assert_eq!(config.silence_timeout_seconds, 60);
        assert_eq!(config.silence_threshold_db, -50.0);
        assert_eq!(config.sample_rate, 44100);
        assert!(config.api_key.is_empty());
    }

    #[test]
    fn test_load_missing_file_returns_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        let config = load_config_from(&path).unwrap();
        assert_eq!(config.max_chunk_size_mb, 10);
    }

    #[test]
    fn test_load_valid_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{ "maxChunkSizeMB": 20, "silenceTimeoutSeconds": 30, "sampleRate": 48000 }"#,
        )
        .unwrap();
        let config = load_config_from(&path).unwrap();
        assert_eq!(config.max_chunk_size_mb, 20);
        assert_eq!(config.silence_timeout_seconds, 30);
        assert_eq!(config.sample_rate, 48000);
        // Fields not in JSON should get defaults
        assert_eq!(config.silence_threshold_db, -50.0);
    }

    #[test]
    fn test_load_invalid_json_errors() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "NOT VALID JSON{{{").unwrap();
        assert!(load_config_from(&path).is_err());
    }

    #[test]
    fn test_save_and_reload() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sub").join("config.json");
        let mut config = TrayConfig::default();
        config.max_chunk_size_mb = 42;
        config.api_key = "test-key".to_string();
        save_config_to(&config, &path).unwrap();

        let loaded = load_config_from(&path).unwrap();
        assert_eq!(loaded.max_chunk_size_mb, 42);
        assert_eq!(loaded.api_key, "test-key");
    }

    #[test]
    fn test_to_capture_config() {
        let config = TrayConfig::default();
        let cc = config.to_capture_config();
        assert_eq!(cc.max_chunk_size_bytes, 10 * 1024 * 1024);
        assert_eq!(cc.silence_timeout_secs, 60);
        assert_eq!(cc.sample_rate, 44100);
    }

    #[test]
    fn test_default_outbox_is_capture_next_to_exe() {
        let outbox = default_outbox_dir();
        // Should end with "capture" (relative to exe or fallback)
        assert_eq!(
            outbox.file_name().unwrap().to_str().unwrap(),
            "capture"
        );
        // Should NOT contain "outbox" (old default)
        assert!(
            !outbox.to_string_lossy().contains("outbox"),
            "Default outbox should be ./capture/, not %LOCALAPPDATA%\\outbox"
        );
    }

    #[test]
    fn test_shipper_config_defaults() {
        let config = TrayConfig::default();
        assert_eq!(config.max_retries, 3);
        assert_eq!(config.initial_backoff_ms, 1000);
        assert_eq!(config.max_backoff_ms, 30000);
    }

    #[test]
    fn test_to_shipper_config() {
        let mut config = TrayConfig::default();
        config.server_url = "http://localhost:9000".to_string();
        config.api_key = "test-key".to_string();
        config.max_retries = 5;
        config.initial_backoff_ms = 500;
        config.max_backoff_ms = 10000;

        let sc = config.to_shipper_config();
        assert_eq!(sc.server_url, "http://localhost:9000");
        assert_eq!(sc.api_key, "test-key");
        assert_eq!(sc.max_retries, 5);
        assert_eq!(sc.initial_backoff_ms, 500);
        assert_eq!(sc.max_backoff_ms, 10000);
        assert_eq!(sc.outbox_dir, config.outbox_dir);
    }

    #[test]
    fn test_shipper_config_from_defaults_is_valid() {
        let config = TrayConfig::default();
        let sc = config.to_shipper_config();
        // Default server_url is not empty, so validation should pass
        assert!(sc.validate().is_ok());
    }

    #[test]
    fn test_config_serde_roundtrip_with_shipper_fields() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("config.json");
        fs::write(
            &path,
            r#"{
                "serverUrl": "http://test:8080",
                "apiKey": "my-key",
                "maxRetries": 7,
                "initialBackoffMs": 2000,
                "maxBackoffMs": 60000
            }"#,
        )
        .unwrap();

        let config = load_config_from(&path).unwrap();
        assert_eq!(config.server_url, "http://test:8080");
        assert_eq!(config.api_key, "my-key");
        assert_eq!(config.max_retries, 7);
        assert_eq!(config.initial_backoff_ms, 2000);
        assert_eq!(config.max_backoff_ms, 60000);

        // Save and reload
        let path2 = dir.path().join("config2.json");
        save_config_to(&config, &path2).unwrap();
        let reloaded = load_config_from(&path2).unwrap();
        assert_eq!(reloaded.max_retries, 7);
        assert_eq!(reloaded.initial_backoff_ms, 2000);
        assert_eq!(reloaded.max_backoff_ms, 60000);
    }
}
