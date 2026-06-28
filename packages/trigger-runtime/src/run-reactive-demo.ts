// run-reactive-demo.ts — proves the reactive POLLING loop end-to-end:
//   tick1: TICK_COUNT=2 -> trigger returns [id1,id2] -> 2 NEW -> fire flow x2
//   tick2: TICK_COUNT=3 -> trigger returns [id1,id2,id3] -> 1 NEW -> fire flow x1
//   tick3: TICK_COUNT=3 -> trigger returns [id1,id2,id3] -> 0 NEW -> fire flow x0
//
// Boots the backend-mock inline on :3997, points the piece loader at BOTH the
// growing tick piece (the trigger) and the json piece (the flow body), runs 3
// ticks at 500ms, then tears everything down.
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ADAPTER = path.resolve(__dirname, "../../engine-adapter");

const TICK_GROW = path.join(ENGINE_ADAPTER, "custom-pieces-tick-grow/dist");
const JSON_PIECES = path.join(ENGINE_ADAPTER, "community-pieces");
// piece loader MUST be configured BEFORE the engine bundle is required.
process.env.AP_CUSTOM_PIECES_PATHS = `${TICK_GROW}:${JSON_PIECES}`;

const PORT = Number(process.env.PORT ?? "3997");
const ENGINE_TOKEN = "dev-engine-token";
const PROJECT_ID = "demo-project";

// growing item count per tick (1-based index): tick1->2, tick2->3, tick3->3
const COUNT_BY_TICK: Record<number, number> = { 1: 2, 2: 3, 3: 3 };

async function main() {
  const { Vault } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/vault.js"));
  const { MemoryStore } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/store.js"));
  const { MemoryFileStore } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/files.js"));
  const { createServer } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/server.js"));
  const { runReactivePoll } = await import("./poll-runner.ts");

  const server = createServer({
    vault: new Vault("dev-master-key-16chars"),
    store: new MemoryStore(),
    files: new MemoryFileStore(),
    engineToken: ENGINE_TOKEN,
    project: { id: PROJECT_ID, externalId: "demo-ext" },
  });

  await new Promise<void>((res) => server.listen(PORT, () => res()));
  console.log(`[demo] backend-mock listening on http://localhost:${PORT}`);

  try {
    const result = await runReactivePoll({
      triggerSpec: {
        pieceName: "@automators/piece-tick",
        pieceVersion: "0.1.0",
        triggerName: "new_tick",
        input: {},
      },
      // Body: parse a JSON string that EMBEDS the seeded trigger item.
      // The flow output (json1.output) will reflect the per-item value -> proof of seed.
      flowSteps: [
        {
          name: "json1",
          pieceName: "@activepieces/piece-json",
          pieceVersion: "0.1.8",
          actionName: "convert_text_to_json",
          inputFor: (item: any) => ({
            text: JSON.stringify({ seededItem: item, gotId: item?.id }),
          }),
        },
      ],
      intervalMs: 500,
      maxTicks: 3,
      port: PORT,
      engineToken: ENGINE_TOKEN,
      projectId: PROJECT_ID,
      idField: "id",
      beforeTick: (tick) => {
        process.env.TICK_COUNT = String(COUNT_BY_TICK[tick] ?? 3);
      },
    });

    console.log("\n=== NEW ITEMS PER TICK ===");
    console.log(JSON.stringify(result.newItemsPerTick), "(expected [2,1,0])");

    console.log("\n=== FIRED LOG (1 entry per NEW item) ===");
    for (const f of result.fired) {
      const out = (f.flowSteps as any)?.json1?.output;
      console.log(
        `tick=${f.tick} item=${JSON.stringify(f.item)} flowStatus=${JSON.stringify(
          f.flowStatus,
        )} json1.output=${JSON.stringify(out)}`,
      );
    }
    console.log(`\n[demo] total flow firings = ${result.fired.length} (expected 3)`);
    console.log(`[demo] final seen cursor = ${JSON.stringify(result.seen)}`);
  } catch (e: any) {
    console.log("\n=== THREW ===");
    console.log(e?.stack ?? e);
  } finally {
    server.close(() => process.exit(0));
  }
}

main();
