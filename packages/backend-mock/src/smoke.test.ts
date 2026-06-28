import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import type { Server } from 'node:http';
import { Vault } from './vault.js';
import { MemoryStore } from './store.js';
import { MemoryFileStore } from './files.js';
import { createServer } from './server.js';
import { seedVault } from './seed.js';

const ENGINE_TOKEN = 'smoke-engine-token';
const PROJECT_ID = 'demo-project';
const PROJECT_EXTERNAL_ID = 'demo-ext';
const MASTER_KEY = 'smoke-master-key-16chars';

let server: Server;
let base: string;
const auth = { Authorization: `Bearer ${ENGINE_TOKEN}` };

before(async () => {
  const vault = new Vault(MASTER_KEY);
  const store = new MemoryStore();
  const files = new MemoryFileStore();
  seedVault(vault, PROJECT_ID);
  server = createServer({
    vault,
    store,
    files,
    engineToken: ENGINE_TOKEN,
    project: { id: PROJECT_ID, externalId: PROJECT_EXTERNAL_ID },
  });
  await new Promise<void>(resolve => server.listen(0, () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('smoke e2e', () => {
  it('GET /v1/worker/app-connections/openai con Bearer -> 200 y value.type SECRET_TEXT', async () => {
    const res = await fetch(
      `${base}/v1/worker/app-connections/openai?projectId=${PROJECT_ID}`,
      { headers: auth },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { value: { type: string } };
    assert.equal(body.value.type, 'SECRET_TEXT');
  });

  it('GET /v1/worker/app-connections/openai sin Bearer -> 401', async () => {
    const res = await fetch(
      `${base}/v1/worker/app-connections/openai?projectId=${PROJECT_ID}`,
    );
    assert.equal(res.status, 401);
  });

  it('GET /v1/worker/app-connections/no-existe -> 404', async () => {
    const res = await fetch(
      `${base}/v1/worker/app-connections/no-existe?projectId=${PROJECT_ID}`,
      { headers: auth },
    );
    assert.equal(res.status, 404);
  });

  it('store POST {key,value} luego GET ?key= -> mismo value', async () => {
    const value = { foo: 'bar', n: 42, nested: { ok: true } };
    const postRes = await fetch(`${base}/v1/store-entries`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'smoke-k', value }),
    });
    assert.equal(postRes.status, 200);
    const getRes = await fetch(`${base}/v1/store-entries?key=smoke-k`, {
      headers: auth,
    });
    assert.equal(getRes.status, 200);
    const body = await getRes.json() as { value: unknown };
    assert.deepEqual(body.value, value);
  });

  it('GET /v1/worker/project -> 200 con externalId', async () => {
    const res = await fetch(`${base}/v1/worker/project`);
    assert.equal(res.status, 200);
    const body = await res.json() as { id: string; externalId: string };
    assert.equal(body.externalId, PROJECT_EXTERNAL_ID);
  });

  it('files PUT bytes luego GET -> mismos bytes', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 128, 255, 0, 7]);
    const putRes = await fetch(`${base}/v1/files/smoke-f?token=${ENGINE_TOKEN}`, {
      method: 'PUT',
      body: bytes,
    });
    assert.equal(putRes.status, 200);
    const getRes = await fetch(`${base}/v1/files/smoke-f?token=${ENGINE_TOKEN}`);
    assert.equal(getRes.status, 200);
    const buf = Buffer.from(await getRes.arrayBuffer());
    assert.deepEqual(buf, bytes);
  });
});