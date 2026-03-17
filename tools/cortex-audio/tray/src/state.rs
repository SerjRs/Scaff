use std::sync::mpsc;
use uuid::Uuid;

use capture::{CaptureEngine, CaptureError, CaptureEvent};

use crate::config::TrayConfig;

/// The possible states of the tray application.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppState {
    Stopped,
    Capturing,
    Error,
}

/// Manages the capture engine lifecycle and session state.
pub struct AppController {
    state: AppState,
    config: TrayConfig,
    session_id: Option<String>,
    engine: Option<CaptureEngine>,
    event_rx: Option<mpsc::Receiver<CaptureEvent>>,
}

impl AppController {
    pub fn new(config: TrayConfig) -> Self {
        Self {
            state: AppState::Stopped,
            config,
            session_id: None,
            engine: None,
            event_rx: None,
        }
    }

    pub fn state(&self) -> AppState {
        self.state
    }

    #[allow(dead_code)]
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// Generate a new UUID v4 session ID.
    pub fn new_session_id() -> String {
        Uuid::new_v4().to_string()
    }

    /// Start a new capture session. Returns error if already capturing.
    pub fn start(&mut self) -> Result<(), AppControllerError> {
        if self.state == AppState::Capturing {
            return Err(AppControllerError::AlreadyCapturing);
        }

        let session_id = Self::new_session_id();
        let capture_config = self.config.to_capture_config();

        let mut engine =
            CaptureEngine::new(capture_config).map_err(AppControllerError::Capture)?;

        let rx = engine
            .start(&session_id)
            .map_err(AppControllerError::Capture)?;

        self.engine = Some(engine);
        self.event_rx = Some(rx);
        self.session_id = Some(session_id);
        self.state = AppState::Capturing;

        log::info!(
            "Capture started — session {}",
            self.session_id.as_deref().unwrap_or("?")
        );
        Ok(())
    }

    /// Stop the current capture session. Returns error if not capturing.
    pub fn stop(&mut self) -> Result<(), AppControllerError> {
        if self.state != AppState::Capturing {
            return Err(AppControllerError::NotCapturing);
        }

        if let Some(ref mut engine) = self.engine {
            engine.stop().map_err(AppControllerError::Capture)?;
        }

        log::info!(
            "Capture stopped — session {}",
            self.session_id.as_deref().unwrap_or("?")
        );

        self.engine = None;
        self.event_rx = None;
        self.session_id = None;
        self.state = AppState::Stopped;
        Ok(())
    }

    /// Set the error state (e.g. when an async capture error is received).
    pub fn set_error(&mut self) {
        self.state = AppState::Error;
    }

    /// Drain pending capture events (non-blocking). Returns collected events.
    pub fn poll_events(&mut self) -> Vec<CaptureEvent> {
        let mut events = Vec::new();
        if let Some(ref rx) = self.event_rx {
            while let Ok(event) = rx.try_recv() {
                events.push(event);
            }
        }
        events
    }

    /// Update config (for settings changes).
    #[allow(dead_code)]
    pub fn update_config(&mut self, config: TrayConfig) {
        self.config = config;
    }
}

#[derive(Debug)]
pub enum AppControllerError {
    AlreadyCapturing,
    NotCapturing,
    Capture(CaptureError),
}

impl std::fmt::Display for AppControllerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyCapturing => write!(f, "Already capturing"),
            Self::NotCapturing => write!(f, "Not capturing"),
            Self::Capture(e) => write!(f, "Capture error: {e}"),
        }
    }
}

impl std::error::Error for AppControllerError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state_is_stopped() {
        let ctrl = AppController::new(TrayConfig::default());
        assert_eq!(ctrl.state(), AppState::Stopped);
        assert!(ctrl.session_id().is_none());
    }

    #[test]
    fn test_session_id_is_uuid_v4() {
        let id = AppController::new_session_id();
        let parsed = Uuid::parse_str(&id).expect("should be valid UUID");
        assert_eq!(parsed.get_version_num(), 4);
    }

    #[test]
    fn test_stop_without_start_errors() {
        let mut ctrl = AppController::new(TrayConfig::default());
        assert!(ctrl.stop().is_err());
    }

    #[test]
    fn test_set_error() {
        let mut ctrl = AppController::new(TrayConfig::default());
        ctrl.set_error();
        assert_eq!(ctrl.state(), AppState::Error);
    }

    #[test]
    fn test_poll_events_empty_when_stopped() {
        let mut ctrl = AppController::new(TrayConfig::default());
        let events = ctrl.poll_events();
        assert!(events.is_empty());
    }
}
