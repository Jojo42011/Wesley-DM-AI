/**
 * In-process per-key mutex. Callers for the same key queue in FIFO order —
 * a second distinct message is never dropped, it waits for the current turn.
 *
 * The app runs as a single instance (SQLite on a volume), so this in-process
 * queue is the full concurrency story.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}
