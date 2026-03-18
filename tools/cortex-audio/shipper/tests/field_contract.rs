//! Cross-stack field name contract test.
//!
//! These assertions lock the multipart field names and URL paths that the
//! TypeScript ingest server expects. If someone renames a constant on the
//! Rust side, this test forces them to update the cross-stack test in
//! `src/audio/__tests__/cross-stack.test.ts` as well.

use cortex_audio_shipper::upload::{
    CHUNK_UPLOAD_PATH, FIELD_AUDIO, FIELD_SEQUENCE, FIELD_SESSION_ID, SESSION_END_PATH,
};

#[test]
fn field_names_match_server_contract() {
    assert_eq!(FIELD_SESSION_ID, "session_id");
    assert_eq!(FIELD_SEQUENCE, "sequence");
    assert_eq!(FIELD_AUDIO, "audio");
}

#[test]
fn url_paths_match_server_contract() {
    assert_eq!(CHUNK_UPLOAD_PATH, "/audio/chunk");
    assert_eq!(SESSION_END_PATH, "/audio/session-end");
}
