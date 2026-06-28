// Builds @activepieces/piece-json into a custom-pieces layout the engine's
// piece-loader can resolve via AP_CUSTOM_PIECES_PATHS.
//   <custom>/pieces/@activepieces/piece-json-0.1.8/node_modules/@activepieces/piece-json/
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
const JSON_SRC = path.join(AP, 'pieces/community/json/src/index.ts');

const PIECE = '@activepieces/piece-json';
const VERSION = '0.1.8';
const customRoot = path.join(__dirname, 'custom-pieces');
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
  entryPoints: [JSON_SRC],
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

console.log('[build-piece-json] done ->', pkgDir);
console.log('[build-piece-json] AP_CUSTOM_PIECES_PATHS=', customRoot);
