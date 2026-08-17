import path from "node:path";
import type { Store } from "./types.js";
import { MemoryStore } from "./memory.js";
import { SqliteStore } from "./sqlite.js";

/**
 * Store factory. Production uses SQLite persisted on a mounted volume
 * (SQLITE_PATH, e.g. /data/wesley.db on Fly). Set STORE=memory for an
 * ephemeral in-memory store (tests / throwaway local runs only).
 */
export async function createStore(): Promise<Store> {
  if (process.env.STORE === "memory") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("STORE=memory is not allowed in production — data would be lost on restart.");
    }
    return new MemoryStore();
  }
  const file = process.env.SQLITE_PATH ?? path.resolve("data", "wesley.db");
  return new SqliteStore(file);
}

export type { Store } from "./types.js";
