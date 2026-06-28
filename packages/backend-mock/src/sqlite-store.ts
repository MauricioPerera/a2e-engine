import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MemoryStore, type StoreEntry } from './store.js';

/**
 * SqliteStore: SQLite-backed key/value store. Same public API as
 * {@link MemoryStore} (it subclasses it), so server.ts is unchanged.
 *
 * Entries are persisted in table `store(key TEXT PRIMARY KEY, value TEXT)`
 * as JSON; a fresh process pointing at the same dbPath recovers every entry.
 * ACID + correct concurrency come from SQLite (WAL): each put/delete is an
 * independent row operation, so concurrent puts never corrupt each other
 * (the failure mode of the file-JSON store, which read-modify-wrote the whole
 * file). The inherited `entries` Map is left unused — disk is the source of
 * truth.
 */
export class SqliteStore extends MemoryStore {
  private readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly stmtPut: StatementSync;
  private readonly stmtGet: StatementSync;
  private readonly stmtDel: StatementSync;

  constructor(dbPath: string) {
    super();
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS store(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.stmtPut = this.db.prepare(
      'INSERT INTO store(key, value) VALUES(?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.stmtGet = this.db.prepare('SELECT value FROM store WHERE key = ?');
    this.stmtDel = this.db.prepare('DELETE FROM store WHERE key = ?');
  }

  /** Store/replace a value (JSON) and return the resulting entry. */
  put(key: string, value: unknown): StoreEntry {
    this.stmtPut.run(key, JSON.stringify(value));
    return { key, value };
  }

  /** Return the entry for a key, or null if absent. */
  get(key: string): StoreEntry | null {
    const row = this.stmtGet.get(key) as { value: string } | undefined;
    if (!row) return null;
    return { key, value: JSON.parse(row.value) };
  }

  /** Remove a key; idempotent (no-op if the key is not present). */
  delete(key: string): void {
    this.stmtDel.run(key);
  }
}