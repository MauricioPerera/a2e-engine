import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { Buffer } from 'node:buffer';
import { Vault } from './vault.js';
import { MemoryStore } from './store.js';
import { MemoryFileStore } from './files.js';

export interface ServerDeps {
  vault: Vault;
  store: MemoryStore;
  files: MemoryFileStore;
  engineToken: string;
  project: { id: string; externalId: string };
}

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  deps: ServerDeps;
  pathname: string;
  query: URLSearchParams;
}

export function createServer(deps: ServerDeps): Server {
  return createHttpServer((req, res) => handleRequest(req, res, deps));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: ServerDeps): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: RequestContext = { req, res, deps, pathname: url.pathname, query: url.searchParams };
    await dispatch(ctx);
  } catch {
    sendJson({ req, res, deps, pathname: '', query: new URLSearchParams() }, 500, { error: 'internal server error' });
  }
}

const routes = new Map([
  ['GET', routeGet],
  ['POST', routePost],
  ['PUT', routePut],
  ['DELETE', routeDelete],
]);

export async function dispatch(ctx: RequestContext): Promise<void> {
  const route = routes.get(ctx.req.method ?? '');
  if (route) return route(ctx);
  return notFound(ctx);
}

async function routeGet(ctx: RequestContext): Promise<void> {
  if (ctx.pathname === '/v1/worker/project') return handleGetProject(ctx);
  if (ctx.pathname.startsWith('/v1/worker/app-connections/')) return handleGetConnection(ctx);
  if (ctx.pathname === '/v1/store-entries') return handleGetStore(ctx);
  if (ctx.pathname.startsWith('/v1/files/')) return handleGetFile(ctx);
  return notFound(ctx);
}

async function routePost(ctx: RequestContext): Promise<void> {
  if (ctx.pathname === '/v1/store-entries') return handlePostStore(ctx);
  return notFound(ctx);
}

async function routeDelete(ctx: RequestContext): Promise<void> {
  if (ctx.pathname === '/v1/store-entries') return handleDeleteStore(ctx);
  return notFound(ctx);
}

async function routePut(ctx: RequestContext): Promise<void> {
  if (ctx.pathname.startsWith('/v1/files/')) return handlePutFile(ctx);
  return notFound(ctx);
}

async function handleGetConnection(ctx: RequestContext): Promise<void> {
  if (!requireBearerAuth(ctx)) return;
  const externalId = ctx.pathname.split('/').pop() ?? '';
  const projectId = ctx.query.get('projectId') ?? '';
  const result = await ctx.deps.vault.obtain(projectId, externalId);
  if (result === null) return sendJson(ctx, 404, { error: 'not found' });
  sendJson(ctx, 200, result);
}

async function handleGetStore(ctx: RequestContext): Promise<void> {
  if (!requireBearerAuth(ctx)) return;
  const key = ctx.query.get('key') ?? '';
  const result = await ctx.deps.store.get(key);
  sendJson(ctx, 200, result);
}

async function handlePostStore(ctx: RequestContext): Promise<void> {
  if (!requireBearerAuth(ctx)) return;
  const body = await readBody(ctx);
  const { key, value } = JSON.parse(body.toString());
  const result = await ctx.deps.store.put(key, value);
  sendJson(ctx, 200, result);
}

async function handleDeleteStore(ctx: RequestContext): Promise<void> {
  if (!requireBearerAuth(ctx)) return;
  const key = ctx.query.get('key') ?? '';
  await ctx.deps.store.delete(key);
  sendJson(ctx, 200, null);
}

function handleGetProject(ctx: RequestContext): void {
  sendJson(ctx, 200, ctx.deps.project);
}

async function handlePutFile(ctx: RequestContext): Promise<void> {
  if (!requireTokenAuth(ctx)) return;
  const fileId = ctx.pathname.split('/').pop() ?? '';
  const body = await readBody(ctx);
  await ctx.deps.files.put(fileId, Buffer.from(body));
  sendJson(ctx, 200, null);
}

async function handleGetFile(ctx: RequestContext): Promise<void> {
  if (!requireTokenAuth(ctx)) return;
  const fileId = ctx.pathname.split('/').pop() ?? '';
  const result = await ctx.deps.files.get(fileId);
  if (result === null) return sendJson(ctx, 404, { error: 'not found' });
  sendBytes(ctx, 200, result);
}

function requireBearerAuth(ctx: RequestContext): boolean {
  const authHeader = ctx.req.headers.authorization;
  if (authHeader !== `Bearer ${ctx.deps.engineToken}`) {
    sendJson(ctx, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function requireTokenAuth(ctx: RequestContext): boolean {
  const token = ctx.query.get('token');
  if (token !== ctx.deps.engineToken) {
    sendJson(ctx, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function sendJson(ctx: RequestContext, status: number, obj: unknown): void {
  ctx.res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  ctx.res.end(JSON.stringify(obj));
}

function sendBytes(ctx: RequestContext, status: number, buf: Buffer): void {
  ctx.res.writeHead(status, { 'content-type': 'application/octet-stream' });
  ctx.res.end(buf);
}

function notFound(ctx: RequestContext): void {
  sendJson(ctx, 404, { error: 'not found' });
}

async function readBody(ctx: RequestContext): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}