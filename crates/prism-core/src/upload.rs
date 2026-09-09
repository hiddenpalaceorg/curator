//! Bounded, seekable input for resumable uploads.
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

pub const UPLOAD_CHUNK: usize = 4 * 1024 * 1024;

pub struct UploadSource {
    file: File,
    size: u64,
    buffer: Vec<u8>,
}

impl UploadSource {
    pub fn open(path: &Path) -> io::Result<Self> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        Ok(Self { file, size, buffer: vec![0; UPLOAD_CHUNK] })
    }
    pub fn len(&self) -> u64 { self.size }
    pub fn is_empty(&self) -> bool { self.size == 0 }
    pub fn chunk(&mut self, offset: u64) -> io::Result<&[u8]> {
        let remaining = self.size.checked_sub(offset)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "upload offset exceeds file size"))?;
        let count = remaining.min(UPLOAD_CHUNK as u64) as usize;
        self.file.seek(SeekFrom::Start(offset))?;
        self.file.read_exact(&mut self.buffer[..count])?;
        Ok(&self.buffer[..count])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn sparse_large_file_uses_one_chunk_and_can_resume_backwards() {
        let path = std::env::temp_dir().join(format!("prism-upload-source-{}", std::process::id()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
        let size = 1u64 << 40;
        file.write_all(b"first").unwrap();
        file.set_len(size).unwrap();
        file.seek(SeekFrom::Start(size - 4)).unwrap();
        file.write_all(b"last").unwrap();
        let mut source = UploadSource::open(&path).unwrap();
        assert_eq!(source.len(), size);
        assert_eq!(source.buffer.len(), UPLOAD_CHUNK);
        assert_eq!(source.chunk(size - 4).unwrap(), b"last");
        assert_eq!(&source.chunk(0).unwrap()[..5], b"first");
        assert_eq!(&source.chunk(0).unwrap()[..5], b"first");
        assert!(source.chunk(size + 1).is_err());
        file.set_len(0).unwrap();
        assert_eq!(source.chunk(0).unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        drop(source);
        drop(file);
        std::fs::remove_file(path).unwrap();
    }
}
