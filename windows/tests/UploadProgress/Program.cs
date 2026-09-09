using PrismWin;

static void Check(bool result) { if (!result) throw new Exception("progress check failed"); }
static void Reject(Action action)
{
    try { action(); }
    catch (ServiceHttpException) { return; }
    throw new Exception("invalid progress accepted");
}
var p = new UploadProgress(10);
Check(p.Advance(4) == 4);
foreach (long? next in new long?[] { null, -1, 0, 3, 4, 11, long.MaxValue })
    Reject(() => p.Advance(next));
for (int i = 0; i < 8; i++) { Check(p.Resume(2) == 2); Check(p.Advance(4) == 4); }
Reject(() => p.Resume(2));
Check(p.Advance(10) == 10);
var q = new UploadProgress(10);
foreach (long? next in new long?[] { null, -1, 0, 10, long.MaxValue })
    Reject(() => q.Resume(next));
for (int i = 0; i < 8; i++) Check(q.Resume(i % 2 + 1) == i % 2 + 1);
Reject(() => q.Resume(1));
Console.WriteLine("upload progress checks passed");
