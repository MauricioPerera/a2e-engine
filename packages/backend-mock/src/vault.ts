import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export type AppConnectionType =
  | 'SECRET_TEXT'
  | 'BASIC_AUTH'
  | 'CUSTOM_AUTH'
  | 'OAUTH2'
  | 'NO_AUTH';

export type AppConnectionValue =
  | { type: 'SECRET_TEXT'; secret_text: string }
  | { type: 'BASIC_AUTH'; username: string; password: string }
  | { type: 'CUSTOM_AUTH'; props: Record<string, unknown> }
  | { type: 'NO_AUTH' };

export interface AppConnection {
  externalId: string;
  type: AppConnectionType;
  pieceName: string;
  displayName: string;
  projectIds: string[];
  status: 'ACTIVE' | 'MISSING' | 'ERROR';
  value: AppConnectionValue;
}

export interface AuditEntry {
  at: string;
  externalId: string;
  projectId: string;
  ok: boolean;
}

export interface EncryptedRecord {
  externalId: string;
  projectId: string;
  type: AppConnectionType;
  pieceName: string;
  displayName: string;
  ciphertext: string;
}

export class Vault {
  readonly audit: AuditEntry[] = [];
  private records: Map<string, EncryptedRecord> = new Map();
  private readonly key: Buffer;

  constructor(masterKey: string) {
    if (!masterKey || masterKey.length < 16) {
      throw new Error('Master key must be at least 16 characters long');
    }
    this.key = scryptSync(masterKey, 'okf-motor-vault-salt', 32);
  }

  put(params: {
    externalId: string;
    projectId: string;
    pieceName: string;
    displayName: string;
    value: AppConnectionValue;
  }): void {
    const { externalId, projectId, pieceName, displayName, value } = params;
    const ciphertext = this.encrypt(value);
    const key = this.recordKey(projectId, externalId);
    this.records.set(key, {
      externalId,
      projectId,
      type: value.type,
      pieceName,
      displayName,
      ciphertext,
    });
  }

  obtain(projectId: string, externalId: string): AppConnection | null {
    const key = this.recordKey(projectId, externalId);
    const record = this.records.get(key);
    const ok = !!record;
    this.audit.push({ at: new Date().toISOString(), externalId, projectId, ok });

    if (!record) return null;

    return {
      externalId: record.externalId,
      type: record.type,
      pieceName: record.pieceName,
      displayName: record.displayName,
      projectIds: [projectId],
      status: 'ACTIVE',
      value: this.decrypt(record.ciphertext),
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

    for (const record of this.records.values()) {
      if (record.projectId === projectId) {
        results.push({
          externalId: record.externalId,
          displayName: record.displayName,
          pieceName: record.pieceName,
          type: record.type,
        });
      }
    }

    return results;
  }

  private recordKey(projectId: string, externalId: string): string {
    return `${projectId}::${externalId}`;
  }

  private encrypt(value: AppConnectionValue): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${data.toString('hex')}`;
  }

  private decrypt(ciphertext: string): AppConnectionValue {
    const [ivHex, authTagHex, dataHex] = ciphertext.split(':');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const data = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return JSON.parse(data.toString());
  }
}