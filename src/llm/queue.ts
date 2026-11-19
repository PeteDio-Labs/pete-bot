/** A priority queue with a concurrency cap per provider. Lower priority number runs first, then arrival order. */
export class QueueFullError extends Error {
  override name = 'QueueFullError';
}

interface Job<T> {
  priority: number;
  seq: number;
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export class PriorityQueue {
  private waiting: Job<unknown>[] = [];
  private active = 0;
  private seq = 0;
  constructor(private concurrency: number, private maxWaiting = 50) {}

  get depth(): number {
    return this.waiting.length;
  }

  add<T>(priority: number, run: () => Promise<T>): Promise<T> {
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(new QueueFullError(`queue holds ${this.maxWaiting} waiting calls`));
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ priority, seq: this.seq++, run, resolve: resolve as (v: unknown) => void, reject });
      this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.active++;
      job.run().then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }
}
