import * as esbuild from '/home/administrador/ap/node_modules/esbuild/lib/main.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AP = '/home/administrador/ap/packages';
const ENGINE = path.join(AP, 'server/engine');

// The 7 aliases from ~/ap/packages/server/engine/esbuild.config.mjs, resolved to packages/*/src.
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
  entryPoints: [path.join(__dirname, 'src/engine-entry.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: path.join(__dirname, 'dist/engine.cjs'),
  sourcemap: false,
  minify: false,
  treeShaking: true,
  alias: {
    '@ap-engine': ENGINE,
    ...engineAliases,
  },
  external: ['isolated-vm', 'utf-8-validate', 'bufferutil'],
  logLevel: 'info',
});

console.log('[build-engine] done -> dist/engine.cjs');
