// DURABILITY smoke (file-backed): proves vault/store/files SURVIVE a simulated
// restart (a brand-new instance pointed at the same dataDir + masterKey), and
// that vault.json never holds the plaintext secret. Run with: npx tsx smoke-durable.mjs
import { rmSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { DurableVault } from './src/durable-vault.ts';
import { DurableStore } from './src/durable-store.ts';
import { DurableFileStore } from './src/durable-files.ts';

let failed = false;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed = true;
};

const SECRET = 'sk-test-ABCD1234';
const MASTER_KEY = 'smoke-master-key-16chars';
const dataDir = mkdtempSync(join(tmpdir(), 'durable-smoke-'));
console.log(`dataDir = ${dataDir}`);

try {
  // ---- DurableVault: put, simulate restart, obtain ----
  const vaultA = new DurableVault(MASTER_KEY, dataDir);
  vaultA.put({
    externalId: 'conn-1',
    projectId: 'proj-1',
    pieceName: '@automators/piece-echo-auth',
    displayName: 'My Echo Connection',
    value: { type: 'SECRET_TEXT', secret_text: SECRET },
  });

  // Simulated restart: a brand-new instance, same masterKey + dataDir.
  const vaultB = new DurableVault(MASTER_KEY, dataDir);
  const recovered = vaultB.obtain('proj-1', 'conn-1');
  ok('vault obtain after restart -> non-null', recovered !== null);
  ok(
    'vault secret_text survives restart',
    !!recovered && recovered.value.type === 'SECRET_TEXT' && recovered.value.secret_text === SECRET,
    JSON.stringify(recovered && recovered.value),
  );

  // ---- vault.json must NOT contain the plaintext secret ----
  const vaultJsonPath = join(dataDir, 'vault.json');
  ok('vault.json exists', existsSync(vaultJsonPath));
  const vaultJson = readFileSync(vaultJsonPath, 'utf8');
  ok('vault.json contains ciphertext field', /"ciphertext"/.test(vaultJson));
  ok(
    'vault.json does NOT contain plaintext secret (no cleartext)',
    !vaultJson.includes(SECRET),
    vaultJson.slice(0, 120),
  );

  // ---- DurableStore: put, restart, get ----
  const storeA = new DurableStore(dataDir);
  const storeVal = { foo: 'bar', n: 42, nested: { ok: true } };
  storeA.put('smoke-k', storeVal);
  const storeB = new DurableStore(dataDir);
  const storeGot = storeB.get('smoke-k');
  ok(
    'store get after restart -> same value',
    !!storeGot && JSON.stringify(storeGot.value) === JSON.stringify(storeVal),
    JSON.stringify(storeGot && storeGot.value),
  );

  // ---- DurableFileStore: put bytes, restart, get same bytes ----
  const filesA = new DurableFileStore(dataDir);
  const bytes = Buffer.from([0, 1, 2, 3, 128, 255, 0, 7]);
  filesA.put('smoke-f', bytes);
  const filesB = new DurableFileStore(dataDir);
  const gotBytes = filesB.get('smoke-f');
  ok('files get after restart -> non-null', gotBytes !== null);
  ok(
    'files bytes survive restart',
    !!gotBytes && Buffer.from(gotBytes).equals(bytes),
    `len=${gotBytes && gotBytes.length}`,
  );
  ok('files has(smoke-f) after restart -> true', filesB.has('smoke-f') === true);
  ok('files has(missing) -> false', filesB.has('missing') === false);

  // ---- (optional) product-api /execute echo with DATA_DIR ----
  try {
    process.env.DATA_DIR = dataDir;
    process.env.VAULT_MASTER_KEY = MASTER_KEY;
    const { start, PRODUCT_PORT } = await import('./../product-api/src/index.ts');
    const BASE = `http://localhost:${PRODUCT_PORT}`;
    const app = await start();
    try {
      const r = await fetch(`${BASE}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          steps: [
            {
              name: 'whoami',
              pieceName: '@automators/piece-echo-auth',
              pieceVersion: '0.1.0',
              actionName: 'whoami',
              connection: { name: 'my-echo-conn' },
            },
          ],
        }),
      });
      const b = await r.json();
      console.log('execute(echo) ->', JSON.stringify(b));
      ok('[optional] execute echo -> 200', r.status === 200, `(status ${r.status})`);
      ok(
        '[optional] execute echo SUCCEEDED + apiKeyTail 1234',
        b.status === 'SUCCEEDED' && b.output && b.output.apiKeyTail === '1234',
        JSON.stringify(b),
      );
    } finally {
      await app.close();
    }
  } catch (e) {
    console.log('[optional] product-api execute skipped/failed:', e && e.message);
  }
} finally {
  // Limpia el dataDir temporal al final.
  try {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`cleaned dataDir ${dataDir}`);
  } catch (e) {
    console.log('cleanup failed:', e && e.message);
  }
  console.log(failed ? '\n=== DURABLE SMOKE FAILED ===' : '\n=== DURABLE SMOKE PASSED ===');
  process.exit(failed ? 1 : 0);
}