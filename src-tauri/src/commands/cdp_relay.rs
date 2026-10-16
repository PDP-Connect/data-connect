// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// A loopback DevTools endpoint in front of a concealed browser that opens
// every new page in the background.
//
// Connectors open a page with `Target.createTarget` on every run, and a page
// opened in the foreground makes Chromium activate itself: on macOS 26 with
// Chrome 155 that put a window on screen and took the owner's focus, even
// with the window concealed again within milliseconds. The same request with
// `background: true` opens the page without activating anything. Connectors
// and the companion talk to the browser through this relay, which adds that
// flag. Everything else passes through byte for byte.
//
// HTTP discovery responses (`/json/version`, `/json/list`) are rewritten so
// their WebSocket URLs point at the relay, because clients connect to the
// URL they are given. Only client-to-browser WebSocket frames are parsed;
// browser-to-client traffic is copied unchanged.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

const MAX_HEADER_BYTES: usize = 64 * 1024;
/// Larger client messages are refused rather than buffered. CDP requests
/// from clients are small; large payloads flow from the browser.
const MAX_CLIENT_MESSAGE_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) struct CdpRelay {
    url: String,
    stop: Arc<AtomicBool>,
    acceptor: Option<JoinHandle<()>>,
}

impl CdpRelay {
    /// Start a relay for the browser whose DevTools HTTP endpoint is
    /// `upstream` (for example `http://127.0.0.1:9222`).
    pub(crate) fn start(upstream: &str) -> io::Result<Self> {
        let upstream_url = reqwest::Url::parse(upstream)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
        let upstream_address = upstream_url
            .socket_addrs(|| None)?
            .into_iter()
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no upstream address"))?;
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let relay_address = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let acceptor_stop = Arc::clone(&stop);
        let acceptor = thread::Builder::new()
            .name("cdp-relay".into())
            .spawn(move || accept(listener, upstream_address, relay_address, &acceptor_stop))?;
        Ok(Self {
            url: format!("http://{relay_address}"),
            stop,
            acceptor: Some(acceptor),
        })
    }

    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    /// Stop accepting connections. Open connections end with the browser.
    pub(crate) fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(acceptor) = self.acceptor.take() {
            let _ = acceptor.join();
        }
    }
}

impl Drop for CdpRelay {
    fn drop(&mut self) {
        self.stop();
    }
}

fn accept(listener: TcpListener, upstream: SocketAddr, relay: SocketAddr, stop: &AtomicBool) {
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((client, _)) => {
                let _ = thread::Builder::new()
                    .name("cdp-relay-connection".into())
                    .spawn(move || {
                        if let Err(error) = relay_connection(client, upstream, relay) {
                            log::debug!("DevTools relay connection ended: {error}");
                        }
                    });
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                log::warn!("DevTools relay stopped accepting: {error}");
                return;
            }
        }
    }
}

fn relay_connection(client: TcpStream, upstream: SocketAddr, relay: SocketAddr) -> io::Result<()> {
    client.set_nonblocking(false)?;
    let mut client_reader = BufReader::new(client.try_clone()?);
    let head = read_head(&mut client_reader)?;
    let mut browser = TcpStream::connect(upstream)?;
    if is_websocket_upgrade(&head) {
        // The handshake goes to the browser unchanged; it answers with its
        // own upgrade response, which goes back unchanged.
        browser.write_all(head.as_bytes())?;
        let mut browser_to_client = browser.try_clone()?;
        let mut client_writer = client;
        let pump = thread::spawn(move || io::copy(&mut browser_to_client, &mut client_writer));
        let result = forward_client_frames(&mut client_reader, &mut browser);
        let _ = browser.shutdown(std::net::Shutdown::Both);
        let _ = pump.join();
        return result;
    }
    // Plain HTTP: one request per connection, discovery URLs rewritten.
    // Chromium keeps the connection open whatever the request says, so the
    // body is read by its length rather than to the end of the stream.
    browser.write_all(force_connection_close(&head).as_bytes())?;
    let mut browser_reader = BufReader::new(browser);
    let response_head = read_head(&mut browser_reader)?;
    let length = header_value(&response_head, "content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    if length > MAX_CLIENT_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "discovery response too large",
        ));
    }
    let mut response = response_head.into_bytes();
    browser_reader.take(length).read_to_end(&mut response)?;
    let mut client = client;
    client.write_all(&rewrite_http_response(&response, upstream, relay))?;
    Ok(())
}

fn read_head(reader: &mut impl BufRead) -> io::Result<String> {
    let mut head = String::new();
    loop {
        let read = reader.read_line(&mut head)?;
        if read == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        if head.len() > MAX_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request head too large",
            ));
        }
        if head.ends_with("\r\n\r\n") {
            return Ok(head);
        }
    }
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn is_websocket_upgrade(head: &str) -> bool {
    header_value(head, "upgrade").is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn force_connection_close(head: &str) -> String {
    let mut lines: Vec<&str> = head
        .trim_end_matches("\r\n")
        .split("\r\n")
        .filter(|line| {
            !line
                .split_once(':')
                .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("connection"))
        })
        .collect();
    lines.push("Connection: close");
    format!("{}\r\n\r\n", lines.join("\r\n"))
}

/// Point discovery URLs at the relay. Only the browser's own address is
/// replaced, and the body length is recomputed.
fn rewrite_http_response(response: &[u8], upstream: SocketAddr, relay: SocketAddr) -> Vec<u8> {
    let Some(split) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return response.to_vec();
    };
    let (head, body) = (&response[..split], &response[split + 4..]);
    let Ok(body) = std::str::from_utf8(body) else {
        return response.to_vec();
    };
    let body = body.replace(&upstream.to_string(), &relay.to_string());
    let head = String::from_utf8_lossy(head);
    let mut lines: Vec<String> = head
        .split("\r\n")
        .filter(|line| {
            !line
                .split_once(':')
                .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("content-length"))
        })
        .map(str::to_string)
        .collect();
    lines.push(format!("Content-Length: {}", body.len()));
    let mut rewritten = format!("{}\r\n\r\n", lines.join("\r\n")).into_bytes();
    rewritten.extend_from_slice(body.as_bytes());
    rewritten
}

/// Copy client frames to the browser, rewriting page creation. Client frames
/// are always masked; a rewritten frame is sent unmasked-then-remasked with
/// the original key, and keeps its opcode and FIN bit.
fn forward_client_frames(client: &mut impl Read, browser: &mut impl Write) -> io::Result<()> {
    loop {
        let Some(frame) = read_frame(client)? else {
            return Ok(());
        };
        let rewritten = (frame.opcode == OPCODE_TEXT && frame.fin)
            .then(|| std::str::from_utf8(&frame.payload).ok())
            .flatten()
            .and_then(open_page_in_background);
        match rewritten {
            Some(text) => write_frame(
                browser,
                &Frame {
                    payload: text.into_bytes(),
                    ..frame
                },
            )?,
            None => write_frame(browser, &frame)?,
        }
        browser.flush()?;
        if frame.opcode == OPCODE_CLOSE {
            return Ok(());
        }
    }
}

const OPCODE_TEXT: u8 = 0x1;
const OPCODE_CLOSE: u8 = 0x8;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Frame {
    fin: bool,
    /// The RSV bits and opcode, as received.
    rsv: u8,
    opcode: u8,
    mask: Option<[u8; 4]>,
    /// Unmasked payload.
    payload: Vec<u8>,
}

fn read_frame(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut header = [0_u8; 2];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = match header[1] & 0x7f {
        126 => {
            let mut extended = [0_u8; 2];
            reader.read_exact(&mut extended)?;
            u64::from(u16::from_be_bytes(extended))
        }
        127 => {
            let mut extended = [0_u8; 8];
            reader.read_exact(&mut extended)?;
            u64::from_be_bytes(extended)
        }
        short => u64::from(short),
    };
    if length > MAX_CLIENT_MESSAGE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "client frame too large",
        ));
    }
    let mask = if header[1] & 0x80 != 0 {
        let mut key = [0_u8; 4];
        reader.read_exact(&mut key)?;
        Some(key)
    } else {
        None
    };
    let mut payload = vec![0_u8; length as usize];
    reader.read_exact(&mut payload)?;
    if let Some(key) = mask {
        apply_mask(&mut payload, key);
    }
    Ok(Some(Frame {
        fin: header[0] & 0x80 != 0,
        rsv: header[0] & 0x70,
        opcode: header[0] & 0x0f,
        mask,
        payload,
    }))
}

fn write_frame(writer: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let mut bytes = vec![u8::from(frame.fin) << 7 | frame.rsv | frame.opcode];
    let mask_bit = if frame.mask.is_some() { 0x80 } else { 0 };
    let length = frame.payload.len();
    if length < 126 {
        bytes.push(mask_bit | length as u8);
    } else if length <= usize::from(u16::MAX) {
        bytes.push(mask_bit | 126);
        bytes.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        bytes.push(mask_bit | 127);
        bytes.extend_from_slice(&(length as u64).to_be_bytes());
    }
    let mut payload = frame.payload.clone();
    if let Some(key) = frame.mask {
        bytes.extend_from_slice(&key);
        apply_mask(&mut payload, key);
    }
    bytes.extend_from_slice(&payload);
    writer.write_all(&bytes)
}

fn apply_mask(payload: &mut [u8], key: [u8; 4]) {
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= key[index % 4];
    }
}

/// The rewritten message when `message` asks the browser for a new page,
/// with `background` forced on. A page a client asked to open in the
/// foreground would take the owner's focus. None leaves the message as is.
fn open_page_in_background(message: &str) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(message).ok()?;
    if value.get("method")?.as_str()? != "Target.createTarget" {
        return None;
    }
    let params = value
        .as_object_mut()?
        .entry("params")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()?;
    if params.get("background") == Some(&serde_json::Value::Bool(true)) {
        return None;
    }
    params.insert("background".into(), serde_json::Value::Bool(true));
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn page_creation_is_forced_into_the_background_and_nothing_else_changes() {
        let rewritten =
            open_page_in_background(r#"{"id":3,"method":"Target.createTarget","params":{"url":"about:blank","browserContextId":"C1"}}"#)
                .expect("rewritten");
        let rewritten: serde_json::Value = serde_json::from_str(&rewritten).expect("json");
        assert_eq!(
            rewritten,
            json!({"id":3,"method":"Target.createTarget","params":{"url":"about:blank","browserContextId":"C1","background":true}})
        );
        let foreground = open_page_in_background(
            r#"{"id":4,"method":"Target.createTarget","params":{"url":"x","background":false}}"#,
        )
        .expect("an explicit foreground request is overridden");
        assert!(foreground.contains(r#""background":true"#));
        assert!(open_page_in_background(
            r#"{"id":5,"method":"Target.createTarget","params":{"url":"x","background":true}}"#
        )
        .is_none());
        assert!(open_page_in_background(
            r#"{"id":6,"method":"Page.navigate","params":{"url":"x"}}"#
        )
        .is_none());
        assert!(open_page_in_background("not json").is_none());
        let without_params = open_page_in_background(r#"{"id":7,"method":"Target.createTarget"}"#)
            .expect("rewritten");
        assert!(without_params.contains(r#""params":{"background":true}"#));
    }

    fn masked(payload: &[u8], fin: bool, opcode: u8) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_frame(
            &mut bytes,
            &Frame {
                fin,
                rsv: 0,
                opcode,
                mask: Some([1, 2, 3, 4]),
                payload: payload.to_vec(),
            },
        )
        .expect("write");
        bytes
    }

    #[test]
    fn frames_round_trip_at_every_length_encoding() {
        for length in [0, 125, 126, 65_535, 65_536] {
            let payload = vec![b'a'; length];
            let bytes = masked(&payload, true, OPCODE_TEXT);
            let frame = read_frame(&mut bytes.as_slice())
                .expect("read")
                .expect("frame");
            assert_eq!(frame.payload, payload, "length {length}");
            assert_eq!(frame.mask, Some([1, 2, 3, 4]));
            let mut again = Vec::new();
            write_frame(&mut again, &frame).expect("write");
            assert_eq!(again, bytes, "length {length}");
        }
    }

    #[test]
    fn only_complete_page_creation_messages_are_rewritten_on_the_way_to_the_browser() {
        let create = br#"{"id":1,"method":"Target.createTarget","params":{"url":"about:blank"}}"#;
        let navigate = br#"{"id":2,"method":"Page.navigate","params":{"url":"x"}}"#;
        let mut input = masked(create, true, OPCODE_TEXT);
        input.extend(masked(navigate, true, OPCODE_TEXT));
        // A fragment is passed through: a partial message cannot be parsed.
        input.extend(masked(create, false, OPCODE_TEXT));
        input.extend(masked(b"", true, OPCODE_CLOSE));
        let mut output = Vec::new();
        forward_client_frames(&mut input.as_slice(), &mut output).expect("forward");
        let mut reader = output.as_slice();
        let first = read_frame(&mut reader).expect("read").expect("frame");
        assert!(String::from_utf8(first.payload)
            .expect("utf8")
            .contains(r#""background":true"#));
        assert_eq!(
            read_frame(&mut reader)
                .expect("read")
                .expect("frame")
                .payload,
            navigate
        );
        let fragment = read_frame(&mut reader).expect("read").expect("frame");
        assert!(!fragment.fin);
        assert_eq!(fragment.payload, create);
        assert_eq!(
            read_frame(&mut reader)
                .expect("read")
                .expect("frame")
                .opcode,
            OPCODE_CLOSE
        );
    }

    #[test]
    fn discovery_urls_point_at_the_relay() {
        let upstream: SocketAddr = "127.0.0.1:9222".parse().expect("addr");
        let relay: SocketAddr = "127.0.0.1:4000".parse().expect("addr");
        let body = r#"{"webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/abc"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let rewritten =
            String::from_utf8(rewrite_http_response(response.as_bytes(), upstream, relay))
                .expect("utf8");
        let expected = r#"{"webSocketDebuggerUrl":"ws://127.0.0.1:4000/devtools/browser/abc"}"#;
        assert!(rewritten.ends_with(expected), "{rewritten}");
        assert!(rewritten.contains(&format!("Content-Length: {}\r\n", expected.len())));
        assert!(rewritten.contains("Content-Type: application/json\r\n"));
    }

    #[test]
    fn connection_headers_are_replaced_with_close() {
        let head = "GET /json/version HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n";
        assert_eq!(
            force_connection_close(head),
            "GET /json/version HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
        );
        assert!(is_websocket_upgrade(
            "GET /devtools/browser/a HTTP/1.1\r\nUpgrade: WebSocket\r\n\r\n"
        ));
        assert!(!is_websocket_upgrade(
            "GET /json HTTP/1.1\r\nHost: x\r\n\r\n"
        ));
    }

    /// Against a running browser: `DATACONNECT_RELAY_UPSTREAM=http://127.0.0.1:<port>
    /// cargo test --lib relay_serves_a_real_browser -- --ignored`.
    #[test]
    #[ignore = "needs a running browser in DATACONNECT_RELAY_UPSTREAM"]
    fn relay_serves_a_real_browser() {
        let upstream = std::env::var("DATACONNECT_RELAY_UPSTREAM").expect("upstream");
        let relay = CdpRelay::start(&upstream).expect("relay");
        let version: serde_json::Value =
            reqwest::blocking::get(format!("{}/json/version", relay.url()))
                .expect("version")
                .json()
                .expect("json");
        let websocket = version["webSocketDebuggerUrl"].as_str().expect("ws url");
        assert!(
            websocket.contains(&relay.url()["http://".len()..]),
            "{websocket}"
        );
        let (mut socket, _) = tungstenite::connect(websocket).expect("connect through relay");
        socket
            .send(tungstenite::Message::text(
                r#"{"id":1,"method":"Target.createTarget","params":{"url":"about:blank"}}"#,
            ))
            .expect("send");
        let reply = socket.read().expect("reply");
        println!("reply: {reply}");
        assert!(reply.to_text().expect("text").contains("targetId"));
    }
}
