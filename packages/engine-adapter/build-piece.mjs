// Generic piece bundler.
// Bundles ANY Activepieces community piece (its src/index.ts) into the layout
// the engine's piece-loader resolves via AP_CUSTOM_PIECES_PATHS:
//   <outRoot>/pieces/@<scope>/piece-<name>-<version>/node_modules/@<scope>/piece-<name>/
//       package.json  (main -> index.cjs)
//       index.cjs
//
// Usage:
//   node build-piece.mjs <pieceDir> <outRoot>
//   node build-piece.mjs ~/ap/packages/pieces/community/json ./community-pieces
//
// Logic reused verbatim from build-piece-json.mjs (7 aliases + externals).
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';

const AP_REPO = process.env.AP_REPO || path.join(os.homedir(), 'ap');
const AP = path.join(AP_REPO, 'packages');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(AP_REPO, 'node_modules/esbuild/lib/main.js'));

const engineAliases = {
  '@activepieces/shared': path.join(AP, 'core/shared/src'),
  '@activepieces/pieces-framework': path.join(AP, 'pieces/framework/src'),
  '@activepieces/pieces-common': path.join(AP, 'pieces/common/src'),
  '@activepieces/core-utils': path.join(AP, 'core/utils/src'),
  '@activepieces/core-piece-types': path.join(AP, 'core/piece-types/src'),
  '@activepieces/core-formula': path.join(AP, 'core/formula/src'),
  '@activepieces/core-execution': path.join(AP, 'core/execution/src'),
};

export async function buildPiece(pieceDir, outRoot) {
  pieceDir = path.resolve(pieceDir);
  outRoot = path.resolve(outRoot);

  const pkg = JSON.parse(fs.readFileSync(path.join(pieceDir, 'package.json'), 'utf-8'));
  const PIECE = pkg.name;       // e.g. @activepieces/piece-json
  const VERSION = pkg.version;  // e.g. 0.1.8
  const src = path.join(pieceDir, 'src', 'index.ts');
  if (!fs.existsSync(src)) throw new Error(`no src/index.ts in ${pieceDir}`);

  const pkgDir = path.join(outRoot, 'pieces', `${PIECE}-${VERSION}`, 'node_modules', PIECE);
  fs.mkdirSync(pkgDir, { recursive: true });

  await esbuild.build({
    entryPoints: [src],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(pkgDir, 'index.cjs'),
    sourcemap: false,
    minify: false,
    alias: engineAliases,
    external: ['isolated-vm', 'utf-8-validate', 'bufferutil'],
    logLevel: 'warning',
  });

  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: PIECE, version: VERSION, main: './index.cjs' }, null, 2),
  );

  return { name: PIECE, version: VERSION, pkgDir, indexCjs: path.join(pkgDir, 'index.cjs') };
}

// CLI mode
if (process.argv[1] && process.argv[1].endsWith('build-piece.mjs')) {
  const [, , pieceDir, outRoot] = process.argv;
  if (!pieceDir || !outRoot) {
    console.error('usage: node build-piece.mjs <pieceDir> <outRoot>');
    process.exit(1);
  }
  try {
    const r = await buildPiece(pieceDir, outRoot);
    console.log(`[build-piece] OK ${r.name}@${r.version} -> ${r.pkgDir}`);
  } catch (e) {
    console.error(`[build-piece] FAIL ${pieceDir}:`, e.message);
    process.exit(2);
  }
}
