import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from './server.js';
import { Vault } from './vault.js';
import { MemoryStore } from './store.js';
import { MemoryFileStore } from './files.js';

const deps = {
  vault: new Vault('k'.repeat(16)),
  store: new MemoryStore(),
  files: new MemoryFileStore(),
  engineToken: 'tok',
  project: { id: 'p', externalId: 'e' },
};

function mockCtx(method: string, pathname: string, query = '') {
  let captured = { status: 0 as number, body: '' as string };
  const res: any = {
    writeHead(status: number, _h: unknown) { captured.status = status; },
    end(b: unknown) { captured.body = b === undefined ? '' : String(b); },
  };
  const ctx: any = {
    req: { method, headers: {} },
    res,
    deps,
    pathname,
    query: new URLSearchParams(query),
  };
  return { ctx, captured };
}

test('dispatch GET enruta a routeGet -> handleGetProject 200', async () => {
  const { ctx, captured } = mockCtx('GET', '/v1/worker/project');
  await dispatch(ctx);
  assert.equal(captured.status, 200);
  assert.deepEqual(JSON.parse(captured.body), { id: 'p', externalId: 'e' });
});

test('dispatch POST enruta a routePost -> 401 sin Bearer', async () => {
  const { ctx, captured } = mockCtx('POST', '/v1/store-entries');
  await dispatch(ctx);
  assert.equal(captured.status, 401);
});

test('dispatch DELETE enruta a routeDelete -> 401 sin Bearer', async () => {
  const { ctx, captured } = mockCtx('DELETE', '/v1/store-entries', 'key=k');
  await dispatch(ctx);
  assert.equal(captured.status, 401);
});

test('dispatch PUT enruta a routePut -> 401 con token equivocado', async () => {
  const { ctx, captured } = mockCtx('PUT', '/v1/files/f1', 'token=wrong');
  await dispatch(ctx);
  assert.equal(captured.status, 401);
});

test('dispatch metodo desconocido -> notFound 404', async () => {
  const { ctx, captured } = mockCtx('FOO', '/whatever');
  await dispatch(ctx);
  assert.equal(captured.status, 404);
});