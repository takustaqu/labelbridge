//! SR5900P などの LAN 制御プロトコル（UDP 9100、`TPRT` ヘッダ）と、
//! データ用 TCP 9100 接続（docs/protocol.md §4）。
//!
//! ヘッダ（32 バイト、ビッグエンディアン）:
//! `"TPRT"`（応答は `"tprt"`）| 0 | 1 | 0x20 | cmd | data_size | ip | token
//!
//! | cmd | 意味 | 応答データ |
//! |---|---|---|
//! | 1 | ステータス | 20 バイト |
//! | 2 | 印刷開始（TCP 9100 が開く） | `02 00 00` |
//! | 3 | 印刷終了 | `03 00 00` |
//! | 0x0101 → 0x0100 | データ送信の通知 | 0x0100 の応答が `10`（時に `00`） |

use std::io::Write;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

use crate::{Result, Transport, TransportError};

pub const PORT: u16 = 9100;
const HEADER_LEN: usize = 32;

pub const CMD_STATUS: u32 = 1;
pub const CMD_START: u32 = 2;
pub const CMD_STOP: u32 = 3;
pub const CMD_NOTIFY_1: u32 = 0x0101;
pub const CMD_NOTIFY_2: u32 = 0x0100;

pub fn header(cmd: u32, data_size: u32) -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[0..4].copy_from_slice(b"TPRT");
    h[8..12].copy_from_slice(&1u32.to_be_bytes());
    h[12..16].copy_from_slice(&0x20u32.to_be_bytes());
    h[16..20].copy_from_slice(&cmd.to_be_bytes());
    h[20..24].copy_from_slice(&data_size.to_be_bytes());
    h
}

/// ホスト名を解決する。IPv4 を優先し、なければ最初のアドレス。
/// 解決できなければ、ホスト名を含む [`TransportError::Io`] を返す。
fn resolve(host: &str, port: u16) -> Result<SocketAddr> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| std::io::Error::new(e.kind(), format!("cannot resolve {host}: {e}")))?
        .collect();
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or(addrs.first())
        .copied()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("cannot resolve {host}: no addresses"),
            )
            .into()
        })
}

/// UDP の制御チャネル。
pub struct TprtClient {
    socket: UdpSocket,
    addr: SocketAddr,
    timeout: Duration,
}

impl TprtClient {
    /// `host`（名前または IP アドレス）をここで解決する。解決できなければエラー（メッセージにホスト名を含む）。
    pub fn new(host: &str, timeout: Duration) -> Result<Self> {
        let addr = resolve(host, PORT)?;
        let socket = UdpSocket::bind(if addr.is_ipv4() {
            "0.0.0.0:0"
        } else {
            "[::]:0"
        })?;
        Ok(Self {
            socket,
            addr,
            timeout,
        })
    }

    /// コマンドを送り、応答のデータ部（ヘッダの後ろ）を返す。
    /// 関係ない応答が届いても、全体で `timeout` を超えたら `Timeout`。
    pub fn request(&self, cmd: u32) -> Result<Vec<u8>> {
        self.socket.send_to(&header(cmd, 0), self.addr)?;
        let deadline = Instant::now() + self.timeout;
        let mut buf = [0u8; 512];
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(TransportError::Timeout);
            }
            self.socket.set_read_timeout(Some(remaining))?;
            let (n, _) = self
                .socket
                .recv_from(&mut buf)
                .map_err(|e| match e.kind() {
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => {
                        TransportError::Timeout
                    }
                    _ => e.into(),
                })?;
            // 応答ヘッダ "tprt" で、同じ cmd のものだけを採る
            if n >= HEADER_LEN && &buf[0..4] == b"tprt" && buf[16..20] == cmd.to_be_bytes() {
                return Ok(buf[HEADER_LEN..n].to_vec());
            }
        }
    }
}

/// 印刷データ用の TCP 接続（cmd 2 の後にだけ開く）。
pub struct DataStream {
    stream: TcpStream,
}

impl DataStream {
    pub fn connect(host: &str, timeout: Duration) -> Result<Self> {
        let addr = resolve(host, PORT)?;
        let stream = TcpStream::connect_timeout(&addr, timeout)?;
        stream.set_nodelay(true)?;
        Ok(Self { stream })
    }
}

impl Transport for DataStream {
    fn write_all(&mut self, data: &[u8]) -> Result<()> {
        Ok(self.stream.write_all(data)?)
    }

    fn read(&mut self, _buf: &mut [u8], _timeout: Duration) -> Result<usize> {
        // データ経路では応答を読まない（状態は UDP で取る）
        Err(TransportError::Timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_layout() {
        let h = header(CMD_NOTIFY_1, 0);
        assert_eq!(&h[0..4], b"TPRT");
        assert_eq!(h[4..16], [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0x20]);
        assert_eq!(h[16..20], [0, 0, 1, 1]);
        assert!(h[20..].iter().all(|&b| b == 0));
    }

    #[test]
    fn unresolvable_host_is_an_error_from_new() {
        // .invalid は RFC 6761 で解決されないことが保証されている
        let host = "labelbridge-no-such-host.invalid";
        let err = TprtClient::new(host, Duration::from_secs(1))
            .err()
            .expect("must not resolve");
        assert!(matches!(err, TransportError::Io(_)), "{err:?}");
        assert!(err.to_string().contains(host), "{err}");
        let err = DataStream::connect(host, Duration::from_secs(1))
            .err()
            .expect("must not resolve");
        assert!(err.to_string().contains(host), "{err}");
    }

    #[test]
    fn request_matches_response_by_command() {
        let fake = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = fake.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let mut buf = [0u8; 64];
            let (n, from) = fake.recv_from(&mut buf).unwrap();
            assert_eq!(buf[..n], header(CMD_STATUS, 0));
            let mut res = header(CMD_STATUS, 3);
            res[0..4].copy_from_slice(b"tprt");
            // 別コマンドへの応答が先に届いても無視される
            let mut other = res;
            other[16..20].copy_from_slice(&CMD_START.to_be_bytes());
            fake.send_to(&[&other[..], &[9]].concat(), from).unwrap();
            fake.send_to(&[&res[..], &[1, 2, 3]].concat(), from)
                .unwrap();
        });
        let mut c = TprtClient::new("127.0.0.1", Duration::from_secs(1)).unwrap();
        c.addr.set_port(port);
        assert_eq!(c.request(CMD_STATUS).unwrap(), [1, 2, 3]);
        server.join().unwrap();
    }
}
