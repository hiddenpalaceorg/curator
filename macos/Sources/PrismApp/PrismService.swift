import Foundation

/// One neighbor returned by `/api/similarity`. Tiers share sha256/name/system and
/// carry whichever score applies (Jaccard, TLSH distance, cosine sim, shared count).
struct SimilarNeighbor: Decodable, Identifiable {
    let sha256: String
    let name: String?
    let system: String?
    let jaccard: Double?
    let distance: Double?
    let sim: Double?
    let shared: Int?
    var id: String { sha256 }

    /// Human-readable score for the tier it came from.
    var scoreText: String? {
        if let jaccard { return String(format: "%.0f%%", jaccard * 100) }
        if let sim { return String(format: "%.2f", sim) }
        if let distance { return "d=\(Int(distance))" }
        if let shared { return "\(shared) shared" }
        return nil
    }
}

/// Response of `POST /api/similarity` (arrays default to empty when a tier is absent).
struct SimilarityResponse: Decodable {
    struct Query: Decodable { let sha256: String?; let name: String? }
    let query: Query
    let identicalContent: [SimilarNeighbor]
    let sharedFiles: [SimilarNeighbor]
    let similarChunks: [SimilarNeighbor]
    let exeImports: [SimilarNeighbor]
    let exeSimilar: [SimilarNeighbor]
    let audioNeighbors: [SimilarNeighbor]
    let textNeighbors: [SimilarNeighbor]

    private enum CodingKeys: String, CodingKey {
        case query
        case identicalContent = "identical_content"
        case sharedFiles = "shared_files"
        case similarChunks = "similar_chunks"
        case exeImports = "exe_imports"
        case exeSimilar = "exe_similar"
        case audioNeighbors = "audio_neighbors"
        case textNeighbors = "text_neighbors"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        query = try c.decode(Query.self, forKey: .query)
        func list(_ key: CodingKeys) -> [SimilarNeighbor] {
            (try? c.decode([SimilarNeighbor].self, forKey: key)) ?? []
        }
        identicalContent = list(.identicalContent)
        sharedFiles = list(.sharedFiles)
        similarChunks = list(.similarChunks)
        exeImports = list(.exeImports)
        exeSimilar = list(.exeSimilar)
        audioNeighbors = list(.audioNeighbors)
        textNeighbors = list(.textNeighbors)
    }

    /// (section title, neighbors) for non-empty tiers, in display order.
    var sections: [(String, [SimilarNeighbor])] {
        [
            ("Identical content", identicalContent),
            ("Shared files", sharedFiles),
            ("Similar chunks", similarChunks),
            ("Same boot imports", exeImports),
            ("Similar executable", exeSimilar),
            ("Shared audio tracks", audioNeighbors),
            ("Semantically related (text)", textNeighbors),
        ].filter { !$0.1.isEmpty }
    }

    var isEmpty: Bool { sections.isEmpty }
}

/// Read-only client for the Prism web service. Base URL from `PRISM_WEB_URL`
/// (default `https://hiddenpalace.org`; point it at a local dev server to test).
struct PrismService {
    /// The production default, built once without a force-unwrap.
    static let defaultBaseURL: URL = {
        var c = URLComponents()
        c.scheme = "https"
        c.host = "hiddenpalace.org"
        return c.url ?? URL(fileURLWithPath: "/")
    }()
    let baseURL: URL
    /// Optional moderation secret (`PRISM_MODERATION_TOKEN`). When set, a submit
    /// is auto-accepted so it replaces the live build instead of waiting in the queue.
    let moderationToken: String?

    init() {
        let raw = ProcessInfo.processInfo.environment["PRISM_WEB_URL"] ?? "https://hiddenpalace.org"
        baseURL = URL(string: raw) ?? PrismService.defaultBaseURL
        let token = ProcessInfo.processInfo.environment["PRISM_MODERATION_TOKEN"] ?? ""
        moderationToken = token.isEmpty ? nil : token
    }

    enum ServiceError: LocalizedError {
        case http(Int, String)
        case offline(String)
        case timedOut(String)
        case cancelled
        case transport(String, String)
        var errorDescription: String? {
            switch self {
            case let .http(code, msg): return "Server error \(code): \(msg)"
            case let .offline(msg): return "Cannot reach \(msg). Is the web service running?"
            case let .timedOut(msg): return "Request to \(msg) timed out. Is the web service responding?"
            case .cancelled: return "Request was cancelled."
            case let .transport(msg, detail): return "Network error talking to \(msg): \(detail)"
            }
        }
    }

    /// POST the canonical record JSON to `/api/similarity`.
    func findSimilar(recordJSON: String) async throws -> SimilarityResponse {
        let data = try await post(path: "/api/similarity", body: Data(recordJSON.utf8))
        return try JSONDecoder().decode(SimilarityResponse.self, from: data)
    }

    struct SubmitResult: Decodable { let sha256: String; let status: String }

    /// POST `{ nickname, record }` to `/api/submissions`.
    func submit(recordJSON: String, nickname: String) async throws -> SubmitResult {
        let record = try JSONSerialization.jsonObject(with: Data(recordJSON.utf8))
        let payload: [String: Any] = ["nickname": nickname, "record": record]
        let body = try JSONSerialization.data(withJSONObject: payload)
        let data = try await post(path: "/api/submissions", body: body)
        return try JSONDecoder().decode(SubmitResult.self, from: data)
    }

    /// Accept a queued submission with the moderation token, replacing the live build.
    func accept(buildSha: String) async throws {
        guard let token = moderationToken else { return }
        var req = URLRequest(url: baseURL.appendingPathComponent("/api/submissions/\(buildSha)"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "x-moderation-token")
        req.httpBody = Data(#"{"action":"accept"}"#.utf8)
        _ = try await perform(req)
    }

    private struct AssetsStatus: Decodable { let missing: [String] }

    /// GET `/api/submissions/<sha>/assets` — asset blobs the server still lacks.
    func missingAssets(buildSha: String) async throws -> [String] {
        var req = URLRequest(url: baseURL.appendingPathComponent("/api/submissions/\(buildSha)/assets"))
        req.httpMethod = "GET"
        let data = try await perform(req)
        return try JSONDecoder().decode(AssetsStatus.self, from: data).missing
    }

    /// Upload chunk size — small enough to clear typical proxy body-size limits.
    private static let uploadChunkBytes = 4 * 1024 * 1024

    /// One chunk response: `partial` carries the next offset; `stored`/`exists`
    /// end the upload. A 409 body carries only `offset` (the staged size); a
    /// 429 body carries `retryAfter` (seconds until the rate window resets).
    private struct ChunkResult: Decodable {
        let status: String?
        let offset: UInt64?
        let retryAfter: Double?
    }

    /// Give up after this many consecutive rate-limit waits on one chunk.
    private static let maxThrottleRetries = 30

    /// PUT one asset blob under its build in resumable chunks: each request
    /// appends at `offset`, a 409 answers with the server's staged offset to
    /// resume from, and the final chunk returns `stored` (or `exists`).
    func uploadAsset(buildSha: String, assetSha: String, fileURL: URL) async throws {
        let fh = try FileHandle(forReadingFrom: fileURL)
        defer { try? fh.close() }
        var offset: UInt64 = 0
        var progress = UploadProgress(size: try fh.seekToEnd())
        var throttled = 0
        while true {
            try fh.seek(toOffset: offset)
            let chunk = try fh.read(upToCount: Self.uploadChunkBytes) ?? Data()
            if chunk.isEmpty {
                // The record claims more bytes than the local blob holds.
                throw ServiceError.transport(baseURL.absoluteString, "asset blob shorter than its record claims")
            }
            var req = URLRequest(url: assetChunkURL(buildSha: buildSha, assetSha: assetSha, offset: offset))
            req.httpMethod = "PUT"
            req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            req.httpBody = chunk
            do {
                let data = try await perform(req)
                let r = try JSONDecoder().decode(ChunkResult.self, from: data)
                if r.status == "stored" || r.status == "exists" { return }
                guard r.status == "partial" else { throw UploadProgress.Invalid.progress }
                offset = try progress.advance(r.offset)
                throttled = 0
            } catch let ServiceError.http(code, body) where code == 409 {
                let staged = (try? JSONDecoder().decode(ChunkResult.self, from: Data(body.utf8)))?.offset
                offset = try progress.resume(staged)
            } catch let ServiceError.http(code, body) where code == 429 {
                // Rate limited — wait out the window (the server's retryAfter
                // when present) and retry the same offset.
                throttled += 1
                if throttled > Self.maxThrottleRetries { throw ServiceError.http(code, body) }
                let hint = (try? JSONDecoder().decode(ChunkResult.self, from: Data(body.utf8)))?.retryAfter
                let seconds = min(max(hint ?? 5, 1), 120)
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            }
        }
    }

    private func assetChunkURL(buildSha: String, assetSha: String, offset: UInt64) -> URL {
        let url = baseURL.appendingPathComponent("/api/submissions/\(buildSha)/assets/\(assetSha)")
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "offset", value: String(offset))]
        return comps?.url ?? url
    }

    private func post(path: String, body: Data) async throws -> Data {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        return try await perform(req)
    }

    /// Run one request with the shared friendly-error mapping.
    private func perform(_ req: URLRequest) async throws -> Data {
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch let urlError as URLError {
            let host = baseURL.absoluteString
            switch urlError.code {
            case .timedOut:
                throw ServiceError.timedOut(host)
            case .cancelled:
                throw ServiceError.cancelled
            case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .dnsLookupFailed:
                throw ServiceError.offline(host)
            default:
                throw ServiceError.transport(host, urlError.localizedDescription)
            }
        } catch {
            throw ServiceError.transport(baseURL.absoluteString, error.localizedDescription)
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let msg = String(data: data, encoding: .utf8) ?? ""
            throw ServiceError.http(code, msg)
        }
        return data
    }
}
