import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { MemoryFileStore } from './files.js';

/**
 * DurableFileStore: file-backed blob store. Same public API as
 * {@link MemoryFileStore} (it subclasses it), so server.ts is unchanged.
 *
 * Each blob is persisted as a single file under `<dataDir>/files/` keyed by a
 * deterministic, filesystem-safe encoding of the fileId (base64url of the UTF-8
 * fileId: collision-free and reversible-in-spirit, no path traversal possible
 * since the encoded name only contains [A-Za-z0-9_-]). A fresh process pointing
 * at the same dataDir recovers every blob.
 */
export class DurableFileStore extends MemoryFileStore {
  private readonly filesDir: string;

  constructor(dataDir: string) {
    super();
    this.filesDir = join(dataDir, 'files');
    try {
      mkdirSync(this.filesDir, { recursive: true });
    } catch {
      // ignore; write errors surface on put
    }
  }

  put(fileId: string, data: Buffer): void {
    // Keep the in-memory cache in sync (harmless) but disk is the source of
    // truth across restarts.
    super.put(fileId, data);
    const buf = Buffer.from(data);
    writeFileSync(this.pathFor(fileId), buf);
  }

  get(fileId: string): Buffer | null {
    const p = this.pathFor(fileId);
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  }

  has(fileId: string): boolean {
    return existsSync(this.pathFor(fileId));
  }

  private pathFor(fileId: string): string {
    // base64url: deterministic, no path separators, no collision with other ids.
    const encoded = Buffer.from(fileId, 'utf8').toString('base64url');
    return join(this.filesDir, encoded);
  }
}