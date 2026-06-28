import { Buffer } from 'node:buffer';

/** In-memory store for engine file blobs (v1/files endpoints). */
export class MemoryFileStore {
  private readonly files = new Map<string, Buffer>();

  put(fileId: string, data: Buffer): void {
    this.files.set(fileId, Buffer.from(data));
  }

  get(fileId: string): Buffer | null {
    return this.files.get(fileId) ?? null;
  }

  has(fileId: string): boolean {
    return this.files.has(fileId);
  }
}