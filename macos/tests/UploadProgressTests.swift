@main
struct UploadProgressTests {
    static func check(_ value: Bool) { precondition(value) }
    static func main() throws {
        var p = UploadProgress(size: 10)
        check(try p.advance(4) == 4)
        for next: UInt64? in [nil, 0, 3, 4, 11, UInt64.max] {
            do { _ = try p.advance(next); fatalError("accepted invalid success") }
            catch UploadProgress.Invalid.progress {}
        }
        for _ in 0..<8 {
            check(try p.resume(2) == 2)
            check(try p.advance(4) == 4)
        }
        do { _ = try p.resume(2); fatalError("unbounded resume") }
        catch UploadProgress.Invalid.progress {}
        check(try p.advance(10) == 10)
        var q = UploadProgress(size: 10)
        for next: UInt64? in [nil, 0, 10, UInt64.max] {
            do { _ = try q.resume(next); fatalError("invalid resume") }
            catch UploadProgress.Invalid.progress {}
        }
        for i in 0..<8 { _ = try q.resume(UInt64(i % 2 + 1)) }
        do { _ = try q.resume(1); fatalError("alternating resume") }
        catch UploadProgress.Invalid.progress {}
        print("upload progress checks passed")
    }
}
