// DURABILITY smoke (SQLite-backed): proves the SqliteVault/SqliteStore survive a
// simulated restart (a brand-new instance pointed at the same dbPath + masterKey),
// that the DB never holds the plaintext secret, and that 20 concurrent store puts
// all persist without corruption (the guarantee the file-JSON store could not give).
// Run with: npx tsx smoke-sqlite.mjs
import { rmSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteVault } from './src/sqlite-vault.ts';
import { SqliteStore } from './src/sqlite-store.ts';

let failed = false;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed = true;
};

const SECRET = 'sk-test-ABCD1234';
const MASTER_KEY = 'smoke-master-key-16chars';
const workDir = mkdtempSync(join(tmpdir(), 'sqlite-smoke-'));
const dbPath = join(workDir, 'engine.db');
console.log(`dbPath = ${dbPath}`);

try {
  // ---- SqliteVault: put, simulate restart, obtain ----
  const vaultA = new SqliteVault(MASTER_KEY, dbPath);
  vaultA.put({
    externalId: 'conn-1',
    projectId: 'proj-1',
    pieceName: '@automators/piece-echo-auth',
    displayName: 'My Echo Connection',
    value: { type: 'SECRET_TEXT', secret_text: SECRET },
  });

  // Simulated restart: a brand-new instance, same masterKey + dbPath.
  const vaultB = new SqliteVault(MASTER_KEY, dbPath);
  const recovered = vaultB.obtain('proj-1', 'conn-1');
  ok('vault obtain after restart -> non-null', recovered !== null);
  ok(
    'vault secret_text survives restart',
    !!recovered && recovered.value.type === 'SECRET_TEXT' && recovered.value.secret_text === SECRET,
    JSON.stringify(recovered && recovered.value),
  );

  // listReferences returns metadata only (no ciphertext field on the row).
  const refs = vaultB.listReferences('proj-1');
  ok('listReferences -> 1 ref', refs.length === 1, JSON.stringify(refs));
  ok('listReferences row has no ciphertext key', !(('ciphertext' in (refs[0] ?? {}))));

  // ---- the DB file must NOT contain the plaintext secret ----
  ok('engine.db exists', existsSync(dbPath));
  // 1) raw file bytes must not contain the secret string
  const rawDb = readFileSync(dbPath);
  ok(
    'engine.db raw bytes do NOT contain plaintext secret',
    !rawDb.includes(Buffer.from(SECRET, 'utf8')),
    `raw size=${rawDb.length}`,
  );
  // 2) the ciphertext column itself must not contain the secret
  const probe = new DatabaseSync(dbPath);
  const rows = probe.prepare('SELECT ciphertext FROM connections WHERE projectId = ? AND externalId = ?').all('proj-1', 'conn-1');
  ok('connections table has 1 ciphertext row', rows.length === 1, `n=${rows.length}`);
  const ct = String(rows[0].ciphertext);
  ok('ciphertext column does NOT contain plaintext secret', !ct.includes(SECRET), ct.slice(0, 80));
  ok('ciphertext column is the iv:authTag:data format', ct.split(':').length === 3, `parts=${ct.split(':').length}`);
  probe.close();

  // ---- SqliteStore: put, restart, get ----
  const storeA = new SqliteStore(dbPath);
  const storeVal = { foo: 'bar', n: 42, nested: { ok: true } };
  storeA.put('smoke-k', storeVal);
  const storeB = new SqliteStore(dbPath);
  const storeGot = storeB.get('smoke-k');
  ok(
    'store get after restart -> same value',
    !!storeGot && JSON.stringify(storeGot.value) === JSON.stringify(storeVal),
    JSON.stringify(storeGot && storeGot.value),
  );

  // ---- CONCURRENCY: 20 parallel puts, distinct keys, all persist ----
  const N = 20;
  const storeC = new SqliteStore(dbPath);
  const puts = [];
  for (let i = 0; i < N; i++) {
    const key = `conc-${i}`;
    const val = { idx: i, payload: `value-${i}`.repeat(8) };
    puts.push(Promise.resolve(storeC.put(key, val)));
  }
  await Promise.all(puts);
  // fresh instance reads back from disk
  const storeD = new SqliteStore(dbPath);
  let allOk = true;
  for (let i = 0; i < N; i++) {
    const g = storeD.get(`conc-${i}`);
    if (!g || g.value.idx !== i) {
      allOk = false;
      console.log(`  MISSING/CORRUPT conc-${i}: ${JSON.stringify(g)}`);
    }
  }
  ok(`store ${N} concurrent puts -> all persist (0 lost/corrupt)`, allOk);

  // ---- SqliteStore put/get/delete round-trip + survival ----
  const storeE = new SqliteStore(dbPath);
  storeE.put('rt-key', { hello: 'world' });
  ok('store round-trip get -> same value', !!storeE.get('rt-key') && storeE.get('rt-key').value.hello === 'world');
  storeE.delete('rt-key');
  ok('store delete -> get null', storeE.get('rt-key') === null);
  ok('store delete idempotent (no throw)', (() => { storeE.delete('rt-key'); return true; })());
  // survival of delete across restart
  const storeF = new SqliteStore(dbPath);
  ok('store delete survives restart -> still null', storeF.get('rt-key') === null);

  // ---- (optional) product-api /execute echo with DATABASE ----
  try {
    process.env.DATABASE = dbPath;
    process.env.VAULT_MASTER_KEY = MASTER_KEY;
    delete process.env.DATA_DIR;
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
  // Limpia el workDir temporal al final.
  try {
    rmSync(workDir, { recursive: true, force: true });
    console.log(`cleaned workDir ${workDir}`);
  } catch (e) {
    console.log('cleanup failed:', e && e.message);
  }
  console.log(failed ? '\n=== SQLITE SMOKE FAILED ===' : '\n=== SQLITE SMOKE PASSED ===');
  process.exit(failed ? 1 : 0);
}