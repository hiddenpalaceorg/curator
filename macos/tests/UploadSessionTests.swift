import Foundation

final class UploadProtocol: URLProtocol {
    static var tokens: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "upload.fixture.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let token = request.value(forHTTPHeaderField: "X-Upload-Token") ?? ""
        precondition(token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil)
        Self.tokens.append(token)
        let first = Self.tokens.count % 2 == 1
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
        precondition(query?.first(where: { $0.name == "offset" })?.value == (first ? "0" : "4194304"))
        let response = HTTPURLResponse(url: request.url!, statusCode: first ? 202 : 201, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data((first ? #"{"status":"partial","offset":4194304}"# : #"{"status":"stored"}"#).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct UploadSessionTests {
    static func main() async throws {
        setenv("PRISM_WEB_URL", "https://upload.fixture.invalid", 1)
        precondition(URLProtocol.registerClass(UploadProtocol.self))
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data(count: 4 * 1024 * 1024 + 1).write(to: file)
        let service = PrismService()
        try await service.uploadAsset(buildSha: "build", assetSha: "asset", fileURL: file)
        try await service.uploadAsset(buildSha: "build", assetSha: "asset", fileURL: file)
        precondition(UploadProtocol.tokens.count == 4)
        precondition(UploadProtocol.tokens[0] == UploadProtocol.tokens[1])
        precondition(UploadProtocol.tokens[2] == UploadProtocol.tokens[3])
        precondition(UploadProtocol.tokens[0] != UploadProtocol.tokens[2])
        print("upload session tests passed")
    }
}
