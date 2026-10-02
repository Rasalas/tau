//! TLS and WebSocket records are implemented by rustls and tungstenite.
//! The relay carries bytes only; this verifier authenticates the host itself.
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider},
    pki_types::{CertificateDer, ServerName, UnixTime},
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, Error,
    SignatureScheme,
};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    io::{self, Cursor, Read, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tungstenite::{
    handshake::{client::ClientHandshake, MidHandshake},
    HandshakeError, Message, WebSocket,
};
use wasm_bindgen::prelude::*;
use x509_parser::parse_x509_certificate;

#[derive(Debug)]
struct PinVerifier {
    pin: [u8; 32],
    key: bool,
    provider: Arc<CryptoProvider>,
}

fn parse_pin(pin: &str) -> Result<[u8; 32], Error> {
    let hex = pin.replace(':', "");
    if hex.len() != 64 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::General("A host SHA-256 pin is required.".into()));
    }
    let mut bytes = [0; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
    }
    Ok(bytes)
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let (remaining, parsed) = parse_x509_certificate(cert.as_ref())
            .map_err(|_| Error::InvalidCertificate(CertificateError::BadEncoding))?;
        if !remaining.is_empty() {
            return Err(Error::InvalidCertificate(CertificateError::BadEncoding));
        }
        let bytes = if self.key {
            parsed.public_key().raw
        } else {
            cert.as_ref()
        };
        if Sha256::digest(bytes).as_slice() != self.pin {
            return Err(Error::General(
                "The host's pinned key or certificate differs.".into(),
            ));
        }
        // The pin is the trust anchor. Rustls still verifies CertificateVerify
        // through the provider below, proving possession of that pinned key.
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[derive(Debug)]
struct BrowserTime;
impl rustls::time_provider::TimeProvider for BrowserTime {
    fn current_time(&self) -> Option<UnixTime> {
        #[cfg(target_arch = "wasm32")]
        {
            Some(UnixTime::since_unix_epoch(Duration::from_secs(
                (js_sys::Date::now() / 1000.0) as u64,
            )))
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            Some(UnixTime::now())
        }
    }
}

fn tls_connection(host: &str, pin: &str, key: bool) -> Result<ClientConnection, Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_details(provider.clone(), Arc::new(BrowserTime))
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerifier {
            pin: parse_pin(pin)?,
            key,
            provider,
        }))
        .with_no_client_auth();
    let name = ServerName::try_from(host.to_owned())
        .map_err(|_| Error::General("Invalid host name.".into()))?;
    let mut connection = ClientConnection::new(Arc::new(config), name)?;
    connection.set_buffer_limit(Some(113 * 1024 * 1024));
    Ok(connection)
}

struct RecordOutput(Vec<u8>);
impl Write for RecordOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let length = bytes.len().min(65536 - self.0.len());
        if length == 0 {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        self.0.extend_from_slice(&bytes[..length]);
        Ok(length)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug)]
struct TlsStream(Arc<Mutex<ClientConnection>>);
impl Read for TlsStream {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.0.lock().unwrap().reader().read(bytes)
    }
}
impl Write for TlsStream {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().writer().write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
enum State {
    Tls,
    Upgrade(MidHandshake<ClientHandshake<TlsStream>>),
    Open(WebSocket<TlsStream>),
    Closed,
}

#[wasm_bindgen]
pub struct BrowserTunnel {
    tls: Arc<Mutex<ClientConnection>>,
    state: State,
    url: String,
    messages: VecDeque<String>,
    message_bytes: usize,
    close_code: u16,
    close_reason: String,
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
fn blocked(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(e) if e.kind() == io::ErrorKind::WouldBlock)
}

#[wasm_bindgen]
impl BrowserTunnel {
    #[wasm_bindgen(constructor)]
    pub fn new(
        url: String,
        host: String,
        pin: String,
        key: bool,
    ) -> Result<BrowserTunnel, JsValue> {
        if !url.starts_with("wss://") {
            return Err(js_error("The inner host requires TLS."));
        }
        Ok(Self {
            tls: Arc::new(Mutex::new(
                tls_connection(&host, &pin, key).map_err(js_error)?,
            )),
            state: State::Tls,
            url,
            messages: VecDeque::new(),
            message_bytes: 0,
            close_code: 1006,
            close_reason: String::new(),
        })
    }
    pub fn feed(&mut self, bytes: &[u8]) -> Result<(), JsValue> {
        if bytes.len() > 65536 {
            return Err(js_error("Relay frame exceeds 64 KiB."));
        }
        // Rustls bounds its received plaintext buffer. Consume it through
        // tungstenite between record fragments, including fragmented messages.
        for chunk in bytes.chunks(16384) {
            let mut input = Cursor::new(chunk);
            while input.position() < chunk.len() as u64 {
                {
                    let mut tls = self.tls.lock().unwrap();
                    if tls.read_tls(&mut input).map_err(js_error)? == 0 {
                        return Err(js_error("TLS input did not make progress."));
                    }
                    tls.process_new_packets().map_err(js_error)?;
                }
                self.poll()?;
                while let Some(text) = self.receive_next()? {
                    self.message_bytes += text.len();
                    if self.message_bytes > 112 * 1024 * 1024 {
                        return Err(js_error("Unread host messages exceed the buffer limit."));
                    }
                    self.messages.push_back(text);
                }
            }
        }
        Ok(())
    }
    pub fn drain(&mut self) -> Result<Vec<u8>, JsValue> {
        let mut output = RecordOutput(Vec::new());
        let mut tls = self.tls.lock().unwrap();
        while tls.wants_write() && output.0.len() < 65536 {
            tls.write_tls(&mut output).map_err(js_error)?;
        }
        Ok(output.0)
    }
    pub fn poll(&mut self) -> Result<bool, JsValue> {
        let state = std::mem::replace(&mut self.state, State::Closed);
        let handshake = match state {
            State::Tls => {
                if self.tls.lock().unwrap().is_handshaking() {
                    self.state = State::Tls;
                    return Ok(false);
                }
                // No HTTP request, pairing frame or hello can leave before the
                // pinned TLS handshake and its signature have both succeeded.
                tungstenite::client(self.url.as_str(), TlsStream(self.tls.clone()))
            }
            State::Upgrade(handshake) => handshake.handshake(),
            other => {
                self.state = other;
                return Ok(matches!(self.state, State::Open(_)));
            }
        };
        match handshake {
            Ok((mut socket, _response)) => {
                socket.set_config(|config| {
                    config.max_message_size = Some(112 * 1024 * 1024);
                    config.max_frame_size = Some(112 * 1024 * 1024);
                    config.max_write_buffer_size = 113 * 1024 * 1024;
                });
                self.state = State::Open(socket);
                Ok(true)
            }
            Err(HandshakeError::Interrupted(handshake)) => {
                self.state = State::Upgrade(handshake);
                Ok(false)
            }
            Err(HandshakeError::Failure(error)) => Err(js_error(error)),
        }
    }
    pub fn flush(&mut self) -> Result<(), JsValue> {
        if let State::Open(socket) = &mut self.state {
            match socket.flush() {
                Ok(()) => Ok(()),
                Err(error) if blocked(&error) => Ok(()),
                Err(error) => Err(js_error(error)),
            }
        } else {
            Ok(())
        }
    }
    pub fn receive(&mut self) -> Result<Option<String>, JsValue> {
        if let Some(text) = self.messages.pop_front() {
            self.message_bytes -= text.len();
            return Ok(Some(text));
        }
        self.receive_next()
    }
    fn receive_next(&mut self) -> Result<Option<String>, JsValue> {
        if let State::Open(socket) = &mut self.state {
            loop {
                match socket.read() {
                    Ok(Message::Text(text)) => return Ok(Some(text.to_string())),
                    Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                    Ok(Message::Close(frame)) => {
                        if let Some(frame) = frame {
                            self.close_code = frame.code.into();
                            self.close_reason = frame.reason.to_string();
                        }
                        self.state = State::Closed;
                        return Ok(None);
                    }
                    Ok(_) => return Err(js_error("The host sent a non-text WebSocket message.")),
                    Err(error) if blocked(&error) => return Ok(None),
                    Err(tungstenite::Error::ConnectionClosed) => {
                        self.state = State::Closed;
                        return Ok(None);
                    }
                    Err(error) => return Err(js_error(error)),
                }
            }
        }
        Ok(None)
    }
    pub fn send(&mut self, text: String) -> Result<(), JsValue> {
        if text.len() > 112 * 1024 * 1024 {
            return Err(js_error("Host message exceeds the frame limit."));
        }
        if let State::Open(socket) = &mut self.state {
            match socket.send(Message::Text(text.into())) {
                Ok(()) => Ok(()),
                Err(error) if blocked(&error) => Ok(()),
                Err(error) => Err(js_error(error)),
            }
        } else {
            Err(js_error("The pinned host socket is not open."))
        }
    }
    pub fn closed(&self) -> bool {
        matches!(self.state, State::Closed)
    }
    pub fn close_code(&self) -> u16 {
        self.close_code
    }
    pub fn close_reason(&self) -> String {
        self.close_reason.clone()
    }
    pub fn close(&mut self) {
        self.state = State::Closed;
        self.tls.lock().unwrap().send_close_notify();
    }
}
