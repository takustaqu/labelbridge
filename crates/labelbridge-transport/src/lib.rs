//! プリンターとのバイト列通信。プロトコルの意味はドライバ側で扱う。

#[cfg(all(feature = "serial", unix))]
pub mod serial;
pub mod tprt;
#[cfg(unix)]
pub mod unix;
#[cfg(feature = "usb")]
pub mod usb;

use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("timed out")]
    Timeout,
    #[error("device disconnected")]
    Disconnected,
}

pub type Result<T> = std::result::Result<T, TransportError>;

pub trait Transport {
    fn write_all(&mut self, data: &[u8]) -> Result<()>;
    /// 1 バイト以上受信するか timeout まで待つ。0 バイトで返ることはない。
    fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize>;

    fn read_exact(&mut self, buf: &mut [u8], timeout: Duration) -> Result<()> {
        let mut filled = 0;
        while filled < buf.len() {
            filled += self.read(&mut buf[filled..], timeout)?;
        }
        Ok(())
    }
}

/// テスト・ドライラン用。書き込みを記録し、用意した応答を返す。
#[derive(Default)]
pub struct MockTransport {
    pub written: Vec<u8>,
    pub responses: std::collections::VecDeque<Vec<u8>>,
}

impl Transport for MockTransport {
    fn write_all(&mut self, data: &[u8]) -> Result<()> {
        self.written.extend_from_slice(data);
        Ok(())
    }

    fn read(&mut self, buf: &mut [u8], _timeout: Duration) -> Result<usize> {
        let Some(mut chunk) = self.responses.pop_front() else {
            return Err(TransportError::Timeout);
        };
        let n = chunk.len().min(buf.len());
        buf[..n].copy_from_slice(&chunk[..n]);
        if n < chunk.len() {
            self.responses.push_front(chunk.split_off(n));
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_read_exact_spans_chunks() {
        let mut t = MockTransport::default();
        t.responses.extend([vec![1, 2], vec![3, 4, 5]]);
        let mut buf = [0; 4];
        t.read_exact(&mut buf, Duration::from_millis(1)).unwrap();
        assert_eq!(buf, [1, 2, 3, 4]);
        let mut rest = [0; 1];
        t.read_exact(&mut rest, Duration::from_millis(1)).unwrap();
        assert_eq!(rest, [5]);
        assert!(matches!(
            t.read(&mut rest, Duration::from_millis(1)),
            Err(TransportError::Timeout)
        ));
    }
}
