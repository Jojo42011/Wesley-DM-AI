/**
 * In-process per-key mutex. Callers for the same key queue in FIFO order —
 * a second distinct message is never dropped, it waits for the current turn.
 *
 * For multi-instance deployments the Postgres store additionally takes a
 * pg advisory lock inside this local queue, so instances serialize too.
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
