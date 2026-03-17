mod config;
mod state;

use config::{load_config, save_config, TrayConfig};
use state::{AppController, AppState};

use muda::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::{Icon as TrayIconIcon, TrayIcon, TrayIconBuilder, TrayIconEvent};

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

fn main() {
    let log_path = std::env::current_exe().ok()
        .and_then(|p| p.parent().map(|d| d.join("cortex-audio.log")))
        .unwrap_or_else(|| std::path::PathBuf::from("cortex-audio.log"));
    let log_file = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok();
    let tee = TeeWriter { stdout: std::io::stdout(), file: log_file };
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("debug"))
        .target(env_logger::Target::Pipe(Box::new(tee)))
        .init();
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
                handle_stop(&mut controller, &tray_icon, &mi_start, &mi_stop);
            } else if event.id == quit_id {
                // Clean shutdown
                if controller.state() == AppState::Capturing {
                    let _ = controller.stop();
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
