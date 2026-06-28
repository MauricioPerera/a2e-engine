// Probe (parte #1 de triggers): invoca el HOOK de un trigger POLLING in-process
// via el engine bundle, igual que flowExecutor para actions.
//   - Arranca el backend-mock inline en :3997.
//   - Arma un ExecuteTriggerOperation (TEST y RUN) apuntando a @automators/piece-tick.
//   - Llama triggerHookOperation.execute(...) y reporta status + payload reales.
import { createRequire } from 'node:module';
import { Vault } from '../backend-mock/src/vault.js';
import { MemoryStore } from '../backend-mock/src/store.js';
import { MemoryFileStore } from '../backend-mock/src/files.js';
import { createServer } from '../backend-mock/src/server.js';

const require = createRequire(import.meta.url);
const engine = require('./dist/engine.cjs') as {
  triggerHookOperation: { execute: (op: unknown) => Promise<unknown> };
  triggerHelper: unknown;
};

const PORT = Number(process.env.PORT ?? '3997');
const ENGINE_TOKEN = 'dev-engine-token';
const PROJECT_ID = 'demo-project';

console.log('typeof triggerHookOperation         =', typeof engine.triggerHookOperation);
console.log('typeof triggerHookOperation.execute =', typeof engine.triggerHookOperation?.execute);
console.log('typeof triggerHelper                =', typeof engine.triggerHelper);

const vault = new Vault('dev-master-key-16chars');
const server = createServer({
  vault,
  store: new MemoryStore(),
  files: new MemoryFileStore(),
  engineToken: ENGINE_TOKEN,
  project: { id: PROJECT_ID, externalId: 'demo-ext' },
});

function makeFlowVersion() {
  return {
    id: 'demo-flow-version',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    flowId: 'demo-flow',
    displayName: 'Tick Flow',
    trigger: {
      name: 'new_tick',
      valid: true,
      displayName: 'New Tick',
      type: 'PIECE',
      settings: {
        pieceName: '@automators/piece-tick',
        pieceVersion: '0.1.0',
        triggerName: 'new_tick',
        input: {},
        propertySettings: {},
      },
    },
    updatedBy: null,
    valid: true,
    state: 'DRAFT',
    schemaVersion: null,
    connectionIds: [],
    agentIds: [],
  };
}

function makeOperation(hookType: string, test: boolean) {
  return {
    hookType,
    test,
    flowVersion: makeFlowVersion(),
    webhookUrl: `http://localhost:${PORT}/webhook`,
    triggerPayload: { type: 'inline', value: {} },
    projectId: PROJECT_ID,
    platformId: 'demo-platform',
    engineToken: ENGINE_TOKEN,
    internalApiUrl: `http://localhost:${PORT}/`,
    publicApiUrl: `http://localhost:${PORT}/api/`,
    timeoutInSeconds: 60,
  };
}

server.listen(PORT, async () => {
  console.log(`trigger-probe mock listening on http://localhost:${PORT}`);
  try {
    const testRes = await engine.triggerHookOperation.execute(makeOperation('TEST', true));
    console.log('=== TEST RESULT ===');
    console.log(JSON.stringify(testRes));

    const runRes = await engine.triggerHookOperation.execute(makeOperation('RUN', false));
    console.log('=== RUN RESULT ===');
    console.log(JSON.stringify(runRes));
  } catch (e: any) {
    console.log('=== THREW ===');
    console.log(e?.stack ?? e);
  } finally {
    server.close(() => process.exit(0));
  }
});
