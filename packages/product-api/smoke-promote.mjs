// smoke-promote.mjs — e2e de la PROMOCION DE CATALOGO.
//
// Arranca product-api con ADMIN_TOKEN + PROMOTED_PIECES_DIR + un full-catalog y
// catalog-summary TEMPORALES (vacios al inicio), crea una piece REAL de prueba
// (scope NO-@activepieces: @promotest/piece-echo) en un source temporal, y:
//   (a) POST /admin/promote SIN token  -> 401 (gate admin).
//   (b) POST /admin/promote CON token -> promoted incluye la piece con findings.
//   (c) GET /catalog/pieces?q=echo     -> la piece promovida aparece (nivel 1).
//   (d) POST /execute (1 step echo)    -> SUCCEEDED + output { echoed: <text> }.
//
// Muestra el JSON real de cada paso. Mata todo al final.
// Muestra el JSON real de cada paso. Mata todo al final.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'promote-smoke-'));
const sourceDir = path.join(TMP, 'source');
const promotedDir = path.join(TMP, 'promoted');
const fullCatalogDir = path.join(TMP, 'full-catalog');
const catalogSummaryPath = path.join(TMP, 'catalog-summary.json');
mkdirSync(path.join(sourceDir, 'packages/pieces/community/piece-echo/src'), { recursive: true });
mkdirSync(promotedDir, { recursive: true });
mkdirSync(fullCatalogDir, { recursive: true });

// piece REAL de prueba: scope @promotest (NO @activepieces) -> ejerce multi-scope.
writeFileSync(path.join(sourceDir, 'packages/pieces/community/piece-echo/package.json'), JSON.stringify({
  name: '@promotest/piece-echo', version: '0.1.0', main: './dist/src/index.js',
  dependencies: { '@activepieces/pieces-framework': 'workspace:*' },
}, null, 2));
writeFileSync(path.join(sourceDir, 'packages/pieces/community/piece-echo/src/index.ts'),
`import { createPiece, PieceAuth, createAction, Property } from "@activepieces/pieces-framework";

export const echo = createAction({
  name: "echo",
  displayName: "Echo",
  description: "Echoes the provided text back as { echoed: text }.",
  props: {
    text: Property.ShortText({ displayName: "Text", description: "Text to echo back.", required: true }),
  },
  run: async (ctx) => ({ echoed: ctx.propsValue.text }),
});

export const piece = createPiece({
  displayName: "Echo Promote Test",
  description: "Deterministic echo piece used to verify catalog promotion end-to-end.",
  auth: PieceAuth.None(),
  minimumSupportedRelease: "0.30.0",
  actions: [echo],
  triggers: [],
});
`);

const ADMIN_TOKEN = 'promote-admin-token';
process.env.ADMIN_TOKEN = ADMIN_TOKEN;
process.env.PROMOTED_PIECES_DIR = promotedDir;     // index.ts lo añade a AP_CUSTOM_PIECES_PATHS
process.env.FULL_CATALOG_DIR = fullCatalogDir;     // handler lee OKF de aqui
process.env.CATALOG_SUMMARY = catalogSummaryPath;  // handler lee summary de aqui
process.env.T2_SANDBOX = '0';                       // build in-process (pieces confiables de prueba)
// index.ts captura PROMOTED_PIECES / PRODUCT_PORT como top-level const al IMPORTAR,
// asi que el env debe estar seteado ANTES del import. Import dinamico post-env.
// En produccion el env se setea antes de arrancar el proceso (mismo efecto).
const { start, PRODUCT_PORT } = await import('./src/index.ts');

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed = true;
};

const app = await start();
try {
  await new Promise((r) => setTimeout(r, 150));
  console.log(`# product-api on ${BASE} (promoted=${promotedDir})`);

  // (a) promote SIN token -> 401
  console.log('\n=== (a) POST /admin/promote SIN token ===');
  const ra = await fetch(`${BASE}/admin/promote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceDir, pieces: ['@promotest/piece-echo'] }),
  });
  const ba = await ra.json().catch(() => null);
  console.log('status:', ra.status, 'body:', JSON.stringify(ba));
  ok('promote sin token -> 401', ra.status === 401, `(status ${ra.status})`);

  // (b) promote CON token -> promoted incluye la piece
  console.log('\n=== (b) POST /admin/promote CON token ===');
  const rb = await fetch(`${BASE}/admin/promote`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify({ sourceDir, pieces: ['@promotest/piece-echo'] }),
  });
  const bb = await rb.json().catch(() => null);
  console.log('status:', rb.status);
  console.log('body:', JSON.stringify(bb, null, 2));
  ok('promote con token -> 200', rb.status === 200, `(status ${rb.status})`);
  const promoted = Array.isArray(bb?.promoted) ? bb.promoted : [];
  const echoP = promoted.find((p) => p.name === '@promotest/piece-echo');
  ok('promoted incluye @promotest/piece-echo', !!echoP, JSON.stringify(promoted.map((p) => p.name)));
  ok('version 0.1.0', echoP?.version === '0.1.0', `(${echoP?.version})`);
  ok('promote trae findings (no-manifest warn)', Array.isArray(echoP?.findings) && echoP.findings.some((f) => f.code === 'no-manifest'), JSON.stringify(echoP?.findings));
  ok('rejected vacio', Array.isArray(bb?.rejected) && bb.rejected.length === 0, JSON.stringify(bb?.rejected));

  // artefactos en disco: bundle en promotedDir + OKF en fullCatalogDir
  ok('bundle index.cjs en promotedDir', existsSync(path.join(promotedDir, 'pieces/@promotest/piece-echo-0.1.0/node_modules/@promotest/piece-echo/index.cjs')));
  ok('OKF index.md en fullCatalogDir', existsSync(path.join(fullCatalogDir, '@promotest/piece-echo/index.md')));
  ok('catalog-summary.json reconstruido', existsSync(catalogSummaryPath));

  // (c) retrieve nivel 1 -> la piece promovida aparece
  console.log('\n=== (c) GET /catalog/pieces?q=echo ===');
  const rc = await fetch(`${BASE}/catalog/pieces?q=${encodeURIComponent('echo')}&budget=4000`);
  const bc = await rc.json().catch(() => null);
  console.log('status:', rc.status);
  console.log('body:', JSON.stringify(bc, null, 2));
  ok('retrieve nivel 1 -> 200', rc.status === 200, `(status ${rc.status})`);
  ok('retrieve incluye @promotest/piece-echo', Array.isArray(bc?.included) && bc.included.includes('@promotest/piece-echo'), JSON.stringify(bc?.included));

  // (d) execute 1 step echo -> SUCCEEDED + output
  console.log('\n=== (d) POST /execute (echo) ===');
  const rd = await fetch(`${BASE}/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      steps: [{
        name: 's1', pieceName: '@promotest/piece-echo', pieceVersion: '0.1.0',
        actionName: 'echo', input: { text: 'hello-promote' },
      }],
    }),
  });
  const bd = await rd.json().catch(() => null);
  console.log('status:', rd.status);
  console.log('body:', JSON.stringify(bd, null, 2));
  ok('execute -> 200', rd.status === 200, `(status ${rd.status})`);
  ok('execute status SUCCEEDED', bd?.status === 'SUCCEEDED', `(got ${bd?.status})`);
  ok('execute output {echoed:"hello-promote"}', bd?.output && bd.output.echoed === 'hello-promote', JSON.stringify(bd?.output));
} finally {
  await app.close();
  rmSync(TMP, { recursive: true, force: true });
  console.log('\ntemps limpiados');
  console.log(failed ? '\n=== SMOKE-PROMOTE FAILED ===' : '\n=== SMOKE-PROMOTE PASSED ===');
  process.exit(failed ? 1 : 0);
}