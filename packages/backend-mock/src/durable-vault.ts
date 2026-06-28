import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Vault, type EncryptedRecord } from './vault.js';

/**
 * DurableVault: file-backed Vault. Same public API as {@link Vault} (it
 * subclasses it), so server.ts is unchanged. Reuses Vault's exact encryption
 * (AES-256-GCM, scrypt-derived key, fixed salt) by inheritance — a record
 * encrypted by a {@link Vault} instance decrypts here with the same masterKey,
 * and vice-versa.
 *
 * The EncryptedRecord array (ciphertext only, NEVER the plaintext secret) is
 * persisted to `<dataDir>/vault.json` after every put, and loaded in the
 * constructor. A fresh process pointing at the same dataDir + masterKey
 * therefore recovers every record and can decrypt it — that is the
 * durability guarantee.
 */
export class DurableVault extends Vault {
  private readonly dataDir: string;
  private readonly vaultFile: string;

  constructor(masterKey: string, dataDir: string) {
    super(masterKey);
    this.dataDir = dataDir;
    this.vaultFile = join(dataDir, 'vault.json');
    this.ensureDir();
    this.load();
  }

  /** Same signature as Vault.put; persists after the in-memory write. */
  put(params: {
    externalId: string;
    projectId: string;
    pieceName: string;
    displayName: string;
    value: import('./vault.js').AppConnectionValue;
  }): void {
    super.put(params);
    this.persist();
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
    } catch {
      // If the dir cannot be created we keep operating in-memory; the caller
      // will see write failures surface as thrown errors on persist.
    }
  }

  private load(): void {
    if (!existsSync(this.vaultFile)) return;
    let raw: string;
    try {
      raw = readFileSync(this.vaultFile, 'utf8');
    } catch {
      return; // unreadable file -> start empty rather than crash
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // corrupt JSON -> start empty (no crash)
    }
    if (!Array.isArray(parsed)) return;
    for (const rec of parsed as unknown[]) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as EncryptedRecord;
      if (
        typeof r.externalId === 'string' &&
        typeof r.projectId === 'string' &&
        typeof r.ciphertext === 'string'
      ) {
        const key = `${r.projectId}::${r.externalId}`;
        this.records.set(key, r);
      }
    }
  }

  private persist(): void {
    const payload = JSON.stringify(Array.from(this.records.values()));
    const tmp = `${this.vaultFile}.tmp`;
    writeFileSync(tmp, payload, 'utf8');
    // atomic-ish: rename tmp -> vault.json so a crash mid-write never leaves a
    // truncated vault.json (same filesystem => rename is atomic on ext4).
    renameSync(tmp, this.vaultFile);
  }
}