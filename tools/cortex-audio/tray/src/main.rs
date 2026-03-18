mod config;
mod state;

use config::{load_config, save_config, TrayConfig};
use state::{AppController, AppState};

use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::{Icon as TrayIconIcon, TrayIcon, TrayIconBuilder, TrayIconEvent};

use shipper::{ChunkShipper, ShipperEvent};
use std::sync::mpsc as std_mpsc;

/// Create a solid-color 16×16 RGBA icon.
fn make_icon(r: u8, g: u8, b: u8) -> TrayIconIcon {
    let size = 16u32;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for _ in 0..(size * size) {
        rgba.push(r);
        rgba.push(g);
        rgba.push(b);
        rgba.push(255); // alpha
    }
    TrayIconIcon::from_rgba(rgba, size, size).expect("failed to create icon")
}

fn icon_for_state(state: AppState) -> TrayIconIcon {
    match state {
        AppState::Stopped => make_icon(220, 50, 50),   // red
        AppState::Capturing => make_icon(50, 200, 50),  // green
        AppState::Error => make_icon(230, 200, 50),     // yellow
    }
}

/// Writes log output to both stdout and a log file side-by-side.
struct TeeWriter {
    stdout: std::io::Stdout,
    file: Option<std::fs::File>,
}
impl std::io::Write for TeeWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = self.stdout.write(buf);
        if let Some(ref mut f) = self.file { let _ = f.write(buf); }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        let _ = self.stdout.flush();
        if let Some(ref mut f) = self.file { let _ = f.flush(); }
        Ok(())
    }
}

/// Holds the shipper handle and the tokio runtime for async bridging.
struct ShipperBridge {
    runtime: tokio::runtime::Runtime,
    /// Channel to send stop signal to the shipper task
    stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    /// Receiver for shipper events (bridged from tokio mpsc to std mpsc)
    event_rx: std_mpsc::Receiver<ShipperEvent>,
    /// Shipper config (needed for session-end calls)
    shipper_config: shipper::ShipperConfig,
}

impl ShipperBridge {
    fn new(tray_config: &TrayConfig) -> Result<Self, String> {
        let shipper_config = tray_config.to_shipper_config();

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| format!("Failed to create tokio runtime: {e}"))?;

        let (event_tx, event_rx) = std_mpsc::channel::<ShipperEvent>();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();

        let cfg = shipper_config.clone();
        runtime.spawn(async move {
            let mut shipper = match ChunkShipper::new(cfg) {
                Ok(s) => s,
                Err(e) => {
                    log::error!("Failed to create shipper: {e}");
                    return;
                }
            };

            let mut events = match shipper.start().await {
                Ok(rx) => rx,
                Err(e) => {
                    log::error!("Failed to start shipper: {e}");
                    return;
                }
            };

            log::info!("Shipper started, watching outbox for chunks");

            // Forward shipper events to std_mpsc until stop signal
            tokio::select! {
                _ = async {
                    while let Some(ev) = events.recv().await {
                        if event_tx.send(ev).is_err() {
                            break;
                        }
                    }
                } => {}
                _ = stop_rx => {
                    log::info!("Shipper bridge received stop signal");
                }
            }

            let _ = shipper.stop().await;
            log::info!("Shipper stopped");
        });

        Ok(Self {
            runtime,
            stop_tx: Some(stop_tx),
            event_rx,
            shipper_config,
        })
    }

    /// Drain pending uploads for a session, then send session-end (async, fire-and-forget).
    fn drain_and_end(&self, session_id: String, timeout: std::time::Duration) {
        let cfg = self.shipper_config.clone();
        self.runtime.spawn(async move {
            let start = std::time::Instant::now();
            let poll_interval = std::time::Duration::from_millis(250);

            loop {
                let pending = shipper::watcher::pending_for_session(&cfg.outbox_dir, &session_id);
                if pending == 0 {
                    break;
                }
                if start.elapsed() >= timeout {
                    log::warn!("Drain timed out for {session_id} with {pending} pending chunks");
                    break;
                }
                tokio::time::sleep(poll_interval).await;
            }

            let client = reqwest::Client::new();
            match shipper::upload::send_session_end(
                &client,
                &cfg.server_url,
                &cfg.api_key,
                &session_id,
            )
            .await
            {
                Ok(()) => log::info!("Session-end sent for {session_id} after drain"),
                Err(e) => log::error!("Failed to send session-end for {session_id}: {e}"),
            }
        });
    }

    /// Drain pending uploads then send session-end, blocking until complete.
    /// Used for quit/shutdown paths where we must finish before exiting.
    fn drain_and_end_blocking(&self, session_id: &str, timeout: std::time::Duration) {
        let cfg = self.shipper_config.clone();
        let sid = session_id.to_string();
        self.runtime.block_on(async move {
            let start = std::time::Instant::now();
            let poll_interval = std::time::Duration::from_millis(250);

            loop {
                let pending = shipper::watcher::pending_for_session(&cfg.outbox_dir, &sid);
                if pending == 0 {
                    break;
                }
                if start.elapsed() >= timeout {
                    log::warn!("Drain timed out for {sid} with {pending} pending chunks");
                    break;
                }
                tokio::time::sleep(poll_interval).await;
            }

            let client = reqwest::Client::new();
            match shipper::upload::send_session_end(
                &client,
                &cfg.server_url,
                &cfg.api_key,
                &sid,
            )
            .await
            {
                Ok(()) => log::info!("Session-end sent for {sid} after drain (blocking)"),
                Err(e) => log::error!("Failed to send session-end for {sid}: {e}"),
            }
        });
    }

    /// Poll shipper events (non-blocking).
    fn poll_events(&self) -> Vec<ShipperEvent> {
        let mut events = Vec::new();
        while let Ok(ev) = self.event_rx.try_recv() {
            events.push(ev);
        }
        events
    }

    /// Stop the shipper and shutdown the runtime.
    fn shutdown(mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        // Give the shipper a moment to finish
        self.runtime.shutdown_timeout(std::time::Duration::from_secs(5));
    }
}

fn main() {
    let log_path = std::env::current_exe().ok()
        .and_then(|p| p.parent().map(|d| d.join("cortex-audio.log")))
        .unwrap_or_else(|| std::path::PathBuf::from("cortex-audio.log"));
    let log_file = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok();
    let tee = TeeWriter { stdout: std::io::stdout(), file: log_file };
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("debug"))
        .target(env_logger::Target::Pipe(Box::new(tee)))
        .init();
    let version = env!("CARGO_PKG_VERSION");
    let build_ts = env!("BUILD_TIMESTAMP");
    println!("cortex-audio v{version} (built {build_ts})");
    log::info!("cortex-audio v{version} (built {build_ts})");
    log::info!("Log file: {}", log_path.display());

    // Load or create default config
    let tray_config = match load_config() {
        Ok(c) => {
            log::info!("Config loaded from {}", config::config_path().display());
            c
        }
        Err(e) => {
            log::warn!("Failed to load config ({e}), using defaults");
            let defaults = TrayConfig::default();
            let _ = save_config(&defaults);
            defaults
        }
    };

    // Ensure outbox dir exists
    if let Err(e) = std::fs::create_dir_all(&tray_config.outbox_dir) {
        log::error!("Cannot create outbox dir: {e}");
    }

    // Start the shipper bridge (tokio runtime + shipper in background)
    let shipper_bridge = match ShipperBridge::new(&tray_config) {
        Ok(b) => {
            log::info!("Shipper bridge started");
            Some(b)
        }
        Err(e) => {
            log::error!("Failed to start shipper bridge: {e}");
            None
        }
    };
    // Wrap in Option for move into closure (need to take ownership on quit)
    let mut shipper_bridge = shipper_bridge;

    let mut controller = AppController::new(tray_config);

    // Build context menu
    let menu = Menu::new();
    let mi_start = MenuItem::new("Start Capture", true, None);
    let mi_stop = MenuItem::new("Stop Capture", false, None);
    let mi_separator = PredefinedMenuItem::separator();
    let mi_quit = MenuItem::new("Quit", true, None);
    menu.append(&mi_start).unwrap();
    menu.append(&mi_stop).unwrap();
    menu.append(&mi_separator).unwrap();
    menu.append(&mi_quit).unwrap();

    let start_id = mi_start.id().clone();
    let stop_id = mi_stop.id().clone();
    let quit_id = mi_quit.id().clone();

    // Build event loop (tao)
    let event_loop = EventLoopBuilder::new().build();

    // Create tray icon
    let tray_icon = TrayIconBuilder::new()
        .with_icon(icon_for_state(AppState::Stopped))
        .with_tooltip("CortexAudio — Stopped")
        .with_menu(Box::new(menu))
        .build()
        .expect("failed to create tray icon");

    let menu_channel = MenuEvent::receiver();
    let _tray_channel = TrayIconEvent::receiver();

    log::info!("CortexAudio tray app started");

    event_loop.run(move |event, _, control_flow| {
        // Poll so we can check capture events regularly
        *control_flow = ControlFlow::WaitUntil(
            std::time::Instant::now() + std::time::Duration::from_millis(250),
        );

        // Handle menu events
        if let Ok(event) = menu_channel.try_recv() {
            if event.id == start_id {
                handle_start(&mut controller, &tray_icon, &mi_start, &mi_stop);
            } else if event.id == stop_id {
                let sid = controller.session_id().map(|s| s.to_string());
                handle_stop(&mut controller, &tray_icon, &mi_start, &mi_stop);
                if let Some(sid) = sid {
                    if let Some(ref bridge) = shipper_bridge {
                        bridge.drain_and_end(sid, std::time::Duration::from_secs(30));
                    }
                }
            } else if event.id == quit_id {
                // Clean shutdown: stop capture, drain uploads, send session-end, stop shipper
                if controller.state() == AppState::Capturing {
                    let sid = controller.session_id().map(|s| s.to_string());
                    let _ = controller.stop();
                    if let Some(sid) = sid {
                        if let Some(ref bridge) = shipper_bridge {
                            bridge.drain_and_end_blocking(&sid, std::time::Duration::from_secs(5));
                        }
                    }
                }
                // Shutdown shipper bridge
                if let Some(bridge) = shipper_bridge.take() {
                    bridge.shutdown();
                }
                log::info!("Quitting");
                *control_flow = ControlFlow::Exit;
            }
        }

        // Poll capture events
        if controller.state() == AppState::Capturing {
            let events = controller.poll_events();
            for ev in events {
                match ev {
                    capture::CaptureEvent::ChunkReady { path, sequence } => {
                        log::info!("Chunk #{sequence} ready: {}", path.display());
                    }
                    capture::CaptureEvent::SessionEnd { session_id, chunks } => {
                        log::info!("Session {session_id} ended — {chunks} chunks");
                        // Drain uploads then send session-end (skip if zero chunks)
                        if chunks > 0 {
                            if let Some(ref bridge) = shipper_bridge {
                                bridge.drain_and_end(session_id, std::time::Duration::from_secs(30));
                            }
                        }
                        // Engine stopped itself (e.g. silence timeout)
                        handle_stop(&mut controller, &tray_icon, &mi_start, &mi_stop);
                    }
                    capture::CaptureEvent::Error(msg) => {
                        log::error!("Capture error: {msg}");
                        controller.set_error();
                        update_ui(&controller, &tray_icon, &mi_start, &mi_stop);
                    }
                }
            }
        }

        // Poll shipper events
        if let Some(ref bridge) = shipper_bridge {
            for ev in bridge.poll_events() {
                match ev {
                    ShipperEvent::ChunkUploaded { path, sequence } => {
                        log::info!("Chunk #{sequence} uploaded: {}", path.display());
                    }
                    ShipperEvent::ChunkFailed { path, error, retries } => {
                        log::warn!(
                            "Chunk upload failed after {retries} retries: {} — {error}",
                            path.display()
                        );
                    }
                    ShipperEvent::SessionEndSent { session_id } => {
                        log::info!("Session-end confirmed for {session_id}");
                    }
                }
            }
        }

        if let Event::NewEvents(StartCause::Init) = event {
            // Already set up above
        }
    });
}

fn handle_start(
    controller: &mut AppController,
    tray_icon: &TrayIcon,
    mi_start: &MenuItem,
    mi_stop: &MenuItem,
) {
    match controller.start() {
        Ok(()) => {
            log::info!("Capture started");
            update_ui(controller, tray_icon, mi_start, mi_stop);
        }
        Err(e) => {
            log::error!("Failed to start capture: {e:#}");
            controller.set_error();
            update_ui(controller, tray_icon, mi_start, mi_stop);
        }
    }
}

fn handle_stop(
    controller: &mut AppController,
    tray_icon: &TrayIcon,
    mi_start: &MenuItem,
    mi_stop: &MenuItem,
) {
    match controller.stop() {
        Ok(()) => {
            log::info!("Capture stopped");
        }
        Err(e) => {
            log::warn!("Stop issue: {e}");
        }
    }
    update_ui(controller, tray_icon, mi_start, mi_stop);
}

fn update_ui(
    controller: &AppController,
    tray_icon: &TrayIcon,
    mi_start: &MenuItem,
    mi_stop: &MenuItem,
) {
    let st = controller.state();
    let _ = tray_icon.set_icon(Some(icon_for_state(st)));

    let tooltip = match st {
        AppState::Stopped => "CortexAudio — Stopped",
        AppState::Capturing => "CortexAudio — Capturing",
        AppState::Error => "CortexAudio — Error",
    };
    let _ = tray_icon.set_tooltip(Some(tooltip));

    match st {
        AppState::Capturing => {
            mi_start.set_enabled(false);
            mi_stop.set_enabled(true);
        }
        _ => {
            mi_start.set_enabled(true);
            mi_stop.set_enabled(false);
        }
    }
}
