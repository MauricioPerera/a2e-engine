// smoke-retrieve.mjs — e2e del provider okf_catalog (GET /catalog/retrieve).
// Arranca product-api (con mock backend), lanza 3 queries reales contra el
// endpoint y comprueba: query relevante trae pieces pertinentes DENTRO del
// budget; budget bajo recorta (omitted>0, menos pieces); query sin match ->
// included vacío. Mata todo al final.
import { start, PRODUCT_PORT } from './src/index.ts';

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed = true;
};

async function getRetrieve(q, budget, mode) {
  const params = new URLSearchParams({ q });
  if (budget !== undefined) params.set('budget', String(budget));
  if (mode) params.set('mode', mode);
  const res = await fetch(`${BASE}/catalog/retrieve?${params.toString()}`);
  const body = await res.json();
  return { status: res.status, body };
}

const app = await start();
try {
  // 0) sanity: /catalog sigue vivo (no-regresión rápida)
  const cat = await fetch(`${BASE}/catalog`);
  ok('no-regression GET /catalog -> 200', cat.status === 200, `(status ${cat.status})`);

  // 1) query relevante, budget alto (modo index)
  const q1 = 'slack message';
  const r1 = await getRetrieve(q1, 4000, 'index');
  console.log('\n--- query 1: q="slack message" budget=4000 mode=index ---');
  console.log('status:', r1.status);
  console.log('included:', JSON.stringify(r1.body.included));
  console.log('estimatedTokens:', r1.body.estimatedTokens, 'total:', r1.body.total, 'omitted:', r1.body.omitted);
  ok('q1 -> 200', r1.status === 200);
  ok('q1 includes slack', Array.isArray(r1.body.included) && r1.body.included.some((n) => n.includes('piece-slack')));
  ok('q1 estimatedTokens <= budget', r1.body.estimatedTokens <= 4000, `(${r1.body.estimatedTokens} <= 4000)`);
  ok('q1 total > 0', r1.body.total > 0, `(total=${r1.body.total})`);

  // 2) misma query, budget BAJO -> recorta
  const r2 = await getRetrieve('slack message', 300, 'index');
  console.log('\n--- query 2: q="slack message" budget=300 mode=index ---');
  console.log('status:', r2.status);
  console.log('included:', JSON.stringify(r2.body.included));
  console.log('estimatedTokens:', r2.body.estimatedTokens, 'total:', r2.body.total, 'omitted:', r2.body.omitted);
  ok('q2 -> 200', r2.status === 200);
  ok('q2 estimatedTokens <= 300', r2.body.estimatedTokens <= 300, `(${r2.body.estimatedTokens} <= 300)`);
  ok('q2 omitted > 0', r2.body.omitted > 0, `(omitted=${r2.body.omitted})`);
  ok('q2 fewer-or-equal included than q1', r2.body.included.length <= r1.body.included.length, `(${r2.body.included.length} <= ${r1.body.included.length})`);

  // 3) query sin match -> included vacío
  const r3 = await getRetrieve('zzzznomatchxyzzy', 4000, 'index');
  console.log('\n--- query 3: q="zzzznomatchxyzzy" budget=4000 mode=index ---');
  console.log('status:', r3.status);
  console.log('included:', JSON.stringify(r3.body.included));
  console.log('estimatedTokens:', r3.body.estimatedTokens, 'total:', r3.body.total, 'omitted:', r3.body.omitted);
  ok('q3 -> 200', r3.status === 200);
  ok('q3 included empty', Array.isArray(r3.body.included) && r3.body.included.length === 0);
  ok('q3 total == 0', r3.body.total === 0, `(total=${r3.body.total})`);

  // 4) modo detail trae contexto con actions
  const r4 = await getRetrieve('slack message', 4000, 'detail');
  console.log('\n--- query 4: q="slack message" budget=4000 mode=detail ---');
  console.log('status:', r4.status);
  console.log('included:', JSON.stringify(r4.body.included));
  console.log('estimatedTokens:', r4.body.estimatedTokens, 'total:', r4.body.total, 'omitted:', r4.body.omitted);
  console.log('context head (200 chars):', r4.body.context.slice(0, 200));
  ok('q4 -> 200', r4.status === 200);
  ok('q4 includes slack', r4.body.included.some((n) => n.includes('piece-slack')));
  ok('q4 estimatedTokens <= budget', r4.body.estimatedTokens <= 4000, `(${r4.body.estimatedTokens} <= 4000)`);
  ok('q4 context mentions Actions', /Actions:/.test(r4.body.context));
} finally {
  await app.close();
  console.log(failed ? '\n=== SMOKE-RETRIEVE FAILED ===' : '\n=== SMOKE-RETRIEVE PASSED ===');
  process.exit(failed ? 1 : 0);
}