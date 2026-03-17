use reqwest::multipart;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum UploadError {
    #[error("HTTP request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("Server returned {status}: {body}")]
    ServerError { status: u16, body: String },
    #[error("IO error reading chunk: {0}")]
    Io(#[from] std::io::Error),
}

/// Upload a WAV chunk to the server's audio ingest API.
pub async fn upload_chunk(
    client: &reqwest::Client,
    server_url: &str,
    api_key: &str,
    session_id: &str,
    sequence: u32,
    chunk_path: &Path,
) -> Result<(), UploadError> {
    let data = tokio::fs::read(chunk_path).await?;
    let file_name = chunk_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    let form = multipart::Form::new()
        .text("session_id", session_id.to_string())
        .text("sequence", sequence.to_string())
        .part(
            "audio",
            multipart::Part::bytes(data)
                .file_name(file_name)
                .mime_str("audio/wav")
                .expect("valid mime"),
        );

    let resp = client
        .post(format!("{}/audio/chunk", server_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await?;

    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(UploadError::ServerError {
            status: status.as_u16(),
            body,
        })
    }
}

/// Signal session end to the server.
pub async fn send_session_end(
    client: &reqwest::Client,
    server_url: &str,
    api_key: &str,
    session_id: &str,
) -> Result<(), UploadError> {
    let resp = client
        .post(format!("{}/audio/session-end", server_url))
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .body(format!(r#"{{"session_id":"{}"}}"#, session_id))
        .send()
        .await?;

    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(UploadError::ServerError {
            status: status.as_u16(),
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn create_wav_file(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        // Minimal WAV header (44 bytes) + a few samples
        let header: [u8; 44] = [
            b'R', b'I', b'F', b'F', 36, 0, 0, 0, b'W', b'A', b'V', b'E', b'f', b'm', b't',
            b' ', 16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3E, 0, 0, 0, 0x7D, 0, 0, 2, 0, 16, 0,
            b'd', b'a', b't', b'a', 0, 0, 0, 0,
        ];
        f.write_all(&header).unwrap();
        p
    }

    #[tokio::test]
    async fn upload_chunk_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/chunk"))
            .and(header("Authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let wav = create_wav_file(tmp.path(), "chunk_001.wav");
        let client = reqwest::Client::new();

        let result = upload_chunk(&client, &server.uri(), "test-key", "sess-1", 1, &wav).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn upload_chunk_server_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/chunk"))
            .respond_with(ResponseTemplate::new(500).set_body_string("internal error"))
            .mount(&server)
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let wav = create_wav_file(tmp.path(), "chunk_001.wav");
        let client = reqwest::Client::new();

        let result = upload_chunk(&client, &server.uri(), "test-key", "sess-1", 1, &wav).await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        match err {
            UploadError::ServerError { status, body } => {
                assert_eq!(status, 500);
                assert_eq!(body, "internal error");
            }
            _ => panic!("expected ServerError"),
        }
    }

    #[tokio::test]
    async fn session_end_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/audio/session-end"))
            .and(header("Authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;

        let client = reqwest::Client::new();
        let result = send_session_end(&client, &server.uri(), "test-key", "sess-1").await;
        assert!(result.is_ok());
    }
}
