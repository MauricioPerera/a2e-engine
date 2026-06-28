// e2e agent-style smoke: boots the product API (which boots the in-process mock),
// then drives it with REAL fetch over HTTP. Kills everything at the end.
import { start, PRODUCT_PORT } from './src/index.ts';

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed = true;
};

const app = await start();
try {
  // 1) GET /catalog
  const cat = await fetch(`${BASE}/catalog`);
  const catText = await cat.text();
  ok('GET /catalog -> 200', cat.status === 200, `(status ${cat.status})`);
  ok('catalog lists pieces', /piece-json|piece-echo-auth|JSON|Echo Auth/.test(catText));
  console.log('--- catalog (first 25 lines) ---');
  console.log(catText.split('\n').slice(0, 25).join('\n'));
  console.log('--- end catalog excerpt ---');

  // 2) POST /execute - JSON piece
  const r1 = await fetch(`${BASE}/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      steps: [
        {
          name: 'parse',
          pieceName: '@activepieces/piece-json',
          pieceVersion: '0.1.8',
          actionName: 'convert_text_to_json',
          input: { text: '{"a":1}' },
        },
      ],
    }),
  });
  const b1 = await r1.json();
  console.log('execute(json) ->', JSON.stringify(b1));
  ok('POST /execute json -> 200', r1.status === 200, `(status ${r1.status})`);
  ok('json status SUCCEEDED', b1.status === 'SUCCEEDED', `(got ${b1.status})`);
  ok('json output {a:1}', b1.output && b1.output.a === 1, JSON.stringify(b1.output));

  // 3) POST /execute - echo piece with connection
  const r2 = await fetch(`${BASE}/execute`, {
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
  const b2 = await r2.json();
  console.log('execute(echo) ->', JSON.stringify(b2));
  ok('POST /execute echo -> 200', r2.status === 200, `(status ${r2.status})`);
  ok('echo status SUCCEEDED', b2.status === 'SUCCEEDED', `(got ${b2.status})`);
  ok('echo apiKeyTail == 1234', b2.output && b2.output.apiKeyTail === '1234', JSON.stringify(b2.output));
} finally {
  await app.close();
  console.log(failed ? '\n=== SMOKE FAILED ===' : '\n=== SMOKE PASSED ===');
  process.exit(failed ? 1 : 0);
}
