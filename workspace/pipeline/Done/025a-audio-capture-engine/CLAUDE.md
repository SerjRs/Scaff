# CLAUDE.md — 025a Audio Capture Engine

## What You're Building

A Rust **library crate** (`capture`) that records mic + speaker audio via WASAPI (through `cpal`), mixes into stereo WAV chunks, and writes them to an outbox directory.

## Project Setup

1. Create the cargo workspace at `tools/cortex-audio/`:

```
tools/cortex-audio/
  Cargo.toml          # workspace
  capture/
    Cargo.toml
    src/lib.rs
    src/mixer.rs
    src/chunker.rs
    src/silence.rs
    src/config.rs
```

2. Workspace `Cargo.toml`:
```toml
[workspace]
members = ["capture"]
resolver = "2"
```

3. Capture crate dependencies:
```toml
[dependencies]
cpal = "0.15"
hound = "3.5"
thiserror = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[dev-dependencies]
tempfile = "3"
```

## Key Constraints

- **Rust only.** Do NOT install .NET, Python, or any other runtime.
- **No unsafe code** unless absolutely required for WASAPI interop (document why).
- **`cpal` for audio** — do NOT use raw Windows COM/WASAPI bindings directly.
- **`hound` for WAV** — don't write WAV headers manually.
- **All tests must pass with `cargo test`.**
- Work on branch `feat/025a-audio-capture-engine`.

## Implementation Order

1. `config.rs` — CaptureConfig struct with validation, serde deserialization
2. `mixer.rs` — stereo interleaving (two mono → one stereo), pure function, easy to test
3. `chunker.rs` — WAV chunk writer using `hound`, size-based rotation, file naming
4. `silence.rs` — RMS calculation, sliding window, timeout tracking
5. `lib.rs` — CaptureEngine that ties it all together with `cpal` streams

## Testing Strategy

- `mixer.rs` and `silence.rs` are pure logic — test with synthetic sample buffers
- `chunker.rs` — use `tempfile` for outbox directory, verify WAV files are valid
- `lib.rs` E2E — if no audio device available in CI, gate behind `#[cfg(feature = "integration")]`
- Run: `cargo test --manifest-path tools/cortex-audio/capture/Cargo.toml`

## Update STATE.md

After each milestone (config, mixer, chunker, silence, integration), update `STATE.md` with:
- Which files were created/modified
- Test results (`cargo test` output)
- Any blockers or decisions made

## Done Criteria

- `cargo build` succeeds with no warnings
- `cargo test` — all unit tests pass
- `cargo clippy` — no warnings
- Crate exposes `CaptureEngine`, `CaptureConfig`, `CaptureEvent` publicly
- README.md in `tools/cortex-audio/capture/` with usage example
