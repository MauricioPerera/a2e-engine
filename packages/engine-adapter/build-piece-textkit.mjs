// Builds our own @automators/piece-textkit into a custom-pieces layout the
// engine's piece-loader can resolve via AP_CUSTOM_PIECES_PATHS.
//   <custom>/pieces/@automators/piece-textkit-0.1.0/node_modules/@automators/piece-textkit/
//       package.json  (main -> index.cjs)
//       index.cjs
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AP_REPO = process.env.AP_REPO || path.join(os.homedir(), 'ap');
const AP = path.join(AP_REPO, 'packages');
const require = createRequire(import.meta.url);
const esbuild = require(path.join(AP_REPO, 'node_modules/esbuild/lib/main.js'));
const PIECE_SRC = path.join(__dirname, 'custom-pieces-textkit/src/index.ts');

const PIECE = '@automators/piece-textkit';
const VERSION = '0.1.0';
const customRoot = path.join(__dirname, 'custom-pieces-textkit/dist');
const pkgDir = path.join(customRoot, 'pieces', `${PIECE}-${VERSION}`, 'node_modules', PIECE);
fs.mkdirSync(pkgDir, { recursive: true });

const engineAliases = {
  '@activepieces/shared': path.join(AP, 'core/shared/src'),
  '@activepieces/pieces-framework': path.join(AP, 'pieces/framework/src'),
  '@activepieces/pieces-common': path.join(AP, 'pieces/common/src'),
  '@activepieces/core-utils': path.join(AP, 'core/utils/src'),
  '@activepieces/core-piece-types': path.join(AP, 'core/piece-types/src'),
  '@activepieces/core-formula': path.join(AP, 'core/formula/src'),
  '@activepieces/core-execution': path.join(AP, 'core/execution/src'),
};

await esbuild.build({
  entryPoints: [PIECE_SRC],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: path.join(pkgDir, 'index.cjs'),
  sourcemap: false,
  minify: false,
  alias: engineAliases,
  external: ['isolated-vm', 'utf-8-validate', 'bufferutil'],
  logLevel: 'info',
});

fs.writeFileSync(
  path.join(pkgDir, 'package.json'),
  JSON.stringify({ name: PIECE, version: VERSION, main: './index.cjs' }, null, 2),
);

console.log('[build-piece-textkit] done ->', pkgDir);
console.log('[build-piece-textkit] AP_CUSTOM_PIECES_PATHS=', customRoot);
