// smoke-cursor.mjs — SMOKE de DURABILIDAD del cursor de dedup.
//
// Demuestra que el cursor `seen` persistido fuera del proceso sobrevive a un
// reinicio del runner: tras "matar" el primer loop y levantar uno NUEVO con el
// MISMO triggerId y el MISMO FileCursorStore (mismo dir), los items ya vistos
// NO se re-disparan; uno nuevo sí.
//
//    proceso 1: tick1 TICK_COUNT=2 -> items [id1,id2] -> 2 fires. cursor=["1","2"]
//    proceso 2 (restart, mismo triggerId+cursor):
//        tick1 TICK_COUNT=2 -> items [id1,id2] -> 0 fires (ya vistos)
//        tick2 TICK_COUNT=3 -> items [id1,id2,id3] -> 1 fire (id3). cursor=["1","2","3"]
//
// Para evitar la race del loop continuo (firedCount se actualiza tras el save
// del cursor, dentro del tick async), capturamos firedCount al INICIO de cada
// tick via beforeTick. Los fires de un tick = firedCount al inicio del tick
// siguiente menos el del inicio del actual.
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ADAPTER = path.resolve(__dirname, "../engine-adapter");

const TICK_GROW = path.join(ENGINE_ADAPTER, "custom-pieces-tick-grow/dist");
const JSON_PIECES = path.join(ENGINE_ADAPTER, "community-pieces");
// piece loader MUST be configured BEFORE the engine bundle is required.
process.env.AP_CUSTOM_PIECES_PATHS = `${TICK_GROW}:${JSON_PIECES}`;

const PORT = 3998;
const ENGINE_TOKEN = "dev-engine-token";
const PROJECT_ID = "smoke-project";
const TRIGGER_ID = "smoke-trigger-1";

const ok = (label, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera que corran >=n ticks Y que firedCount lleve estable 150ms (los fires
// del tick n ocurren tras su cursor save, dentro del mismo tick async).
async function waitForTicks(handle, n) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (handle.state.ticks >= n) {
      const a = handle.state.firedCount;
      await wait(150);
      const b = handle.state.firedCount;
      if (a === b) return;
    } else {
      await wait(10);
    }
  }
}

async function bootBackend() {
  const { Vault } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/vault.js"));
  const { MemoryStore } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/store.js"));
  const { MemoryFileStore } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/files.js"));
  const { createServer } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/server.js"));
  const server = createServer({
    vault: new Vault("dev-master-key-16chars"),
    store: new MemoryStore(),
    files: new MemoryFileStore(),
    engineToken: ENGINE_TOKEN,
    project: { id: PROJECT_ID, externalId: "smoke-ext" },
  });
  await new Promise((res) => server.listen(PORT, () => res()));
  console.log(`[smoke] backend-mock listening on http://localhost:${PORT}`);
  return server;
}

function startLoop(runnerMod, cursorStore, beforeTick) {
  return runnerMod.startReactivePoll({
    triggerSpec: { pieceName: "@automators/piece-tick", pieceVersion: "0.1.0", triggerName: "new_tick", input: {} },
    flowSteps: [{
      name: "json1", pieceName: "@activepieces/piece-json", pieceVersion: "0.1.8",
      actionName: "convert_text_to_json",
      inputFor: (item) => ({ text: JSON.stringify({ gotId: item?.id }) }),
    }],
    intervalMs: 80, port: PORT, engineToken: ENGINE_TOKEN, projectId: PROJECT_ID,
    idField: "id", cursorStore, triggerId: TRIGGER_ID, beforeTick,
  });
}

async function main() {
  const { FileCursorStore } = await import(path.join(__dirname, "src/cursor-store.ts"));
  const runnerMod = await import(path.join(__dirname, "src/poll-runner.ts"));

  const cursorDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-cursor-"));
  console.log(`[smoke] cursor dir = ${cursorDir}`);
  const cursorStore = new FileCursorStore(cursorDir);
  const cursorFile = path.join(cursorDir, `${TRIGGER_ID}.json`);

  const server = await bootBackend();
  try {
    // --- PROCESO 1: primer arranque, items [id1,id2] -> 2 fires ----------
    console.log("\n=== PROCESO 1 (primer arranque) ===");
    // firesAtStart[i] = firedCount al inicio del tick (i+1). firesTickN =
    // firesAtStart[N] - firesAtStart[N-1] (con firesAtStart[0]=0 previo).
    const firesAtStart1 = [];
    const h1 = startLoop(runnerMod, cursorStore, () => {
      process.env.TICK_COUNT = "2";
      firesAtStart1.push(h1.state.firedCount);
    });
    await waitForTicks(h1, 1);
    const final1 = h1.state.firedCount;
    const firesTick1 = final1 - (firesAtStart1[0] ?? 0);
    console.log(`proceso1: firesAtStart=${JSON.stringify(firesAtStart1)} final=${final1} -> tick1 fires=${firesTick1} (esperado 2)`);
    ok("proceso1: 2 fires por items [id1,id2]", firesTick1 === 2, `(got ${firesTick1})`);
    h1.stop();

    const fileAfter1 = fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, "utf8") : null;
    console.log(`cursor file tras proceso1 = ${fileAfter1}`);
    ok("proceso1: cursor file = [\"1\",\"2\"]", fileAfter1 === JSON.stringify(["1", "2"]), `(got ${fileAfter1})`);

    // --- PROCESO 2 (RESTART): MISMO triggerId + MISMO FileCursorStore ----
    console.log("\n=== PROCESO 2 (restart, mismo triggerId + cursor) ===");
    const firesAtStart2 = [];
    const h2 = startLoop(runnerMod, cursorStore, (tick) => {
      process.env.TICK_COUNT = tick === 1 ? "2" : "3";
      firesAtStart2.push(h2.state.firedCount);
    });
    await waitForTicks(h2, 2);
    const final2 = h2.state.firedCount;
    // tick1 fires = firesAtStart2[1] - firesAtStart2[0]  (lo que se disparo en tick1)
    const firesRestartTick1 = (firesAtStart2[1] ?? final2) - (firesAtStart2[0] ?? 0);
    // tick2 fires = final - firesAtStart2[1]
    const firesRestartTick2 = final2 - (firesAtStart2[1] ?? 0);
    console.log(`proceso2: firesAtStart=${JSON.stringify(firesAtStart2)} final=${final2}`);
    console.log(`restart tick1 fires=${firesRestartTick1} (esperado 0)`);
    ok("restart tick1: 0 fires (items ya vistos persistidos)", firesRestartTick1 === 0, `(got ${firesRestartTick1})`);
    console.log(`restart tick2 fires=${firesRestartTick2} (esperado 1)`);
    ok("restart tick2: 1 fire (item nuevo id3)", firesRestartTick2 === 1, `(got ${firesRestartTick2})`);
    const newItems = h2.state.fired.map((f) => f.item?.id);
    console.log(`restart items disparados = ${JSON.stringify(newItems)} (esperado [3])`);
    ok("restart: el item nuevo es id3", JSON.stringify(newItems) === "[3]", `(got ${JSON.stringify(newItems)})`);
    h2.stop();

    const fileAfter2 = fs.readFileSync(cursorFile, "utf8");
    console.log(`\ncursor file tras proceso2 = ${fileAfter2}`);
    ok("cursor final = [\"1\",\"2\",\"3\"]", fileAfter2 === JSON.stringify(["1", "2", "3"]), `(got ${fileAfter2})`);

    console.log("\n=== CONTENIDO DEL CURSOR FILE (raw) ===");
    console.log(fileAfter2);
  } finally {
    server.close();
    fs.rmSync(cursorDir, { recursive: true, force: true });
    console.log(`\n[smoke] cursor dir limpiado: ${cursorDir}`);
  }
}

main().catch((e) => {
  console.error("SMOKE THREW:", e?.stack ?? e);
  process.exitCode = 1;
});