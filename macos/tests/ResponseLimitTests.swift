import Foundation

private final class Counter { var reads = 0 }
private struct Bytes: AsyncSequence, AsyncIteratorProtocol {
    typealias Element = UInt8
    var left: Int
    let counter: Counter
    func makeAsyncIterator() -> Self { self }
    mutating func next() async throws -> UInt8? {
        counter.reads += 1
        guard left > 0 else { return nil }
        left -= 1
        return 97
    }
}

@main
struct ResponseLimitTests {
    static func main() async throws {
        let normal = try await PrismService.boundedData(Bytes(left: 4, counter: Counter()), limit: 4)
        precondition(normal == Data("aaaa".utf8))
        for count in [5, 1000000] {
            let counter = Counter()
            do {
                _ = try await PrismService.boundedData(Bytes(left: count, counter: counter), limit: 4)
                fatalError("accepted oversized response")
            } catch PrismService.ServiceError.transport {}
            precondition(counter.reads == 5)
        }
        let empty = try await PrismService.boundedData(Bytes(left: 0, counter: Counter()), limit: 4)
        precondition(empty.isEmpty)
        precondition(PrismService.maxResponseBytes > 100000 * 67 + 100)
        print("response limit checks passed")
    }
}
