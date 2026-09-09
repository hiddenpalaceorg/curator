using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace PrismWin;

/// One neighbor returned by `/api/similarity`. Tiers share sha256/name/system and
/// carry whichever score applies (Jaccard, TLSH distance, cosine sim, shared count).
public sealed class SimilarNeighbor
{
    [JsonPropertyName("sha256")] public string Sha256 { get; set; } = "";
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("system")] public string? System { get; set; }
    [JsonPropertyName("jaccard")] public double? Jaccard { get; set; }
    [JsonPropertyName("distance")] public double? Distance { get; set; }
    [JsonPropertyName("sim")] public double? Sim { get; set; }
    [JsonPropertyName("shared")] public long? Shared { get; set; }

    /// Human-readable score for the tier it came from.
    [JsonIgnore]
    public string? ScoreText =>
        Jaccard is { } j ? $"{j * 100:0}%"
        : Sim is { } s ? $"{s:0.00}"
        : Distance is { } d ? $"d={(int)d}"
        : Shared is { } n ? $"{n} shared"
        : null;
}

/// Response of `POST /api/similarity` (tiers default to empty when absent).
public sealed class SimilarityResponse
{
    [JsonPropertyName("identical_content")] public List<SimilarNeighbor> IdenticalContent { get; set; } = new();
    [JsonPropertyName("shared_files")] public List<SimilarNeighbor> SharedFiles { get; set; } = new();
    [JsonPropertyName("similar_chunks")] public List<SimilarNeighbor> SimilarChunks { get; set; } = new();
    [JsonPropertyName("exe_imports")] public List<SimilarNeighbor> ExeImports { get; set; } = new();
    [JsonPropertyName("exe_similar")] public List<SimilarNeighbor> ExeSimilar { get; set; } = new();
    [JsonPropertyName("audio_neighbors")] public List<SimilarNeighbor> AudioNeighbors { get; set; } = new();
    [JsonPropertyName("text_neighbors")] public List<SimilarNeighbor> TextNeighbors { get; set; } = new();

    /// (section title, neighbors) for non-empty tiers, in display order.
    [JsonIgnore]
    public List<(string Title, List<SimilarNeighbor> Neighbors)> Sections => new (string, List<SimilarNeighbor>)[]
    {
        ("Identical content", IdenticalContent),
        ("Shared files", SharedFiles),
        ("Similar chunks", SimilarChunks),
        ("Same boot imports", ExeImports),
        ("Similar executable", ExeSimilar),
        ("Shared audio tracks", AudioNeighbors),
        ("Semantically related (text)", TextNeighbors),
    }.Where(s => s.Item2.Count > 0).ToList();

    [JsonIgnore]
    public bool IsEmpty => Sections.Count == 0;
}

/// Thrown for non-2xx responses; carries the status code and body for the
/// chunked-upload resume (409) and rate-limit (429) handling.
public sealed class ServiceHttpException : Exception
{
    public int Code { get; }
    public string Body { get; }

    public ServiceHttpException(int code, string body)
        : base(code == 0 ? body.Trim() : $"Server error {code}: {body.Trim()}")
    {
        Code = code;
        Body = body;
    }
}

/// Client for the Prism web service. Base URL from `PRISM_WEB_URL` (default
/// `https://hiddenpalace.org`); optional `PRISM_MODERATION_TOKEN` auto-accepts
/// submits so they replace the live build instead of waiting in the queue.
public sealed class PrismService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(120) };

    public Uri BaseUrl { get; }
    public string? ModerationToken { get; }

    public PrismService()
    {
        var raw = Environment.GetEnvironmentVariable("PRISM_WEB_URL");
        if (string.IsNullOrWhiteSpace(raw))
        {
            raw = "https://hiddenpalace.org";
        }
        BaseUrl = new Uri(raw.TrimEnd('/'));
        var token = Environment.GetEnvironmentVariable("PRISM_MODERATION_TOKEN");
        ModerationToken = string.IsNullOrEmpty(token) ? null : token;
    }

    public Uri BuildPage(string sha256) => new(BaseUrl, $"/build/{sha256}");

    /// POST the canonical record JSON to `/api/similarity`.
    public async Task<SimilarityResponse> FindSimilarAsync(string recordJson)
    {
        var body = await PerformAsync(HttpMethod.Post, "/api/similarity", recordJson, "application/json");
        return JsonSerializer.Deserialize<SimilarityResponse>(body) ?? new SimilarityResponse();
    }

    public sealed record SubmitResult(string Sha256, string Status);

    /// POST `{ nickname, record }` to `/api/submissions`.
    public async Task<SubmitResult> SubmitAsync(string recordJson, string nickname)
    {
        var payload = new JsonObject
        {
            ["nickname"] = nickname,
            ["record"] = JsonNode.Parse(recordJson),
        };
        var body = await PerformAsync(HttpMethod.Post, "/api/submissions", payload.ToJsonString(), "application/json");
        var v = JsonNode.Parse(body);
        return new SubmitResult(
            v?["sha256"]?.GetValue<string>() ?? "",
            v?["status"]?.GetValue<string>() ?? "queued");
    }

    /// Accept a queued submission with the moderation token, replacing the live build.
    public async Task AcceptAsync(string buildSha)
    {
        if (ModerationToken == null)
        {
            return;
        }
        using var req = new HttpRequestMessage(HttpMethod.Post, new Uri(BaseUrl, $"/api/submissions/{buildSha}"));
        req.Content = new StringContent("{\"action\":\"accept\"}", Encoding.UTF8, "application/json");
        req.Headers.Add("x-moderation-token", ModerationToken);
        await SendAsync(req);
    }

    /// GET `/api/submissions/<sha>/assets`: asset blobs the server still lacks.
    public async Task<List<string>> MissingAssetsAsync(string buildSha)
    {
        var body = await PerformAsync(HttpMethod.Get, $"/api/submissions/{buildSha}/assets", null, null);
        var v = JsonNode.Parse(body);
        return v?["missing"]?.AsArray().Select(n => n?.GetValue<string>())
            .Where(s => s != null).Select(s => s!).ToList() ?? new List<string>();
    }

    /// Upload chunk size, small enough to clear typical proxy body-size limits.
    private const int UploadChunkBytes = 4 * 1024 * 1024;

    /// Give up after this many consecutive rate-limit waits on one chunk.
    private const int MaxThrottleRetries = 30;

    /// PUT one asset blob under its build in resumable chunks: each request
    /// appends at `offset`, a 409 answers with the server's staged offset to
    /// resume from, and the final chunk returns `stored` (or `exists`).
    public async Task UploadAssetAsync(string buildSha, string assetSha, string filePath)
    {
        using var file = File.OpenRead(filePath);
        long offset = 0;
        var progress = new UploadProgress(file.Length);
        var throttled = 0;
        var buffer = new byte[UploadChunkBytes];
        while (true)
        {
            file.Seek(offset, SeekOrigin.Begin);
            var read = await file.ReadAsync(buffer.AsMemory(0, UploadChunkBytes));
            if (read == 0)
            {
                // The record claims more bytes than the local blob holds.
                throw new ServiceHttpException(0, "asset blob shorter than its record claims");
            }
            var url = new Uri(BaseUrl, $"/api/submissions/{buildSha}/assets/{assetSha}?offset={offset}");
            using var req = new HttpRequestMessage(HttpMethod.Put, url);
            req.Content = new ByteArrayContent(buffer, 0, read);
            req.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/octet-stream");
            try
            {
                var body = await SendAsync(req);
                var v = JsonNode.Parse(body);
                var status = v?["status"]?.GetValue<string>();
                if (status is "stored" or "exists")
                {
                    return;
                }
                if (status != "partial") throw new ServiceHttpException(0, "invalid upload status");
                offset = progress.Advance(TryField(body, "offset"));
                throttled = 0;
            }
            catch (ServiceHttpException e) when (e.Code == 409)
            {
                offset = progress.Resume(TryField(e.Body, "offset"));
            }
            catch (ServiceHttpException e) when (e.Code == 429)
            {
                // Rate limited. Wait out the window (the server's retryAfter
                // when present) and retry the same offset.
                throttled++;
                if (throttled > MaxThrottleRetries)
                {
                    throw;
                }
                var hint = TryDoubleField(e.Body, "retryAfter") ?? 5.0;
                await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(hint, 1.0, 120.0)));
            }
        }
    }

    private static long? TryField(string json, string name)
    {
        try
        {
            return JsonNode.Parse(json)?[name]?.GetValue<long>();
        }
        catch
        {
            return null;
        }
    }

    private static double? TryDoubleField(string json, string name)
    {
        try
        {
            return JsonNode.Parse(json)?[name]?.GetValue<double>();
        }
        catch
        {
            return null;
        }
    }

    private async Task<string> PerformAsync(HttpMethod method, string path, string? body, string? contentType)
    {
        using var req = new HttpRequestMessage(method, new Uri(BaseUrl, path));
        if (body != null)
        {
            req.Content = new StringContent(body, Encoding.UTF8, contentType ?? "application/json");
        }
        return await SendAsync(req);
    }

    /// Run one request with the shared friendly-error mapping.
    private async Task<string> SendAsync(HttpRequestMessage req)
    {
        HttpResponseMessage resp;
        try
        {
            resp = await Http.SendAsync(req);
        }
        catch (TaskCanceledException)
        {
            throw new ServiceHttpException(0, $"Request to {BaseUrl.Host} timed out. Is the web service responding?");
        }
        catch (HttpRequestException e)
        {
            throw new ServiceHttpException(0, $"Cannot reach {BaseUrl.Host}: {e.Message}");
        }
        using (resp)
        {
            var body = await resp.Content.ReadAsStringAsync();
            if (!resp.IsSuccessStatusCode)
            {
                throw new ServiceHttpException((int)resp.StatusCode, body);
            }
            return body;
        }
    }
}
