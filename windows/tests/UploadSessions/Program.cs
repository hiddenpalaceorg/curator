using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using PrismWin;

using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
var port = ((IPEndPoint)listener.LocalEndpoint).Port;
Environment.SetEnvironmentVariable("PRISM_WEB_URL", $"http://127.0.0.1:{port}");
var tokens = new List<string>();
var server = Task.Run(async () =>
{
    for (var i = 0; i < 4; i++)
    {
        using var connection = await listener.AcceptTcpClientAsync(deadline.Token);
        await using var stream = connection.GetStream();
        var header = new StringBuilder();
        var one = new byte[1];
        while (!header.ToString().EndsWith("\r\n\r\n"))
        {
            if (header.Length >= 8192 || await stream.ReadAsync(one, deadline.Token) != 1) throw new Exception("bad request header");
            header.Append((char)one[0]);
        }
        var lines = header.ToString().Split("\r\n");
        var fields = lines.Skip(1).Where(l => l.Contains(':')).Select(l => l.Split(':', 2))
            .ToDictionary(p => p[0], p => p[1].Trim(), StringComparer.OrdinalIgnoreCase);
        var token = fields["X-Upload-Token"];
        if (!Regex.IsMatch(token, "^[0-9a-f]{32}$")) throw new Exception("missing capability");
        tokens.Add(token);
        var first = i % 2 == 0;
        if (!lines[0].Contains(first ? "offset=0 " : "offset=4194304 ")) throw new Exception("wrong offset");
        var remaining = int.Parse(fields["Content-Length"]);
        var buffer = new byte[65536];
        while (remaining > 0)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, remaining)), deadline.Token);
            if (read == 0) throw new Exception("short request");
            remaining -= read;
        }
        var body = first ? "{\"status\":\"partial\",\"offset\":4194304}" : "{\"status\":\"stored\"}";
        var response = $"HTTP/1.1 {(first ? 202 : 201)} OK\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n{body}";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(response), deadline.Token);
    }
});
var file = Path.GetTempFileName();
try
{
    using (var data = File.OpenWrite(file)) data.SetLength(4 * 1024 * 1024 + 1);
    var service = new PrismService();
    await service.UploadAssetAsync("build", "asset", file);
    await service.UploadAssetAsync("build", "asset", file);
    await server;
    if (tokens[0] != tokens[1] || tokens[2] != tokens[3] || tokens[0] == tokens[2]) throw new Exception("capability lifetime mismatch");
    Console.WriteLine("upload session tests passed");
}
finally { listener.Stop(); File.Delete(file); }
