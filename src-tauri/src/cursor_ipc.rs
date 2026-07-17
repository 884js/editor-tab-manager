use crate::editor_model::EditorSession;
use serde_json::Value;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

const REGULAR_MESSAGE: u8 = 1;
const RESPONSE_INITIALIZE: i64 = 200;
const RESPONSE_SUCCESS: i64 = 201;
const RESPONSE_ERROR: i64 = 202;
const RESPONSE_ERROR_OBJECT: i64 = 203;
const SOCKET_TIMEOUT: Duration = Duration::from_millis(750);

pub fn discover_sessions() -> Result<Vec<EditorSession>, String> {
    let mut last_error = None;
    for socket_path in cursor_socket_candidates()? {
        match read_sessions_from_socket(&socket_path) {
            Ok(sessions) => return Ok(sessions),
            Err(error) => last_error = Some(format!("{}: {}", socket_path.display(), error)),
        }
    }

    Err(last_error.unwrap_or_else(|| "Cursor main socket was not found".to_string()))
}

fn cursor_socket_candidates() -> Result<Vec<PathBuf>, String> {
    let data_dir = dirs::home_dir()
        .ok_or_else(|| "Home directory was not found".to_string())?
        .join("Library/Application Support/Cursor");
    let entries = fs::read_dir(data_dir).map_err(|error| error.to_string())?;
    let mut sockets = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            name.ends_with("-main.sock").then_some(path)
        })
        .collect::<Vec<_>>();

    sockets.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    sockets.reverse();
    Ok(sockets)
}

fn read_sessions_from_socket(socket_path: &Path) -> Result<Vec<EditorSession>, String> {
    let mut stream = UnixStream::connect(socket_path).map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(SOCKET_TIMEOUT))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(SOCKET_TIMEOUT))
        .map_err(|error| error.to_string())?;

    write_regular_message(&mut stream, 1, &encode_string("main"))
        .map_err(|error| error.to_string())?;

    loop {
        let payload = read_regular_message(&mut stream).map_err(|error| error.to_string())?;
        let (header, _) = decode_message(&payload).map_err(|error| error.to_string())?;
        if header.first().and_then(Value::as_i64) == Some(RESPONSE_INITIALIZE) {
            break;
        }
    }

    let mut request = encode_array(&[
        EncodedValue::Int(100),
        EncodedValue::Int(0),
        EncodedValue::String("diagnostics"),
        EncodedValue::String("getMainDiagnostics"),
    ]);
    request.extend(encode_array(&[]));
    write_regular_message(&mut stream, 2, &request).map_err(|error| error.to_string())?;

    loop {
        let payload = read_regular_message(&mut stream).map_err(|error| error.to_string())?;
        let (header, body) = decode_message(&payload).map_err(|error| error.to_string())?;
        let response_type = header.first().and_then(Value::as_i64);
        let request_id = header.get(1).and_then(Value::as_i64);
        if request_id != Some(0) {
            continue;
        }
        match response_type {
            Some(RESPONSE_SUCCESS) => return parse_sessions(&body),
            Some(RESPONSE_ERROR) | Some(RESPONSE_ERROR_OBJECT) => {
                return Err(format!("Cursor diagnostics failed: {}", body));
            }
            _ => {}
        }
    }
}

fn parse_sessions(diagnostics: &Value) -> Result<Vec<EditorSession>, String> {
    let windows = diagnostics
        .get("windows")
        .and_then(Value::as_array)
        .ok_or_else(|| "Cursor diagnostics did not contain windows".to_string())?;
    let mut sessions = Vec::new();

    for window in windows {
        let Some(window_id) = window.get("id").and_then(Value::as_i64) else {
            continue;
        };
        let Some(renderer_pid) = window.get("pid").and_then(Value::as_i64) else {
            continue;
        };
        let title = window
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let path = window
            .get("folderURIs")
            .and_then(Value::as_array)
            .filter(|folder_uris| folder_uris.len() == 1)
            .and_then(|folder_uris| folder_uris[0].get("fsPath"))
            .and_then(Value::as_str)
            .map(PathBuf::from);

        sessions.push(EditorSession {
            session_id: window_id.to_string(),
            renderer_pid: renderer_pid as i32,
            title,
            path,
        });
    }

    Ok(sessions)
}

fn write_regular_message(stream: &mut UnixStream, id: u32, payload: &[u8]) -> io::Result<()> {
    let mut header = [0u8; 13];
    header[0] = REGULAR_MESSAGE;
    header[1..5].copy_from_slice(&id.to_be_bytes());
    header[9..13].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    stream.write_all(&header)?;
    stream.write_all(payload)
}

fn read_regular_message(stream: &mut UnixStream) -> io::Result<Vec<u8>> {
    loop {
        let mut header = [0u8; 13];
        stream.read_exact(&mut header)?;
        let payload_len = u32::from_be_bytes(header[9..13].try_into().unwrap()) as usize;
        let mut payload = vec![0; payload_len];
        stream.read_exact(&mut payload)?;
        if header[0] == REGULAR_MESSAGE {
            return Ok(payload);
        }
    }
}

enum EncodedValue<'a> {
    Int(u32),
    String(&'a str),
}

fn encode_string(value: &str) -> Vec<u8> {
    let mut encoded = vec![1];
    write_vql(&mut encoded, value.len() as u32);
    encoded.extend(value.as_bytes());
    encoded
}

fn encode_array(values: &[EncodedValue<'_>]) -> Vec<u8> {
    let mut encoded = vec![4];
    write_vql(&mut encoded, values.len() as u32);
    for value in values {
        match value {
            EncodedValue::Int(value) => {
                encoded.push(6);
                write_vql(&mut encoded, *value);
            }
            EncodedValue::String(value) => encoded.extend(encode_string(value)),
        }
    }
    encoded
}

fn write_vql(buffer: &mut Vec<u8>, mut value: u32) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value > 0 {
            byte |= 0x80;
        }
        buffer.push(byte);
        if value == 0 {
            return;
        }
    }
}

fn read_vql(buffer: &[u8], offset: &mut usize) -> Result<u32, &'static str> {
    let mut value = 0u32;
    for shift in (0..32).step_by(7) {
        let byte = *buffer.get(*offset).ok_or("Unexpected end of IPC value")?;
        *offset += 1;
        value |= ((byte & 0x7f) as u32) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err("Invalid IPC integer")
}

fn decode_message(buffer: &[u8]) -> Result<(Vec<Value>, Value), &'static str> {
    let mut offset = 0;
    let header = decode_value(buffer, &mut offset)?;
    let body = decode_value(buffer, &mut offset)?;
    let header = header
        .as_array()
        .cloned()
        .ok_or("IPC header was not an array")?;
    Ok((header, body))
}

fn decode_value(buffer: &[u8], offset: &mut usize) -> Result<Value, &'static str> {
    let value_type = *buffer.get(*offset).ok_or("Unexpected end of IPC message")?;
    *offset += 1;
    match value_type {
        0 => Ok(Value::Null),
        1 => {
            let length = read_vql(buffer, offset)? as usize;
            let bytes = buffer
                .get(*offset..*offset + length)
                .ok_or("Invalid IPC string length")?;
            *offset += length;
            Ok(Value::String(
                std::str::from_utf8(bytes)
                    .map_err(|_| "Invalid IPC string")?
                    .to_string(),
            ))
        }
        2 | 3 => {
            let length = read_vql(buffer, offset)? as usize;
            *offset = offset
                .checked_add(length)
                .filter(|end| *end <= buffer.len())
                .ok_or("Invalid IPC buffer length")?;
            Ok(Value::Null)
        }
        4 => {
            let length = read_vql(buffer, offset)? as usize;
            let mut values = Vec::with_capacity(length);
            for _ in 0..length {
                values.push(decode_value(buffer, offset)?);
            }
            Ok(Value::Array(values))
        }
        5 => {
            let length = read_vql(buffer, offset)? as usize;
            let bytes = buffer
                .get(*offset..*offset + length)
                .ok_or("Invalid IPC object length")?;
            *offset += length;
            serde_json::from_slice(bytes).map_err(|_| "Invalid IPC object")
        }
        6 => Ok(Value::from(read_vql(buffer, offset)?)),
        _ => Err("Unsupported IPC value type"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_round_trips_request_values() {
        let mut encoded = encode_array(&[
            EncodedValue::Int(100),
            EncodedValue::Int(0),
            EncodedValue::String("diagnostics"),
            EncodedValue::String("getMainDiagnostics"),
        ]);
        encoded.push(0);

        let (header, body) = decode_message(&encoded).unwrap();
        assert_eq!(header[0], 100);
        assert_eq!(header[2], "diagnostics");
        assert_eq!(header[3], "getMainDiagnostics");
        assert!(body.is_null());
    }

    #[test]
    fn diagnostics_windows_are_parsed_without_using_array_order() {
        let diagnostics = serde_json::json!({
            "windows": [
                {
                    "id": 4,
                    "pid": 9004,
                    "title": "project",
                    "folderURIs": [{ "fsPath": "/worktrees/project" }]
                },
                {
                    "id": 1,
                    "pid": 9001,
                    "title": "project",
                    "folderURIs": [{ "fsPath": "/projects/project" }]
                }
            ]
        });

        let sessions = parse_sessions(&diagnostics).unwrap();
        assert_eq!(sessions[0].renderer_pid, 9004);
        assert_eq!(sessions[0].path, Some(PathBuf::from("/worktrees/project")));
        assert_eq!(sessions[1].renderer_pid, 9001);
        assert_eq!(sessions[1].path, Some(PathBuf::from("/projects/project")));
    }
}
