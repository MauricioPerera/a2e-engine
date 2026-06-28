// e2e smoke for /connections: boots product-api (in-process mock seeds
// my-echo-conn with secret 'sk-test-ABCD1234'), lists REFERENCES, renders the
// CCDD context slot, and ASSERTS the secret NEVER appears in any response.
import { start, PRODUCT_PORT } from './src/index.ts';

const BASE = `http://localhost:${PRODUCT_PORT}`;
let failed = false;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed = true;
};

const SECRET = 'sk-test-ABCD1234';

const app = await start();
try {
  // 1) GET /connections (default json)
  const r1 = await fetch(`${BASE}/connections`);
  const b1 = await r1.json();
  console.log('--- GET /connections (json) ---');
  console.log(JSON.stringify(b1, null, 2));
  ok('GET /connections -> 200', r1.status === 200, `(status ${r1.status})`);
  ok('json has connections array', Array.isArray(b1.connections));
  ok('json lists my-echo-conn', Array.isArray(b1.connections) && b1.connections.some((c) => c.externalId === 'my-echo-conn'));
  ok('json ref has pieceName', Array.isArray(b1.connections) && b1.connections.some((c) => c.pieceName === '@automators/piece-echo-auth'));
  ok('json ref has type', Array.isArray(b1.connections) && b1.connections.some((c) => c.type === 'SECRET_TEXT'));
  ok('json total >= 1', b1.total >= 1, `(total ${b1.total})`);

  // 2) GET /connections?format=context&budget=1000
  const r2 = await fetch(`${BASE}/connections?format=context&budget=1000`);
  const b2 = await r2.json();
  console.log('--- GET /connections?format=context&budget=1000 ---');
  console.log(JSON.stringify(b2, null, 2));
  ok('context -> 200', r2.status === 200, `(status ${r2.status})`);
  ok('context has context string', typeof b2.context === 'string');
  ok('context includes {{connections.my-echo-conn}}', typeof b2.context === 'string' && b2.context.includes('{{connections.my-echo-conn}}'));
  ok('context included has my-echo-conn', Array.isArray(b2.included) && b2.included.includes('my-echo-conn'));
  ok('context total >= 1', b2.total >= 1, `(total ${b2.total})`);

  // 3) GET /connections?piece=@automators/piece-echo-auth&format=json (filter)
  const r3 = await fetch(`${BASE}/connections?piece=%40automators%2Fpiece-echo-auth&format=json`);
  const b3 = await r3.json();
  console.log('--- GET /connections?piece=...echo-auth (filtered) ---');
  console.log(JSON.stringify(b3, null, 2));
  ok('filtered -> 200', r3.status === 200, `(status ${r3.status})`);
  ok('filtered keeps echo conn', Array.isArray(b3.connections) && b3.connections.every((c) => c.pieceName === '@automators/piece-echo-auth'));

  // 4) GET /connections?piece=does-not-exist -> empty
  const r4 = await fetch(`${BASE}/connections?piece=nope&format=json`);
  const b4 = await r4.json();
  ok('unknown piece -> empty list', Array.isArray(b4.connections) && b4.connections.length === 0 && b4.total === 0);

  // 5) CRITICAL SECURITY ASSERTION: secret NEVER in any response body.
  const bodies = [JSON.stringify(b1), JSON.stringify(b2), JSON.stringify(b3), JSON.stringify(b4)];
  const leakedIn = bodies.map((s, i) => (s.includes(SECRET) ? i + 1 : null)).filter(Boolean);
  ok('SECRET NEVER appears in any /connections response', leakedIn.length === 0, leakedIn.length ? `LEAKED in responses: ${leakedIn.join(',')}` : '(no leak)');
  // Explicit printout of the no-leak assertion.
  console.log(`SECURITY: secret '${SECRET}' present in responses? ${leakedIn.length === 0 ? 'NO (not present)' : 'YES -> ' + leakedIn.join(',')}`);

  // Also assert the context string itself carries no secret.
  ok('context string has no secret', typeof b2.context === 'string' && !b2.context.includes(SECRET));
} finally {
  await app.close();
  console.log(failed ? '\n=== SMOKE-CONNECTIONS FAILED ===' : '\n=== SMOKE-CONNECTIONS PASSED ===');
  process.exit(failed ? 1 : 0);
}