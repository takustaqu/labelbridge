//! Unix ドメインソケット。macOS の Bluetooth 中継アプリ（tools/bt-bridge）と話すのに使う。

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use crate::{Result, Transport, TransportError};

pub struct UnixTransport {
    stream: UnixStream,
}

impl UnixTransport {
    pub fn connect(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            stream: UnixStream::connect(path)?,
        })
    }
}

impl Transport for UnixTransport {
    fn write_all(&mut self, data: &[u8]) -> Result<()> {
        Ok(self.stream.write_all(data)?)
    }

    fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        // macOS は相手が閉じたソケットへの setsockopt に EINVAL を返す
        if let Err(e) = self
            .stream
            .set_read_timeout(Some(timeout.max(Duration::from_millis(1))))
        {
            return Err(if e.kind() == std::io::ErrorKind::InvalidInput {
                TransportError::Disconnected
            } else {
                e.into()
            });
        }
        match self.stream.read(buf) {
            Ok(0) => Err(TransportError::Disconnected),
            Ok(n) => Ok(n),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Err(TransportError::Timeout)
            }
            Err(e) => Err(e.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_over_socketpair() {
        let dir = std::env::temp_dir().join(format!("labelbridge-unix-{}", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let listener = std::os::unix::net::UnixListener::bind(&dir).unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut b = [0; 2];
            s.read_exact(&mut b).unwrap();
            s.write_all(&[b[0] + b[1]]).unwrap();
        });
        let mut t = UnixTransport::connect(&dir).unwrap();
        t.write_all(&[2, 3]).unwrap();
        let mut b = [0; 1];
        t.read_exact(&mut b, Duration::from_secs(1)).unwrap();
        assert_eq!(b, [5]);
        server.join().unwrap();
        // 相手が閉じたら Disconnected
        let r = t.read(&mut b, Duration::from_millis(200));
        assert!(matches!(r, Err(TransportError::Disconnected)), "{r:?}");
        let _ = std::fs::remove_file(&dir);
    }
}
