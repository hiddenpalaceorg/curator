struct UploadProgress {
    let size: UInt64
    private var offset: UInt64 = 0
    private var resyncs = 0
    enum Invalid: Error { case progress }
    init(size: UInt64) { self.size = size }

    mutating func advance(_ next: UInt64?) throws -> UInt64 {
        guard let next, next > offset, next <= size else { throw Invalid.progress }
        offset = next
        return next
    }

    mutating func resume(_ next: UInt64?) throws -> UInt64 {
        guard let next, next < size, next != offset, resyncs < 8 else { throw Invalid.progress }
        resyncs += 1
        offset = next
        return next
    }
}
