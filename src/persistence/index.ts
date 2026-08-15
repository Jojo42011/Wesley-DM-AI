import type { Store } from "./types.js";
import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";

/**
 * Store factory. Production requires DATABASE_URL (PostgreSQL). The
 * in-memory store is only for tests and local development — it is never a
 * production source of truth.
 */
export async function createStore(): Promise<Store> {
  const url = process.env.DATABASE_URL;
  if (url) {
    return PostgresStore.connect(url);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is required in production. The in-memory store is not a production source of truth.",
    );
  }
  return new MemoryStore();
}

export type { Store } from "./types.js";
