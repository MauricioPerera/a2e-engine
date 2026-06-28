// Child worker: bundle ONE piece's src/index.ts to a temp CJS, require it,
// extract .metadata(), serialize to a JSON-safe PieceMetadataInput, print to stdout.
// Runs as plain node (no .ts imports). Always exits 0 and prints one JSON line
// so the parent can parse results uniformly; failures are reported in-band.
import * as esbuild from '/home/administrador/ap/node_modules/esbuild/lib/main.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const AP = '/home/administrador/ap/packages';
const engineAliases = {
  '@activepieces/shared': path.join(AP, 'core/shared/src'),
  '@activepieces/pieces-framework': path.join(AP, 'pieces/framework/src'),
  '@activepieces/pieces-common': path.join(AP, 'pieces/common/src'),
  '@activepieces/core-utils': path.join(AP, 'core/utils/src'),
  '@activepieces/core-piece-types': path.join(AP, 'core/piece-types/src'),
  '@activepieces/core-formula': path.join(AP, 'core/formula/src'),
  '@activepieces/core-execution': path.join(AP, 'core/execution/src'),
};

const NATIVE_HINT = [
  'isolated-vm', 'better-sqlite', 'sqlite', 'canvas', 'sharp',
  'utf-8-validate', 'bufferutil', 'node-gyp', 'nan', 'fsevents',
  'rdkit', 'onnx', 'tensorflow', 'argon2', 'bcrypt', 'sodium',
];

function classify(errText) {
  const t = (errText || '').toLowerCase();
  if (NATIVE_HINT.some((h) => t.includes(h))) return 'native-dep';
  if (/no .*metadata|findpieceedexport|no createpiece/i.test(t)) return 'no-metadata';
  return 'require-fail';
}

function findPieceExport(mod) {
  if (mod?.default && typeof mod.default.metadata === 'function') return mod.default;
  if (mod?.default?.default && typeof mod.default.default.metadata === 'function') return mod.default.default;
  for (const k of Object.keys(mod || {})) {
    if (mod[k] && typeof mod[k].metadata === 'function') return mod[k];
  }
  return null;
}

function serializeProps(props) {
  if (!props) return {};
  const out = {};
  for (const [k, p] of Object.entries(props)) {
    if (!p) continue;
    out[k] = {
      type: p.type ?? 'UNKNOWN',
      displayName: p.displayName ?? k,
      description: p.description ?? '',
      required: !!p.required,
    };
  }
  return out;
}

function serializeActions(obj) {
  if (!obj) return {};
  const out = {};
  for (const [k, a] of Object.entries(obj)) {
    if (!a) continue;
    out[k] = {
      name: a.name ?? k,
      displayName: a.displayName ?? k,
      description: a.description ?? '',
      props: serializeProps(a.props),
      requireAuth: a.requireAuth,
      strategy: a.strategy,
      audience: a.audience,
      aiMetadata: a.aiMetadata
        ? { description: a.aiMetadata.description, idempotent: a.aiMetadata.idempotent }
        : undefined,
    };
  }
  return out;
}

function normalizeAuth(auth) {
  if (!auth) return undefined;
  const a = Array.isArray(auth) ? auth[0] : auth;
  if (!a || !a.type) return undefined;
  return {
    type: a.type,
    displayName: a.displayName,
    description: a.description,
    required: a.required,
  };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const [, , pieceDir] = process.argv;
if (!pieceDir) {
  emit({ ok: false, error: 'no pieceDir arg', reason: 'arg' });
  process.exit(0);
}

let tmpFile;
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(pieceDir, 'package.json'), 'utf-8'));
  const src = path.join(pieceDir, 'src', 'index.ts');
  if (!fs.existsSync(src)) throw new Error('no src/index.ts');
  const tmpName = 'apokf-' + process.pid + '-' + Date.now() + '.cjs';
  tmpFile = path.join(os.tmpdir(), tmpName);

  await esbuild.build({
    entryPoints: [src],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: tmpFile,
    sourcemap: false,
    minify: false,
    alias: engineAliases,
    external: ['isolated-vm', 'utf-8-validate', 'bufferutil'],
    logLevel: 'silent',
  });

  delete require.cache[tmpFile];
  const mod = require(tmpFile);
  const piece = findPieceExport(mod);
  if (!piece) throw new Error('no createPiece export with .metadata()');
  const md = piece.metadata();

  const input = {
    name: pkg.name,
    displayName: md.displayName,
    description: md.description ?? '',
    version: pkg.version,
    logoUrl: md.logoUrl,
    categories: md.categories,
    authors: md.authors,
    auth: normalizeAuth(md.auth),
    actions: serializeActions(md.actions),
    triggers: serializeActions(md.triggers),
  };

  emit({
    ok: true,
    input,
    counts: {
      actions: Object.keys(input.actions).length,
      triggers: Object.keys(input.triggers).length,
      auth: input.auth?.type ?? 'NONE',
    },
  });
} catch (e) {
  const errText = e && e.message ? e.message : String(e);
  const isBundle = /esbuild|build failed|no entry|transform failed/i.test(errText)
    || (e.errors !== undefined);
  const reason = isBundle ? 'bundle-fail' : classify(errText);
  emit({ ok: false, error: errText.split('\n')[0].slice(0, 300), reason });
} finally {
  try { if (tmpFile) fs.rmSync(tmpFile, { force: true }); } catch {}
  process.exit(0);
}