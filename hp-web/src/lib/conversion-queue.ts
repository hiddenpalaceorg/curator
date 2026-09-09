/** Shared process-local admission for converter work, before input loading. */
export class ConversionBusy extends Error {
  constructor() { super("conversion queue is busy"); }
}

export function conversionBusyResponse(error: unknown): Response | null {
  return error instanceof ConversionBusy
    ? Response.json({ error: error.message }, { status: 503, headers: { "Retry-After": "30", "Cache-Control": "no-store" } })
    : null;
}

export class ConversionQueue {
  private active = 0;
  private waiting: Array<{ start: () => void }> = [];
  private jobs = new Map<string, Promise<unknown>>();
  constructor(private slots = 2, private maxWaiting = 16, private waitMs = 30_000) {}

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.jobs.get(key);
    if (existing) return existing as Promise<T>;
    if (this.active >= this.slots && this.waiting.length >= this.maxWaiting)
      return Promise.reject(new ConversionBusy());
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.jobs.set(key, promise);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      this.active--;
      this.jobs.delete(key);
      this.waiting.shift()?.start();
    };
    const entry = { start: () => {
      clearTimeout(timer);
      this.active++;
      Promise.resolve().then(work).then(
        value => { finish(); resolve(value); },
        error => { finish(); reject(error); }
      );
    } };
    if (this.active < this.slots) entry.start();
    else {
      this.waiting.push(entry);
      timer = setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        this.jobs.delete(key);
        reject(new ConversionBusy());
      }, this.waitMs);
      timer.unref?.();
    }
    return promise;
  }
}

export const conversions = new ConversionQueue();

// Cards hold decoded images while awaiting leaf converters. Give these
// two parent jobs their own bounded lane so they never occupy the slots
// their children need. Across both lanes at most four jobs hold resources.
export const socialPreviews = new ConversionQueue();

/** Coalesce bytes, not one-shot Response bodies. Admission precedes all
 * image loading and rendering; overload must never cache an incomplete card. */
export async function socialPreviewResponse(key: string, work: () => Promise<ArrayBuffer>): Promise<Response> {
  try {
    const bytes = await socialPreviews.run(key, work);
    return new Response(bytes, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" },
    });
  } catch (error) {
    const busy = conversionBusyResponse(error);
    if (busy) return busy;
    throw error;
  }
}
