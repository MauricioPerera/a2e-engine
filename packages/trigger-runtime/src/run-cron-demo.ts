// run-cron-demo.ts — proves CRON-driven scheduling end-to-end:
//   - boots backend-mock inline,
//   - registers a POLLING trigger (@automators/piece-tick-cron) whose ON_ENABLE calls
//     setSchedule('* * * * *') so the engine returns scheduleOptions.cronExpression,
//   - starts the reactive loop with useCron:true: the loop invokes ON_ENABLE,
//     reads the cron, and schedules each RUN at nextRun(cron, now) — NOT at a
//     hard-coded intervalMs (the intervalMs here is only a fallback that is NOT
//     used because the cron is present),
//   - aligns start to just before a minute boundary so '* * * * *' fires within
//     a few seconds (5-field cron has minute granularity; we cannot use seconds
//     because the engine's setSchedule validates 5-field only),
//   - bumps TICK_COUNT via beforeTick so the first cron fire yields 1 NEW item,
//     which fires the body flow once (status SUCCEEDED),
//   - prints the scheduleOptions, the scheduled nextRun, the actual fire
//   wall-clock time (proving the fire lands on the minute boundary, not on
//   intervalMs), and the flow output, then tears everything down.
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ADAPTER = path.resolve(__dirname, "../../engine-adapter");

const CRON_PIECE = path.join(ENGINE_ADAPTER, "custom-pieces-tick-cron/dist");
const JSON_PIECES = path.join(ENGINE_ADAPTER, "community-pieces");
// piece loader MUST be configured BEFORE the engine bundle is required.
process.env.AP_CUSTOM_PIECES_PATHS = `${CRON_PIECE}:${JSON_PIECES}`;
process.env.CRON_EXPR = "* * * * *"; // 5-field, minute precision (engine enforces)

const PORT = Number(process.env.PORT ?? "3998");
const ENGINE_TOKEN = "dev-engine-token";
const PROJECT_ID = "demo-project";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Wait until the wall clock is within the last ~3s of a minute, so the next
// '* * * * *' boundary is only a few seconds away (keeps the smoke fast while
// staying a real 5-field cron fire — no clock faking).
async function alignNearMinuteBoundary() {
  for (;;) {
    const s = new Date().getSeconds();
    if (s >= 57) return;
    await sleep(250);
  }
}

async function main() {
  const { Vault } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/vault.js"));
  const { MemoryStore } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/store.js"));
  const { MemoryFileStore } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/files.js"));
  const { createServer } = await import(path.join(ENGINE_ADAPTER, "../backend-mock/src/server.js"));
  const { startReactivePoll } = await import("./poll-runner.ts");
  const { nextRun } = await import("./cron.ts");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const engine = require(path.join(ENGINE_ADAPTER, "dist/engine.cjs")) as {
    triggerHookOperation: { execute: (op: unknown) => Promise<any> };
  };

  const server = createServer({
    vault: new Vault("dev-master-key-16chars"),
    store: new MemoryStore(),
    files: new MemoryFileStore(),
    engineToken: ENGINE_TOKEN,
    project: { id: PROJECT_ID, externalId: "demo-ext" },
  });
  await new Promise<void>((res) => server.listen(PORT, () => res()));
  console.log(`[cron-demo] backend-mock listening on http://localhost:${PORT}`);

  try {
    // 1) Evidence: call ON_ENABLE directly and print scheduleOptions.
    const base = `http://localhost:${PORT}`;
    const flowVersion = {
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
    const onEnableRes = await engine.triggerHookOperation.execute({
      hookType: "ON_ENABLE",
      test: false,
      flowVersion,
      webhookUrl: `${base}/webhook`,
      triggerPayload: { type: "inline", value: {} },
      projectId: PROJECT_ID,
      platformId: "demo-platform",
      engineToken: ENGINE_TOKEN,
      internalApiUrl: `${base}/`,
      publicApiUrl: `${base}/api/`,
      timeoutInSeconds: 60,
    });
    console.log("\n=== ON_ENABLE scheduleOptions (raw) ===");
    console.log(JSON.stringify(onEnableRes?.response?.scheduleOptions));
    const cron = onEnableRes?.response?.scheduleOptions?.cronExpression as string | undefined;
    console.log("cronExpression =", cron);

    // 2) Align near the minute boundary so the first fire is seconds away.
    const beforeAlign = new Date();
    await alignNearMinuteBoundary();
    const alignedAt = new Date();
    console.log(
      `\n[cron-demo] aligned to second ${alignedAt.getSeconds()} (waited ~${Math.round(
        (alignedAt.getTime() - beforeAlign.getTime()) / 1000,
      )}s)`,
    );

    // 3) Compute and print the scheduled next fire (what the loop will wait for).
    const scheduled = nextRun(cron ?? "* * * * *", alignedAt);
    console.log("[cron-demo] nextRun(cron, now) =", scheduled.toISOString(), `| seconds=${scheduled.getSeconds()}`);

    // 4) Start the reactive loop in CRON mode. intervalMs is a FALLBACK only;
    //    because the cron is present, the loop must NOT use it. We set it to a
    //    value clearly different from the cron cadence so a mis-schedule would
    //    be obvious.
    process.env.TICK_COUNT = "0";
    const handle = startReactivePoll({
      triggerSpec: {
        pieceName: "@automators/piece-tick-cron",
        pieceVersion: "0.1.0",
        triggerName: "new_tick",
        input: {},
      },
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
      intervalMs: 30000, // fallback only; NOT used while cron is active
      port: PORT,
      engineToken: ENGINE_TOKEN,
      projectId: PROJECT_ID,
      idField: "id",
      useCron: true,
      beforeTick: (tick) => {
        // tick1 -> 1 item (1 NEW); later ticks grow but we stop after first fire.
        process.env.TICK_COUNT = String(Math.max(1, tick));
      },
    });

    console.log(
      `[cron-demo] loop started; mode=${handle.state.mode} cron=${handle.state.cron}`,
    );

    // 5) Poll for the first real cron-driven fire.
    const deadline = Date.now() + 75_000;
    let lastCount = 0;
    while (Date.now() < deadline && handle.state.firedCount < 1) {
      await sleep(250);
    }

    console.log("\n=== FIRED (cron-driven) ===");
    console.log(`ticks=${handle.state.ticks} firedCount=${handle.state.firedCount}`);
    for (const f of handle.state.fired) {
      const fired = new Date(f.firedAt);
      const out = (f.flowSteps as any)?.json1?.output;
      console.log(
        `tick=${f.tick} firedAt=${fired.toISOString()} (sec=${fired.getSeconds()}) item=${JSON.stringify(
          f.item,
        )} flowStatus=${JSON.stringify(f.flowStatus)} json1.output=${JSON.stringify(out)}`,
      );
    }

    // 6) Verdict.
    const fired0 = handle.state.fired[0];
    const ok =
      handle.state.mode === "cron" &&
      handle.state.cron === "* * * * *" &&
      handle.state.firedCount >= 1 &&
      fired0?.flowStatus?.status === "SUCCEEDED" &&
      fired0?.firedAt >= scheduled.getTime() - 1500 &&
      fired0?.firedAt <= scheduled.getTime() + 1500;
    console.log(`\n[cron-demo] mode=${handle.state.mode} cron=${handle.state.cron}`);
    console.log(
      `[cron-demo] scheduled fire ~${scheduled.toISOString()} | actual fire ${
        fired0 ? new Date(fired0.firedAt).toISOString() : "NONE"
      }`,
    );
    console.log(`[cron-demo] VERDICT: ${ok ? "CRON E2E OK" : "NOT OK"} (firedCount=${handle.state.firedCount})`);

    handle.stop();
  } catch (e: any) {
    console.log("\n=== THREW ===");
    console.log(e?.stack ?? e);
  } finally {
    server.close(() => process.exit(0));
  }
}

main();