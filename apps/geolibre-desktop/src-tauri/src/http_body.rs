//! Bounded buffering for native downloads whose callers supply a size limit.
use std::io::Read;

pub fn read_limited_body(
    reader: impl Read,
    content_length: Option<u64>,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    let too_large = || format!("Response exceeds the {max_bytes}-byte download limit");
    if content_length.is_some_and(|length| length > max_bytes) {
        return Err(too_large());
    }
    // Read one extra byte to distinguish an exact-limit body from a larger
    // response, including chunked responses and inaccurate Content-Length.
    let mut bytes = Vec::new();
    reader
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read response body: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_large());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::read_limited_body;
    use std::io::{self, Read};

    #[test]
    fn rejects_large_headers_without_reading() {
        struct Unreadable;
        impl Read for Unreadable {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                panic!("must reject the header before reading");
            }
        }
        assert!(read_limited_body(Unreadable, Some(5), 4).is_err());
    }

    #[test]
    fn accepts_exact_limit_and_rejects_oversize_streams() {
        assert_eq!(read_limited_body(&b"1234"[..], None, 4).unwrap(), b"1234");
        for declared in [None, Some(1)] {
            let mut reader = &b"123456789"[..];
            assert!(read_limited_body(&mut reader, declared, 4).is_err());
            assert_eq!(reader, b"6789");
        }
    }

    #[test]
    fn propagates_read_failures() {
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::other("connection closed"))
            }
        }
        assert!(read_limited_body(Broken, None, 4)
            .unwrap_err()
            .contains("connection closed"));
    }
}
