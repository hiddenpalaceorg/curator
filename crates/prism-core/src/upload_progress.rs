//! Progress validation for the resumable upload protocol.
pub struct UploadProgress {
    size: u64,
    offset: u64,
    resyncs: u8,
}

impl UploadProgress {
    pub fn new(size: u64) -> Self { Self { size, offset: 0, resyncs: 0 } }
    pub fn advance(&mut self, next: Option<u64>) -> Option<u64> {
        let next = next?;
        if next <= self.offset || next > self.size { return None; }
        self.offset = next;
        Some(next)
    }
    pub fn resume(&mut self, next: Option<u64>) -> Option<u64> {
        let next = next?;
        if next >= self.size || next == self.offset || self.resyncs >= 8 { return None; }
        self.resyncs += 1;
        self.offset = next;
        Some(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_stalled_and_invalid_successes() {
        let mut p = UploadProgress::new(10);
        assert_eq!(p.advance(Some(4)), Some(4));
        for next in [None, Some(0), Some(3), Some(4), Some(11), Some(u64::MAX)] {
            assert_eq!(p.advance(next), None);
        }
        assert_eq!(p.advance(Some(10)), Some(10));
    }
    #[test]
    fn resume_budget_survives_successes() {
        let mut p = UploadProgress::new(10);
        assert_eq!(p.advance(Some(4)), Some(4));
        for _ in 0..8 {
            assert_eq!(p.resume(Some(2)), Some(2));
            assert_eq!(p.advance(Some(4)), Some(4));
        }
        assert_eq!(p.resume(Some(2)), None);
        assert_eq!(p.advance(Some(10)), Some(10));
    }
    #[test]
    fn alternating_resumes_are_bounded() {
        let mut p = UploadProgress::new(10);
        for next in [None, Some(0), Some(10), Some(u64::MAX)] {
            assert_eq!(p.resume(next), None);
        }
        for i in 0..8 { assert_eq!(p.resume(Some(i % 2 + 1)), Some(i % 2 + 1)); }
        assert_eq!(p.resume(Some(1)), None);
    }
}
