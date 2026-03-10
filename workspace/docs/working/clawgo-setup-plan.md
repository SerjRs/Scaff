# ClawGo Setup — Implementation Plan

*Created: 2026-03-10*
*Ref: https://github.com/openclaw/clawgo*
*Status: Not Started*

---

## What Is ClawGo

ClawGo is a minimal headless node client written in Go. It runs on a Raspberry Pi (or any Linux device), connects to the OpenClaw gateway bridge, and acts as a peripheral node. It can:

- Stream voice transcripts (STT → gateway → Scaff → response)
- Speak responses via local TTS (espeak-ng, piper, or ElevenLabs)
- Act as a paired node (camera, run commands, screen capture via `nodes` tool)
- Deliver responses to WhatsApp/Telegram/Signal from the Pi
- Run as a systemd service (always-on)

**In our architecture:** ClawGo becomes another channel/peripheral for Cortex — messages from the Pi arrive at the gateway the same way WhatsApp messages do. Scaff can also use the `nodes` tool to run commands, take photos, etc. on the Pi remotely.

---

## Prerequisites

| Item | Status | Notes |
|------|--------|-------|
| Raspberry Pi (arm64) | ✅ Have | Serj's existing Pi |
| Pi on same network or Tailscale | ❓ Check | Gateway bridge needs to be reachable |
| Go installed (for cross-compilation) | ❓ Check | Need Go on DianaE or Pi |
| Gateway bridge enabled | ❌ Not configured | `bridge` section missing from openclaw.json |
| Pi has SSH access | ❓ Check | Needed for deployment |

---

## Phase 1: Gateway Bridge Configuration

**Goal:** Enable the bridge on DianaE so the Pi can connect.

### Steps

**1.1 — Check if bridge is already running**
```powershell
# On DianaE
netstat -an | findstr "18790"
```
Bridge listens on port 18790 by default.

**1.2 — Enable bridge in openclaw.json**
Add bridge config if not present:
```json
{
  "bridge": {
    "enabled": true,
    "port": 18790,
    "bind": "0.0.0.0"
  }
}
```

If using Tailscale, restrict to Tailscale interface:
```json
{
  "bridge": {
    "enabled": true,
    "port": 18790,
    "bind": "tailnet"
  }
}
```

**1.3 — Restart gateway**
```powershell
# Kill and restart
Start-Process powershell -ArgumentList "-Command", "Set-Location '$env:USERPROFILE\.openclaw'; pnpm openclaw gateway" -WindowStyle Normal
```

**1.4 — Verify bridge is listening**
```powershell
netstat -an | findstr "18790"
```

### Gate
Bridge is listening on port 18790. Reachable from the Pi's network.

---

## Phase 2: Build ClawGo Binary

**Goal:** Cross-compile the ClawGo binary for the Pi (linux/arm64).

### Steps

**2.1 — Clone the repo**
```powershell
cd $env:USERPROFILE
git clone https://github.com/openclaw/clawgo.git
cd clawgo
```

**2.2 — Install Go (if not available)**
```powershell
# Check
go version

# If missing, install via winget or download from https://go.dev/dl/
winget install GoLang.Go
```

**2.3 — Cross-compile for Pi**
```powershell
$env:GOOS = "linux"
$env:GOARCH = "arm64"
go build -o clawgo-linux-arm64 ./cmd/clawgo
```

**2.4 — Verify binary**
```powershell
file clawgo-linux-arm64  # Should show: ELF 64-bit LSB, ARM aarch64
```

### Alternative: Build on the Pi directly
```bash
# On the Pi (if Go is installed)
git clone https://github.com/openclaw/clawgo.git
cd clawgo
go build -o clawgo ./cmd/clawgo
```

### Gate
Binary `clawgo-linux-arm64` exists and is a valid ARM64 Linux ELF.

---

## Phase 3: Deploy to Pi

**Goal:** Get the binary onto the Pi and prepare the filesystem.

### Steps

**3.1 — Copy binary to Pi**
```powershell
# From DianaE (replace PI_IP with actual IP)
scp clawgo-linux-arm64 pi@PI_IP:/home/pi/clawgo
```

**3.2 — Make executable**
```bash
# On the Pi
chmod +x /home/pi/clawgo
```

**3.3 — Create state directory**
```bash
mkdir -p /home/pi/.clawdbot
```

**3.4 — Install TTS engine (optional)**
```bash
# espeak-ng (lightweight, robotic voice)
sudo apt install espeak-ng

# OR piper (better quality, offline neural TTS)
# See: https://github.com/rhasspy/piper
pip install piper-tts
```

**3.5 — Create FIFO for voice input (optional)**
```bash
mkdir -p /home/pi/.cache/clawdbot
mkfifo /home/pi/.cache/clawdbot/voice.fifo
```

### Gate
Binary is on the Pi, executable, state directory exists.

---

## Phase 4: Pair the Node

**Goal:** Establish trust between the Pi and the gateway.

### Steps

**4.1 — Find DianaE's IP**
```powershell
# On DianaE — get the IP reachable from the Pi
ipconfig | findstr "IPv4"

# Or if using Tailscale
tailscale ip
```

**4.2 — Initiate pairing from the Pi**
```bash
./clawgo pair \
  -bridge DIANA_IP:18790 \
  -display-name "Serj Pi"
```
This prints a `requestId`.

**4.3 — Approve pairing from Scaff**
I can do this via the `nodes` tool:
```
nodes approve <requestId>
```

Or via CLI:
```powershell
node dist/entry.js nodes approve <requestId>
```

**4.4 — Verify pairing**
```bash
# On Pi — check state file
cat /home/pi/.clawdbot/clawgo.json
# Should have nodeId and token
```

From Scaff:
```
nodes status
# Should show "Serj Pi" as a paired node
```

### Gate
Node shows as paired in `nodes status`. State file exists on Pi with credentials.

---

## Phase 5: Run ClawGo

**Goal:** Start the node client and verify bidirectional communication.

### Steps

**5.1 — Test run (foreground)**
```bash
./clawgo run \
  -bridge DIANA_IP:18790 \
  -chat-subscribe \
  -tts-engine system
```

**5.2 — Test voice input via FIFO**
```bash
# Terminal 1: run clawgo with stdin from FIFO
tail -f /home/pi/.cache/clawdbot/voice.fifo | ./clawgo run \
  -bridge DIANA_IP:18790 \
  -stdin \
  -chat-subscribe \
  -tts-engine system

# Terminal 2: send a test message
printf "What time is it?\n" > /home/pi/.cache/clawdbot/voice.fifo
```

**5.3 — Test from Scaff**
Use the `nodes` tool to verify the Pi is reachable:
```
nodes run --node "Serj Pi" --command ["uname", "-a"]
nodes camera_snap --node "Serj Pi"
```

**5.4 — Test with WhatsApp delivery**
```bash
./clawgo run \
  -bridge DIANA_IP:18790 \
  -stdin \
  -chat-subscribe \
  -deliver \
  -deliver-channel whatsapp \
  -deliver-to +40751845717 \
  -tts-engine system
```
Voice transcripts from the Pi get processed and responses delivered to WhatsApp.

### Gate
Bidirectional communication works. Pi speaks responses. Scaff can run commands on the Pi.

---

## Phase 6: Systemd Service (Always-On)

**Goal:** ClawGo starts on boot and runs 24/7.

### Steps

**6.1 — Create wrapper script**
```bash
cat > /home/pi/clawgo-run.sh << 'EOF'
#!/bin/bash
FIFO=/home/pi/.cache/clawdbot/voice.fifo
mkdir -p "$(dirname "$FIFO")"
[ -p "$FIFO" ] || mkfifo "$FIFO"

# Keep FIFO open and pipe to clawgo
tail -f "$FIFO" | /home/pi/clawgo run \
  -bridge DIANA_IP:18790 \
  -stdin \
  -chat-subscribe \
  -tts-engine system
EOF
chmod +x /home/pi/clawgo-run.sh
```

**6.2 — Create systemd service**
```bash
sudo cat > /etc/systemd/system/clawgo.service << 'EOF'
[Unit]
Description=ClawGo - OpenClaw Node Client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
ExecStart=/home/pi/clawgo-run.sh
Restart=always
RestartSec=10
Environment=HOME=/home/pi

[Install]
WantedBy=multi-user.target
EOF
```

**6.3 — Enable and start**
```bash
sudo systemctl daemon-reload
sudo systemctl enable clawgo
sudo systemctl start clawgo
sudo systemctl status clawgo
```

**6.4 — Verify persistence**
```bash
# Reboot and check
sudo reboot
# After reboot:
sudo systemctl status clawgo
```

### Gate
ClawGo survives reboot. Node shows up in `nodes status` after Pi restarts.

---

## Phase 7: STT Integration (Optional)

**Goal:** Add real speech-to-text so the Pi listens via microphone.

### Options

**A. Whisper (local, offline)**
```bash
# Install whisper.cpp
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp && make
# Download small model
bash models/download-ggml-model.sh small

# Stream microphone → whisper → FIFO
arecord -f S16_LE -r 16000 -c 1 | \
  ./stream -m models/ggml-small.bin --step 3000 --length 10000 | \
  grep -oP '(?<=\] ).*' > /home/pi/.cache/clawdbot/voice.fifo
```

**B. Cloud STT (Google/Deepgram)**
Lower Pi CPU usage but requires internet and API key.

### Gate
Speaking near the Pi triggers Scaff responses via TTS. Full voice loop working.

---

## Architecture Fit

```
                    ┌─────────────────────────┐
                    │       CORTEX/SCAFF       │
                    │    (DianaE, Windows)      │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────┼─────────────┐
                    │      Gateway + Bridge     │
                    │    :18789 (API)           │
                    │    :18790 (Bridge)        │
                    └────────────┬─────────────┘
                                 │
          ┌──────────┬───────────┼───────────┐
          │          │           │           │
     ┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────┐
     │WhatsApp│ │Webchat │ │ ClawGo │ │ Future │
     │  I/O   │ │  I/O   │ │  (Pi)  │ │Channels│
     └────────┘ └────────┘ └────────┘ └────────┘
                            │
                       ┌────▼────┐
                       │ Raspi   │
                       │ Mic+Spk │
                       │ Camera  │
                       │ GPIO    │
                       └─────────┘
```

ClawGo on the Pi is just another peripheral — same as WhatsApp or webchat. Messages flow through the bridge into the gateway, Cortex sees them in the unified session. Scaff can use `nodes run/camera_snap/screen_record` to interact with the Pi hardware.

---

## Estimated Effort

| Phase | Time | Blocking? |
|-------|------|-----------|
| Phase 1: Bridge config | 10 min | Yes |
| Phase 2: Build binary | 15 min | Yes |
| Phase 3: Deploy to Pi | 10 min | Yes |
| Phase 4: Pair | 5 min | Yes |
| Phase 5: Test run | 15 min | Yes |
| Phase 6: Systemd | 10 min | No |
| Phase 7: STT | 1-2 hours | No |

Phases 1-5 can be done in one sitting (~1 hour). Phase 7 (voice) is the optional deep end.

---

## Open Questions

- **Network topology:** Is the Pi on the same LAN as DianaE, or do we need Tailscale? Bridge bind address depends on this.
- **Pi model:** Which Pi? (3B+, 4, 5) Affects available RAM for whisper models and TTS quality.
- **Voice vs text:** Do we want voice (STT+TTS) or just text commands via FIFO/SSH? Voice requires microphone + speaker hardware.
- **Camera use case:** The Pi camera could be used for visual context (photo capture via `nodes camera_snap`). Worth setting up if the Pi has a camera module.
- **GPIO / home automation:** ClawGo supports quick actions. If the Pi controls lights/sensors, we could wire those as node capabilities.
