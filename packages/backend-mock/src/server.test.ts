import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Vault } from './vault.js';
import { MemoryStore } from './store.js';
import { MemoryFileStore } from './files.js';
import { createServer } from './server.js';

const ENGINE_TOKEN = 'secret-engine-token';
const PROJECT = { id: 'proj-1', externalId: 'ext-1' };

function setup() {
  const vault = new Vault('k'.repeat(16));
  const store = new MemoryStore();
  const files = new MemoryFileStore();
  const server = createServer({ vault, store, files, engineToken: ENGINE_TOKEN, project: PROJECT });
  server.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const port = addr.port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${ENGINE_TOKEN}` };
  return { vault, store, files, server, base, auth };
}

const servers: import('node:http').Server[] = [];
function track(s: import('node:http').Server) { servers.push(s); return s; }
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function status(res: Response) { return res.status; }

test('connection encontrada -> 200 con value', async () => {
  const { vault, base, auth, server } = setup();
  track(server);
  vault.put({
    externalId: 'c1', projectId: 'proj-1', pieceName: 'p', displayName: 'n',
    value: { type: 'SECRET_TEXT', secret_text: 'hunter2' },
  });
  const res = await fetch(`${base}/v1/worker/app-connections/c1?projectId=proj-1`, { headers: auth });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.externalId, 'c1');
  assert.equal(body.status, 'ACTIVE');
  assert.equal(body.value.secret_text, 'hunter2');
});

test('connection no encontrada -> 404', async () => {
  const { base, auth, server } = setup();
  track(server);
  const res = await fetch(`${base}/v1/worker/app-connections/missing?projectId=proj-1`, { headers: auth });
  assert.equal(res.status, 404);
});

test('connection sin Bearer -> 401', async () => {
  const { base, server } = setup();
  track(server);
  const res = await fetch(`${base}/v1/worker/app-connections/c1?projectId=proj-1`);
  assert.equal(res.status, 401);
});

test('connection con token equivocado -> 401', async () => {
  const { base, server } = setup();
  track(server);
  const res = await fetch(`${base}/v1/worker/app-connections/c1?projectId=proj-1`, {
    headers: { Authorization: 'Bearer wrong' },
  });
  assert.equal(res.status, 401);
});

test('store POST -> GET round-trip via HTTP', async () => {
  const { base, auth, server } = setup();
  track(server);
  const put = await fetch(`${base}/v1/store-entries`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'k1', value: { n: 42 } }),
  });
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.deepEqual(putBody, { key: 'k1', value: { n: 42 } });
  const get = await fetch(`${base}/v1/store-entries?key=k1`, { headers: auth });
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { key: 'k1', value: { n: 42 } });
});

test('store GET inexistente -> 200 null', async () => {
  const { base, auth, server } = setup();
  track(server);
  const res = await fetch(`${base}/v1/store-entries?key=nope`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(await res.json(), null);
});

test('store DELETE idempotente -> GET devuelve null', async () => {
  const { base, auth, server } = setup();
  track(server);
  await fetch(`${base}/v1/store-entries`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'k2', value: 'v2' }),
  });
  const del = await fetch(`${base}/v1/store-entries?key=k2`, { method: 'DELETE', headers: auth });
  assert.equal(del.status, 200);
  const delAgain = await fetch(`${base}/v1/store-entries?key=k2`, { method: 'DELETE', headers: auth });
  assert.equal(delAgain.status, 200);
  const get = await fetch(`${base}/v1/store-entries?key=k2`, { headers: auth });
  assert.equal(get.status, 200);
  assert.equal(await get.json(), null);
});

test('store sin Bearer -> 401', async () => {
  const { base, server } = setup();
  track(server);
  const res = await fetch(`${base}/v1/store-entries?key=k1`);
  assert.equal(res.status, 401);
});

test('worker/project -> 200 con id y externalId', async () => {
  const { base, server } = setup();
  track(server);
  const res = await fetch(`${base}/v1/worker/project`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), PROJECT);
});

test('files PUT -> GET round-trip bytes', async () => {
  const { base, server } = setup();
  track(server);
  const bytes = Buffer.from([0, 1, 2, 3, 255, 128, 0, 7]);
  const put = await fetch(`${base}/v1/files/f1?token=${ENGINE_TOKEN}`, {
    method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' },
  });
  assert.equal(put.status, 200);
  const get = await fetch(`${base}/v1/files/f1?token=${ENGINE_TOKEN}`);
  assert.equal(get.status, 200);
  const got = Buffer.from(await get.arrayBuffer());
  assert.deepEqual(got, bytes);
});

test('files GET inexistente -> 404', async () => {
  const { base, server } = setup();
  track(server);
  const res = await fetch(`${base}/v1/files/nope?token=${ENGINE_TOKEN}`);
  assert.equal(res.status, 404);
});

test('files PUT con token equivocado -> 401', async () => {
  const { base, server } = setup();
  track(server);
  const res = await fetch(`${base}/v1/files/f1?token=wrong`, {
    method: 'PUT', body: Buffer.from([1]), headers: { 'content-type': 'application/octet-stream' },
  });
  assert.equal(res.status, 401);
});

test('files GET con token equivocado -> 401', async () => {
  const { base, server } = setup();
  track(server);
  const res = await fetch(`${base}/v1/files/f1?token=wrong`);
  assert.equal(res.status, 401);
});