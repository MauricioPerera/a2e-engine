// Brings up the engine backend-mock in-process on an internal port (default 3997).
// Seeds the SECRET_TEXT credential the echo piece needs so that, at execution
// time, the engine fetches it over HTTP from this mock and populates context.auth.
//
// Backend selection (drop-in, server.ts unchanged):
//   - DATA_DIR set    -> Durable* file-backed (vault/store/files survive restart)
//   - DATA_DIR unset  -> in-memory Memory* (legacy behavior, retro-compatible)
import type { Server } from 'node:http';
import { Vault } from '../../backend-mock/src/vault.js';
import { MemoryStore } from '../../backend-mock/src/store.js';
import { MemoryFileStore } from '../../backend-mock/src/files.js';
import { DurableVault } from '../../backend-mock/src/durable-vault.js';
import { DurableStore } from '../../backend-mock/src/durable-store.js';
import { DurableFileStore } from '../../backend-mock/src/durable-files.js';
import { createServer } from '../../backend-mock/src/server.js';

export interface MockBackend {
  server: Server;
  port: number;
}

// Module-level holder for the vault so handlers can read REFERENCES (names only,
// never secrets) without a round-trip. Set by startMockBackend; read via getVault.
let vaultInstance: Vault | null = null;

export function getVault(): Vault | null {
  return vaultInstance;
}

export const MOCK_PORT = Number(process.env.MOCK_PORT ?? '3997');
export const ENGINE_TOKEN = process.env.AP_ENGINE_TOKEN ?? 'dev-engine-token';
export const PROJECT_ID = process.env.PROJECT_ID ?? 'demo-project';
// If DATA_DIR is set, the durable (file-backed) backend is used; otherwise the
// in-memory one. Same seeding + createServer in both branches.
const DATA_DIR = process.env.DATA_DIR ?? '';

export function startMockBackend(port: number = MOCK_PORT): Promise<MockBackend> {
  const masterKey = process.env.VAULT_MASTER_KEY ?? 'dev-master-key-16chars';

  let vault: Vault;
  let store: MemoryStore;
  let files: MemoryFileStore;

  if (DATA_DIR) {
    vault = new DurableVault(masterKey, DATA_DIR);
    store = new DurableStore(DATA_DIR);
    files = new DurableFileStore(DATA_DIR);
  } else {
    vault = new Vault(masterKey);
    store = new MemoryStore();
    files = new MemoryFileStore();
  }
  vaultInstance = vault;

  // Credential for the echo piece (externalId === connection name used in /execute).
  // Re-seeding on each boot overwrites with fresh ciphertext; semantically
  // idempotent. In durable mode this is the seed that primes vault.json on the
  // first run; on later runs the file already holds the record.
  vault.put({
    externalId: 'my-echo-conn',
    projectId: PROJECT_ID,
    pieceName: '@automators/piece-echo-auth',
    displayName: 'My Echo Connection',
    value: { type: 'SECRET_TEXT', secret_text: 'sk-test-ABCD1234' },
  });

  const server = createServer({
    vault,
    store,
    files,
    engineToken: ENGINE_TOKEN,
    project: { id: PROJECT_ID, externalId: 'demo-ext' },
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, port }));
  });
}