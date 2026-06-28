// Probe ON_ENABLE of the cron piece: confirm the engine returns scheduleOptions
// with cronExpression (the exact object the reactive runner's cron mode reads).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ADAPTER = path.resolve(__dirname, "../../engine-adapter");

const CRON_PIECE = path.join(ENGINE_ADAPTER, "custom-pieces-tick-cron/dist");
const JSON_PIECES = path.join(ENGINE_ADAPTER, "community-pieces");
process.env.AP_CUSTOM_PIECES_PATHS = `${CRON_PIECE}:${JSON_PIECES}`;
process.env.CRON_EXPR = "* * * * *";

const require = createRequire(import.meta.url);
const engine = require(path.join(ENGINE_ADAPTER, "dist/engine.cjs")) as {
  triggerHookOperation: { execute: (op: unknown) => Promise<any> };
};

const PORT = 3998;
const ENGINE_TOKEN = "dev-engine-token";
const PROJECT_ID = "demo-project";

const { Vault } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/vault.js"));
const { MemoryStore } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/store.js"));
const { MemoryFileStore } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/files.js"));
const { createServer } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/server.js"));

const server = createServer({
  vault: new Vault("dev-master-key-16chars"),
  store: new MemoryStore(),
  files: new MemoryFileStore(),
  engineToken: ENGINE_TOKEN,
  project: { id: PROJECT_ID, externalId: "demo-ext" },
});

await new Promise<void>((res) => server.listen(PORT, () => res()));
console.log(`[probe] mock on :${PORT}`);

function makeFlowVersion() {
  return {
    id: "demo-flow-version",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    flowId: "demo-flow",
    displayName: "Cron Tick Flow",
    trigger: {
      name: "new_tick",
      valid: true,
      displayName: "New Tick Cron",
      type: "PIECE",
      settings: {
        pieceName: "@automators/piece-tick-cron",
        pieceVersion: "0.1.0",
        triggerName: "new_tick",
        input: {},
        propertySettings: {},
      },
    },
    updatedBy: null,
    valid: true,
    state: "DRAFT",
    schemaVersion: null,
    connectionIds: [],
    agentIds: [],
  };
}
function makeOp(hookType: string) {
  const base = `http://localhost:${PORT}`;
  return {
    hookType,
    test: false,
    flowVersion: makeFlowVersion(),
    webhookUrl: `${base}/webhook`,
    triggerPayload: { type: "inline", value: {} },
    projectId: PROJECT_ID,
    platformId: "demo-platform",
    engineToken: ENGINE_TOKEN,
    internalApiUrl: `${base}/`,
    publicApiUrl: `${base}/api/`,
    timeoutInSeconds: 60,
  };
}

try {
  const res = await engine.triggerHookOperation.execute(makeOp("ON_ENABLE"));
  console.log("=== ON_ENABLE EngineResponse ===");
  console.log(JSON.stringify(res, null, 2));
} catch (e: any) {
  console.log("=== THREW ===");
  console.log(e?.stack ?? e);
} finally {
  server.close(() => process.exit(0));
}