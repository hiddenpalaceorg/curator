namespace PrismWin;

internal sealed class UploadProgress(long size)
{
    private long offset;
    private int resyncs;

    public long Advance(long? next)
    {
        if (next is not long value || value <= offset || value > size)
            throw new ServiceHttpException(0, "invalid upload progress");
        return offset = value;
    }

    public long Resume(long? next)
    {
        if (next is not long value || value < 0 || value >= size || value == offset || resyncs >= 8)
            throw new ServiceHttpException(0, "invalid upload resume");
        resyncs++;
        return offset = value;
    }
}
