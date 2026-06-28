import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  Vault,
  type AppConnection,
  type AppConnectionType,
  type AppConnectionValue,
} from './vault.js';

/**
 * SqliteVault: SQLite-backed Vault. Same public API as {@link Vault} (it
 * subclasses it), so server.ts is unchanged. Reuses Vault's EXACT encryption
 * (AES-256-GCM, scrypt-derived key, fixed salt) by inheritance: a record
 * encrypted by a Vault/DurableVault instance decrypts here with the same
 * masterKey, and vice-versa. Only `ciphertext` is ever stored; the plaintext
 * secret never reaches the DB.
 *
 * Durability: records live in table `connections` (PRIMARY KEY projectId,
 * externalId). `put` is an atomic upsert; a fresh process pointing at the same
 * dbPath + masterKey recovers and can decrypt every record. ACID + correct
 * concurrency come from SQLite (WAL); unlike the file-JSON store, concurrent
 * puts are independent row upserts, not a read-modify-write of the whole file.
 */
export class SqliteVault extends Vault {
  private readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly stmtUpsert: StatementSync;
  private readonly stmtSelect: StatementSync;
  private readonly stmtRefs: StatementSync;

  constructor(masterKey: string, dbPath: string) {
    super(masterKey);
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL: readers don't block writers; each txn is still atomic/consistent on commit.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS connections(' +
        'projectId TEXT NOT NULL, externalId TEXT NOT NULL, type TEXT NOT NULL, ' +
        'pieceName TEXT NOT NULL, displayName TEXT NOT NULL, ciphertext TEXT NOT NULL, ' +
        'PRIMARY KEY(projectId, externalId))',
    );
    this.stmtUpsert = this.db.prepare(
      'INSERT INTO connections(projectId, externalId, type, pieceName, displayName, ciphertext) ' +
        'VALUES(?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(projectId, externalId) DO UPDATE SET ' +
        'type = excluded.type, pieceName = excluded.pieceName, ' +
        'displayName = excluded.displayName, ciphertext = excluded.ciphertext',
    );
    this.stmtSelect = this.db.prepare(
      'SELECT type, pieceName, displayName, ciphertext FROM connections ' +
        'WHERE projectId = ? AND externalId = ?',
    );
    this.stmtRefs = this.db.prepare(
      'SELECT externalId, displayName, pieceName, type FROM connections WHERE projectId = ?',
    );
  }

  /** Same signature as Vault.put; atomic upsert of the ciphertext. */
  put(params: {
    externalId: string;
    projectId: string;
    pieceName: string;
    displayName: string;
    value: AppConnectionValue;
  }): void {
    const { externalId, projectId, pieceName, displayName, value } = params;
    const ciphertext = this.encrypt(value);
    this.stmtUpsert.run(projectId, externalId, value.type, pieceName, displayName, ciphertext);
  }

  obtain(projectId: string, externalId: string): AppConnection | null {
    const row = this.stmtSelect.get(projectId, externalId) as
      | { type: AppConnectionType; pieceName: string; displayName: string; ciphertext: string }
      | undefined;
    const ok = !!row;
    // audit stays in-memory, same shape/behavior as Vault.
    this.audit.push({ at: new Date().toISOString(), externalId, projectId, ok });
    if (!row) return null;
    return {
      externalId,
      type: row.type,
      pieceName: row.pieceName,
      displayName: row.displayName,
      projectIds: [projectId],
      status: 'ACTIVE',
      value: this.decrypt(row.ciphertext),
    };
  }

  listReferences(projectId: string): Array<{
    externalId: string;
    displayName: string;
    pieceName: string;
    type: AppConnectionType;
  }> {
    const results: Array<{
      externalId: string;
      displayName: string;
      pieceName: string;
      type: AppConnectionType;
    }> = [];
    // ciphertext is intentionally NOT selected here — only metadata leaves the store.
    for (const row of this.stmtRefs.iterate(projectId) as Iterable<{
      externalId: string;
      displayName: string;
      pieceName: string;
      type: AppConnectionType;
    }>) {
      results.push({
        externalId: row.externalId,
        displayName: row.displayName,
        pieceName: row.pieceName,
        type: row.type,
      });
    }
    return results;
  }
}