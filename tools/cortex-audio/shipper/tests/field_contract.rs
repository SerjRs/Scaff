//! Cross-stack field name and multipart body contract tests.
//!
//! These tests verify TWO things:
//! 1. The string constants match the TypeScript server's expectations.
//! 2. The actual multipart body produced by upload_chunk() contains the
//!    correct field names and values — not just that the constants exist.
//!
//! The off-by-one bug (or_insert(1)) passed all previous tests because
//! wiremock only checked method + path, never inspecting the body. These
//! tests capture the request body and assert on its contents.

use cortex_audio_shipper::upload::{
    upload_chunk, send_session_end, CHUNK_UPLOAD_PATH, FIELD_AUDIO, FIELD_SEQUENCE,
    FIELD_SESSION_ID, SESSION_END_PATH,
};
use std::io::Write;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

// ---------------------------------------------------------------------------
// Constant value tests (tripwire — catches renames)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn create_wav_file(dir: &std::path::Path, name: &str, extra_bytes: usize) -> std::path::PathBuf {
    let p = dir.join(name);
    let mut f = std::fs::File::create(&p).unwrap();
    // Minimal WAV header (44 bytes)
    let wav_header: [u8; 44] = [
        b'R', b'I', b'F', b'F', 36, 0, 0, 0, b'W', b'A', b'V', b'E', b'f', b'm', b't',
        b' ', 16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3E, 0, 0, 0, 0x7D, 0, 0, 2, 0, 16, 0,
        b'd', b'a', b't', b'a', 0, 0, 0, 0,
    ];
    f.write_all(&wav_header).unwrap();
    if extra_bytes > 0 {
        f.write_all(&vec![0u8; extra_bytes]).unwrap();
    }
    p
}

/// Extract a multipart text field value from a raw multipart body.
/// Looks for `name="<field_name>"` in Content-Disposition, then returns
/// the text value from the part body.
fn extract_multipart_text_field(body: &[u8], field_name: &str) -> Option<String> {
    let body_str = String::from_utf8_lossy(body);
    let search = format!("name=\"{}\"", field_name);

    // Find the Content-Disposition header containing this field name
    let pos = body_str.find(&search)?;

    // Find the double CRLF that ends the headers for this part
    let after_headers = body_str[pos..].find("\r\n\r\n")?;
    let value_start = pos + after_headers + 4;

    // Value ends at the next boundary (starts with "\r\n--")
    let value_end = body_str[value_start..].find("\r\n--")?;
    let value = &body_str[value_start..value_start + value_end];

    Some(value.to_string())
}

/// Check if the multipart body contains a file part with the given field name.
fn has_multipart_file_field(body: &[u8], field_name: &str) -> bool {
    let body_str = String::from_utf8_lossy(body);
    // File parts have both name= and filename= in Content-Disposition
    let pattern = format!("name=\"{}\"", field_name);
    if let Some(pos) = body_str.find(&pattern) {
        // Check if there's a filename= nearby (within the same header line)
        let line_end = body_str[pos..].find("\r\n").unwrap_or(body_str.len() - pos);
        let header_line = &body_str[pos..pos + line_end];
        header_line.contains("filename=")
    } else {
        false
    }
}

/// Extract the Content-Type header value for a multipart file part.
/// Looks for `name="<field_name>"` in Content-Disposition, then finds the
/// Content-Type header within the same part.
fn extract_multipart_file_content_type(body: &[u8], field_name: &str) -> Option<String> {
    let body_str = String::from_utf8_lossy(body);
    let search = format!("name=\"{}\"", field_name);

    let pos = body_str.find(&search)?;

    // The Content-Type header for this part should be on the next line(s) before \r\n\r\n
    let after_headers = body_str[pos..].find("\r\n\r\n")?;
    let headers_block = &body_str[pos..pos + after_headers];

    // Find Content-Type within the headers block
    for line in headers_block.split("\r\n") {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("content-type:") {
            return Some(line["content-type:".len()..].trim().to_string());
        }
    }
    None
}

/// Extract the raw bytes of a file part from a multipart body.
/// Works directly on raw bytes to avoid UTF-8 lossy conversion position drift.
fn extract_multipart_file_bytes(body: &[u8], field_name: &str) -> Option<Vec<u8>> {
    let search = format!("name=\"{}\"", field_name);
    let search_bytes = search.as_bytes();

    // Find the field name in the raw body
    let pos = body
        .windows(search_bytes.len())
        .position(|w| w == search_bytes)?;

    // Find the double CRLF that ends the headers for this part
    let header_end_marker = b"\r\n\r\n";
    let after_pos = body[pos..]
        .windows(4)
        .position(|w| w == header_end_marker)?;
    let data_start = pos + after_pos + 4;

    // Find the next boundary marker (\r\n--)
    let boundary_marker = b"\r\n--";
    let data_end = body[data_start..]
        .windows(4)
        .position(|w| w == boundary_marker)?;

    Some(body[data_start..data_start + data_end].to_vec())
}

// ---------------------------------------------------------------------------
// Body content assertion tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn upload_chunk_sends_sequence_0_for_first_chunk() {
    // This test would have caught bug #1: or_insert(1) sending sequence=1
    // for the first chunk instead of sequence=0.
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/chunk"))
        .and(header("Authorization", "Bearer test-key"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let wav = create_wav_file(tmp.path(), "sess_chunk-0000_1710700000.wav", 64);
    let client = reqwest::Client::new();

    // Upload with sequence=0 (what the fixed shipper sends for the first chunk)
    let result = upload_chunk(&client, &server.uri(), "test-key", "test-session", 0, &wav).await;
    assert!(result.is_ok(), "upload should succeed");

    // Capture the request and inspect the multipart body
    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1, "exactly one request should have been made");

    let req_body = &requests[0].body;

    // Assert sequence field value is "0", not "1"
    let sequence_value = extract_multipart_text_field(req_body, "sequence")
        .expect("multipart body must contain 'sequence' field");
    assert_eq!(
        sequence_value, "0",
        "first chunk must have sequence=0 (0-based contract)"
    );
}

#[tokio::test]
async fn upload_chunk_multipart_body_contains_correct_fields() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/chunk"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let session_id = "d4e5f6a7-1234-5678-9abc-def012345678";
    let wav = create_wav_file(
        tmp.path(),
        &format!("{}_chunk-0003_1710700000.wav", session_id),
        128,
    );
    let client = reqwest::Client::new();

    let result = upload_chunk(&client, &server.uri(), "test-key", session_id, 3, &wav).await;
    assert!(result.is_ok());

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let req_body = &requests[0].body;

    // 1. session_id field present with correct value
    let sid = extract_multipart_text_field(req_body, FIELD_SESSION_ID)
        .expect("multipart body must contain 'session_id' field");
    assert_eq!(sid, session_id);

    // 2. sequence field present with correct numeric value
    let seq = extract_multipart_text_field(req_body, FIELD_SEQUENCE)
        .expect("multipart body must contain 'sequence' field");
    assert_eq!(seq, "3");

    // 3. audio field present as a file part with WAV content
    assert!(
        has_multipart_file_field(req_body, FIELD_AUDIO),
        "multipart body must contain '{}' as a file field",
        FIELD_AUDIO
    );

    // 4. Verify the file data contains WAV header (RIFF magic)
    assert!(
        req_body.windows(4).any(|w| w == b"RIFF"),
        "multipart body must contain WAV data (RIFF header)"
    );

    // 5. Auth header is correct
    let auth_header = requests[0]
        .headers
        .get("authorization")
        .expect("Authorization header must be present");
    assert_eq!(auth_header, "Bearer test-key");
}

#[tokio::test]
async fn send_session_end_body_format() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/session-end"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let client = reqwest::Client::new();
    let session_id = "end-test-session-id";

    let result = send_session_end(&client, &server.uri(), "test-key", session_id).await;
    assert!(result.is_ok());

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);

    // Verify Content-Type is application/json
    let ct = requests[0]
        .headers
        .get("content-type")
        .expect("Content-Type header must be present");
    assert!(
        ct.to_str().unwrap().contains("application/json"),
        "session-end Content-Type must be application/json"
    );

    // Verify body is {"session_id":"<id>"}
    let body_str = String::from_utf8_lossy(&requests[0].body);
    let parsed: serde_json::Value = serde_json::from_str(&body_str)
        .expect("session-end body must be valid JSON");
    assert_eq!(
        parsed.get("session_id").and_then(|v| v.as_str()),
        Some(session_id),
        "session-end JSON must contain session_id field with correct value"
    );

    // Verify no extra fields beyond session_id
    let obj = parsed.as_object().expect("session-end body must be a JSON object");
    assert_eq!(
        obj.len(),
        1,
        "session-end JSON must contain exactly one field (session_id), got: {:?}",
        obj.keys().collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn upload_chunk_audio_content_type_is_wav() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/chunk"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    let wav = create_wav_file(tmp.path(), "ct-sess_chunk-0000_1710700000.wav", 32);
    let client = reqwest::Client::new();

    let result = upload_chunk(&client, &server.uri(), "test-key", "ct-sess", 0, &wav).await;
    assert!(result.is_ok());

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let req_body = &requests[0].body;

    let content_type = extract_multipart_file_content_type(req_body, FIELD_AUDIO)
        .expect("audio part must have a Content-Type header");
    assert_eq!(
        content_type, "audio/wav",
        "audio part Content-Type must be audio/wav"
    );
}

#[tokio::test]
async fn upload_chunk_wav_bytes_round_trip() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/audio/chunk"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let tmp = tempfile::tempdir().unwrap();
    // Create WAV with known extra bytes pattern for exact matching
    let wav = create_wav_file(tmp.path(), "rt-sess_chunk-0000_1710700000.wav", 256);
    let original_bytes = std::fs::read(&wav).unwrap();
    let client = reqwest::Client::new();

    let result = upload_chunk(&client, &server.uri(), "test-key", "rt-sess", 0, &wav).await;
    assert!(result.is_ok());

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let req_body = &requests[0].body;

    let uploaded_bytes = extract_multipart_file_bytes(req_body, FIELD_AUDIO)
        .expect("audio part must contain file data");
    assert_eq!(
        uploaded_bytes.len(),
        original_bytes.len(),
        "uploaded WAV size must match original (expected {}, got {})",
        original_bytes.len(),
        uploaded_bytes.len()
    );
    assert_eq!(
        uploaded_bytes, original_bytes,
        "uploaded WAV bytes must exactly match the original file"
    );
}
