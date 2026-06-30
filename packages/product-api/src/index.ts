// Entry point. Sets the engine env, points AP_CUSTOM_PIECES_PATHS at BOTH demo
// piece roots (json + echo), boots the in-process backend-mock, then listens.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockBackend, MOCK_PORT } from './mock-backend.js';
import { createProductServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .../product-api/src -> .../engine-adapter
const engineAdapter = path.resolve(__dirname, '../../engine-adapter');

// The loader does resolve(<path>, "pieces", pkgName); each path is the parent of pieces/.
const JSON_PIECES = path.join(engineAdapter, 'custom-pieces');
const ECHO_PIECES = path.join(engineAdapter, 'custom-pieces-echo/dist');
const HOOK_PIECES = path.join(engineAdapter, 'custom-pieces-hook/dist');
const TEXTKIT_PIECES = path.join(engineAdapter, 'custom-pieces-textkit/dist');
const SHELL_PIECES = path.join(engineAdapter, 'custom-pieces-shell/dist');

// Promoted pieces: bundles de pieces importadas (T2) promovidas al catalogo
// vivo via POST /admin/promote. El engine las carga en ejecucion (el piece-loader
// lee AP_CUSTOM_PIECES_PATHS fresco en cada llamada -> promover en runtime SIN
// restart las hace ejecutables). Dir via env PROMOTED_PIECES_DIR; default al
// promoted-pieces de engine-adapter. Idempotente: re-promover misma version
// sobreescribe el mismo layout (pieces/@scope/piece-name-VERSION/...).
const PROMOTED_PIECES = process.env.PROMOTED_PIECES_DIR ?? path.join(engineAdapter, 'promoted-pieces');

export function configureEngineEnv(): void {
  process.env.AP_EXECUTION_MODE = process.env.AP_EXECUTION_MODE ?? 'UNSANDBOXED';
  process.env.AP_PAUSED_FLOW_TIMEOUT_DAYS = process.env.AP_PAUSED_FLOW_TIMEOUT_DAYS ?? '1';
  process.env.AP_CUSTOM_PIECES_PATHS =
    process.env.AP_CUSTOM_PIECES_PATHS ?? [JSON_PIECES, ECHO_PIECES, HOOK_PIECES, TEXTKIT_PIECES, SHELL_PIECES, PROMOTED_PIECES].join(':');
}

export const PRODUCT_PORT = Number(process.env.PORT ?? '8080');
const BIND_ADDR = process.env.BIND_ADDR ?? '127.0.0.1';

export async function start(): Promise<{ close: () => Promise<void> }> {
  configureEngineEnv();
  const mock = await startMockBackend();
  const server = createProductServer();
  await new Promise<void>((resolve) => server.listen(PRODUCT_PORT, BIND_ADDR, resolve));
  // eslint-disable-next-line no-console
  console.log(
    `product-api listening on http://localhost:${PRODUCT_PORT}  (mock backend on :${mock.port})`,
  );
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => mock.server.close(() => resolve()));
      }),
  };
}

// Run when invoked directly (tsx src/index.ts).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  void MOCK_PORT; // keep import referenced
  start().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}