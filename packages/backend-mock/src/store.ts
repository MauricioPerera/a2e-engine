/**
 * MemoryStore: in-memory key/value store backed by a Map.
 *
 * The key is treated as opaque: it is used as-is as the Map key and not
 * interpreted or transformed. The value is arbitrary JSON-shaped data; it
 * is not validated. `delete` is idempotent (no-op if the key is absent).
 */
export type StoreEntry = { key: string; value: unknown };

export class MemoryStore {
  private readonly entries = new Map<string, unknown>();

  /** Store/replace a value and return the resulting entry. */
  put(key: string, value: unknown): StoreEntry {
    this.entries.set(key, value);
    return { key, value };
  }

  /** Return the entry for a key, or null if absent. */
  get(key: string): StoreEntry | null {
    if (!this.entries.has(key)) return null;
    return { key, value: this.entries.get(key) };
  }

  /** Remove a key; idempotent (no-op if the key is not present). */
  delete(key: string): void {
    this.entries.delete(key);
  }
}