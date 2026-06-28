import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore, type StoreEntry } from './store.js';

/**
 * DurableStore: file-backed key/value store. Same public API as
 * {@link MemoryStore} (it subclasses it), so server.ts is unchanged.
 *
 * Entries are persisted to `<dataDir>/store.json` after every put/delete and
 * loaded in the constructor. A fresh process pointing at the same dataDir
 * recovers every entry.
 */
export class DurableStore extends MemoryStore {
  private readonly dataDir: string;
  private readonly storeFile: string;

  constructor(dataDir: string) {
    super();
    this.dataDir = dataDir;
    this.storeFile = join(dataDir, 'store.json');
    this.ensureDir();
    this.load();
  }

  put(key: string, value: unknown): StoreEntry {
    const entry = super.put(key, value);
    this.persist();
    return entry;
  }

  delete(key: string): void {
    super.delete(key);
    this.persist();
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
    } catch {
      // ignore; persist() will surface write errors
    }
  }

  private load(): void {
    if (!existsSync(this.storeFile)) return;
    let raw: string;
    try {
      raw = readFileSync(this.storeFile, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt JSON -> start empty (no crash)
    }
    if (!Array.isArray(parsed)) return;
    for (const item of parsed as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const { key, value } = item as { key?: unknown; value?: unknown };
      if (typeof key === 'string') {
        this.entries.set(key, value);
      }
    }
  }

  private persist(): void {
    const payload = JSON.stringify(
      Array.from(this.entries.entries()).map(([key, value]) => ({ key, value })),
    );
    const tmp = `${this.storeFile}.tmp`;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, this.storeFile);
  }
}