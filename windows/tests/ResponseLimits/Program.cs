using System.Net;
using System.Text;
using PrismWin;

static void Check(bool result) { if (!result) throw new Exception("response check failed"); }
foreach (var status in new[] { HttpStatusCode.OK, HttpStatusCode.Conflict, HttpStatusCode.TooManyRequests })
{
    using var response = new HttpResponseMessage(status) { Content = new StringContent("test") };
    Check(await PrismService.ReadResponseBodyAsync(response, CancellationToken.None, 4) == "test");
}
foreach (long? reported in new long?[] { null, 1, 100 })
{
    using var response = new HttpResponseMessage(HttpStatusCode.OK);
    var input = new MemoryStream(Encoding.UTF8.GetBytes("oversized"));
    response.Content = new StreamContent(input);
    response.Content.Headers.ContentLength = reported;
    try
    {
        await PrismService.ReadResponseBodyAsync(response, CancellationToken.None, 4);
        throw new Exception("accepted oversized response");
    }
    catch (ServiceHttpException e) { Check(e.Code == 0); }
}
using (var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("zażółć", Encoding.Unicode) })
    Check(await PrismService.ReadResponseBodyAsync(response, CancellationToken.None) == "zażółć");
using (var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[] { 0xef, 0xbb, 0xbf, 0x61 }) })
{
    response.Content.Headers.ContentType = new("text/plain") { CharSet = "iso-8859-1" };
    Check(await PrismService.ReadResponseBodyAsync(response, CancellationToken.None) == "ï»¿a");
}
using (var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new string('a', 100000 * 67)) })
    Check((await PrismService.ReadResponseBodyAsync(response, CancellationToken.None)).Length == 100000 * 67);
using (var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("test") })
{
    using var cancellation = new CancellationTokenSource();
    cancellation.Cancel();
    try
    {
        await PrismService.ReadResponseBodyAsync(response, cancellation.Token);
        throw new Exception("ignored cancellation");
    }
    catch (OperationCanceledException) {}
}
Console.WriteLine("response limit checks passed");
