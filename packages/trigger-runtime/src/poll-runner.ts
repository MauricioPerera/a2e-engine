// poll-runner.ts — REACTIVE POLLING loop for triggers.
//
// Closes the reactive loop: every tick it invokes a POLLING trigger's
// RUN hook (via the engine bundle, same pattern as run-trigger-probe.ts),
// dedups the returned items against an accumulated cursor (selectNewItems from
// dedup.ts), and fires the body flow ONCE PER NEW ITEM (never once per poll).
//
// Two scheduling modes:
//   - INTERVAL (default, original): each tick is spaced by `intervalMs`.
//   - CRON (opt-in via `useCron` or explicit `cron`): at loop start the trigger's
//     ON_ENABLE hook is invoked to obtain scheduleOptions.cronExpression (the
//     same object the engine returns for POLLING triggers — see trigger-helper's
//     setSchedule). Each tick is then scheduled at nextRun(cron, now) (from
//     cron.ts), re-programmed after every tick. If ON_ENABLE yields no cron (or
//     useCron is false and no cron is given), the loop falls back to intervalMs —
//     so existing callers (run-reactive-demo.ts, product-api /triggers) keep
//     working unchanged.
//
// Seeding the trigger item into the flow body:
//   The engine bundle only exports EngineConstants / FlowExecutorContext /
//   flowExecutor / triggerHelper / triggerHookOperation. GenericStepOutput is
//   NOT exported, so we cannot pre-seed a step output object into the initial
//   ExecutionState from outside the bundle. Instead we seed the item the way the
//   engine itself resolves data: we materialize the item as a JSON literal and
//   pass it to the body StepSpecs via an `itemInjector(item)` callback that the
//   caller uses to template the item into the step inputs (exactly how
//   run-loop-e2e.ts injects `{{loop1.output.item}}`). The flow output then
//   reflects the per-item value — see run-reactive-demo.ts for evidence.
//
// No global state: `seen` lives on the loop call; the function is otherwise pure
// orchestration over the injected engine + flow-builder.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { nextRun } from "./cron.ts";
import type { CursorStore } from "./cursor-store.ts";
import { randomUUID } from "node:crypto";
import { appendRun, flowRunFromResult } from "../../run-logger/src/run-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const ENGINE_ADAPTER = path.resolve(__dirname, "../../engine-adapter");

// Repo de run-history para el path reactivo de poll (opt-in via env). Si no se
// setea, el loop NO registra runs (comportamiento previo). Best-effort.
const RUNS_REPO = process.env.RUNS_REPO;

// Registra un run de poll en el run-history. Fire-and-forget desde el loop:
// traga todo internamente para no romper ni frenar la cadencia reactiva.
async function recordPollRun(
  repoDir: string,
  source: string,
  startedAt: string,
  finishedAt: string,
  result: any,
): Promise<void> {
  try {
    const run = flowRunFromResult({
      runId: randomUUID(),
      source,
      startedAt,
      finishedAt,
      verdict: result?.verdict ?? { status: "UNKNOWN" },
      steps: result?.steps ?? {},
    });
    await appendRun(run, { repoDir });
  } catch (e) {
    console.error(`[run-history] poll record failed: ${(e as Error)?.message ?? e}`);
  }
}

type EngineBundle = {
  triggerHookOperation: { execute: (op: unknown) => Promise<any> };
};
type ExecuteFlow = (args: {
  action: unknown;
  port: string | number;
  engineToken?: string;
  projectId?: string;
  platformId?: string;
}) => Promise<any>;

export type TriggerSpec = {
  pieceName: string;
  pieceVersion: string;
  triggerName: string;
  input?: Record<string, unknown>;
};

// A body step. `inputFor(item)` returns the step input with the trigger item
// seeded in (the caller decides how — e.g. JSON literal interpolation).
export type StepSpec = {
  name: string;
  pieceName: string;
  pieceVersion: string;
  actionName: string;
  inputFor: (item: unknown) => Record<string, unknown>;
};

export type FiredRecord = {
  tick: number;
  item: unknown;
  flowStatus: string;
  flowSteps: Record<string, unknown>;
  // Wall-clock time the flow was fired (ms since epoch). Useful to prove the
  // fire happened on the cron schedule rather than a hard-coded interval.
  firedAt: number;
};

export type PollRunnerArgs = {
  triggerSpec: TriggerSpec;
  flowSteps: StepSpec[];
  intervalMs: number;
  maxTicks: number;
  port: number;
  engineToken: string;
  projectId: string;
  platformId?: string;
  idField?: string;
  // Optional hook invoked right before each poll (used by the demo to bump
  // the growing item count). Receives the 1-based tick number.
  beforeTick?: (tick: number) => void | Promise<void>;
};

export type PollRunnerResult = {
  ticks: number;
  fired: FiredRecord[];
  // newItemsPerTick[i] = how many NEW items the i-th poll produced.
  newItemsPerTick: number[];
  seen: string[];
};

function loadEngine(): EngineBundle {
  return require(path.join(ENGINE_ADAPTER, "dist/engine.cjs")) as EngineBundle;
}
function loadExecuteFlow(): ExecuteFlow {
  return (require(path.join(ENGINE_ADAPTER, "src/execute-flow.cjs")) as { executeFlow: ExecuteFlow })
    .executeFlow;
}

function makeFlowVersion(spec: TriggerSpec) {
  return {
    id: "demo-flow-version",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    flowId: "demo-flow",
    displayName: "Reactive Poll Flow",
    trigger: {
      name: spec.triggerName,
      valid: true,
      displayName: spec.triggerName,
      type: "PIECE",
      settings: {
        pieceName: spec.pieceName,
        pieceVersion: spec.pieceVersion,
        triggerName: spec.triggerName,
        input: spec.input ?? {},
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

function makeRunOperation(spec: TriggerSpec, args: PollRunnerArgs) {
  const base = `http://localhost:${args.port}`;
  return {
    hookType: "RUN",
    test: false,
    flowVersion: makeFlowVersion(spec),
    webhookUrl: `${base}/webhook`,
    triggerPayload: { type: "inline", value: {} },
    projectId: args.projectId,
    platformId: args.platformId ?? "demo-platform",
    engineToken: args.engineToken,
    internalApiUrl: `${base}/`,
    publicApiUrl: `${base}/api/`,
    timeoutInSeconds: 60,
  };
}

// ON_ENABLE operation: same shape as RUN but hookType ON_ENABLE. The engine
// returns ExecuteOnEnableTriggerResponse = { listeners, scheduleOptions? } where
// scheduleOptions (POLLING only) = { type:'CRON_EXPRESSION', cronExpression, timezone }.
function makeOnEnableOperation(spec: TriggerSpec, args: { port: number; projectId: string; platformId?: string; engineToken: string }) {
  const base = `http://localhost:${args.port}`;
  return {
    hookType: "ON_ENABLE",
    test: false,
    flowVersion: makeFlowVersion(spec),
    webhookUrl: `${base}/webhook`,
    triggerPayload: { type: "inline", value: {} },
    projectId: args.projectId,
    platformId: args.platformId ?? "demo-platform",
    engineToken: args.engineToken,
    internalApiUrl: `${base}/`,
    publicApiUrl: `${base}/api/`,
    timeoutInSeconds: 60,
  };
}

// Fetch the cron expression a POLLING trigger advertises via ON_ENABLE.
// Returns undefined if the trigger has no scheduleOptions (e.g. its onEnable
// does not call context.setSchedule).
export async function fetchTriggerCron(
  engine: EngineBundle,
  spec: TriggerSpec,
  args: { port: number; projectId: string; platformId?: string; engineToken: string },
): Promise<string | undefined> {
  const res = await engine.triggerHookOperation.execute(makeOnEnableOperation(spec, args));
  const scheduleOptions = res?.response?.scheduleOptions;
  return scheduleOptions?.cronExpression;
}

// Build the chained PieceAction body for a given item by templating each
// step input via inputFor(item). Imports flow-builder lazily (ESM .ts).
async function buildBodyForItem(steps: StepSpec[], item: unknown) {
  const { buildFlowFromRequest } = await import(
    path.join(ENGINE_ADAPTER, "../flow-builder/src/flow-builder.ts")
  );
  const req = {
    steps: steps.map((s) => ({
      name: s.name,
      pieceName: s.pieceName,
      pieceVersion: s.pieceVersion,
      actionName: s.actionName,
      input: s.inputFor(item),
    })),
  };
  return buildFlowFromRequest(req as any, new Date().toISOString());
}

export async function runReactivePoll(args: PollRunnerArgs): Promise<PollRunnerResult> {
  const { selectNewItems } = await import("./dedup.ts");
  const engine = loadEngine();
  const executeFlow = loadExecuteFlow();

  let seen: string[] = [];
  const fired: FiredRecord[] = [];
  const newItemsPerTick: number[] = [];

  for (let tick = 1; tick <= args.maxTicks; tick++) {
    if (args.beforeTick) await args.beforeTick(tick);

    const runRes = await engine.triggerHookOperation.execute(
      makeRunOperation(args.triggerSpec, args),
    );
    const items: unknown[] = runRes?.response?.output ?? [];

    const sel = selectNewItems(items, seen, args.idField);
    seen = sel.seen;
    newItemsPerTick.push(sel.newItems.length);

    for (const item of sel.newItems) {
      const action = await buildBodyForItem(args.flowSteps, item);
      const result = await executeFlow({
        action,
        port: args.port,
        engineToken: args.engineToken,
        projectId: args.projectId,
        platformId: args.platformId,
      });
      fired.push({
        tick,
        item,
        flowStatus: result?.verdict ?? "UNKNOWN",
        flowSteps: result?.steps ?? {},
        firedAt: Date.now(),
      });
    }

    if (tick < args.maxTicks) {
      await new Promise((r) => setTimeout(r, args.intervalMs));
    }
  }

  return { ticks: args.maxTicks, fired, newItemsPerTick, seen };
}

// ---------------------------------------------------------------------------
// CONTINUOUS mode: runs the reactive poll loop indefinitely until stop().
//
// Mirrors runReactivePoll's per-tick logic (same RUN hook -> dedup ->
// executeFlow-per-new-item) but instead of a fixed maxTicks it loops forever.
// Scheduling is either by `intervalMs` (original) or by a cron expression
// (opt-in via `useCron`/`cron`): in cron mode the loop invokes ON_ENABLE once
// at startup to read scheduleOptions.cronExpression, then schedules every tick
// (including the first) at nextRun(cron, now). Falls back to intervalMs if no
// cron is available. Returns a handle whose `state` is read live (for GET
// /triggers/:id) and whose `stop()` halts the timer. runReactivePoll (maxTicks)
// is left untouched so the existing run-reactive-demo.ts keeps working as-is.
// ---------------------------------------------------------------------------

export type ReactiveState = {
  running: boolean;
  ticks: number;
  firedCount: number;
  fired: FiredRecord[];
  // Cron expression actually in use (undefined when running on intervalMs).
  cron?: string;
  // Scheduling mode in effect after bootstrap.
  mode: "interval" | "cron" | "pending";
};

export type ReactiveHandle = {
  state: ReactiveState;
  stop: () => void;
};

export type ContinuousPollArgs = Omit<PollRunnerArgs, "maxTicks"> & {
  // Opt-in: derive the schedule from the trigger's ON_ENABLE scheduleOptions.
  useCron?: boolean;
  // Explicit cron to use; overrides ON_ENABLE derivation when set.
  cron?: string;
  // Persisted dedup cursor (sobrevive reinicios). Si se omite, seen vive en
  // memoria (comportamiento original). Requiere triggerId para usarse.
  cursorStore?: CursorStore;
  // Identificador del trigger usado como clave del cursor persistido.
  triggerId?: string;
};

export function startReactivePoll(args: ContinuousPollArgs): ReactiveHandle {
  const engine = loadEngine();
  const executeFlow = loadExecuteFlow();

  const state: ReactiveState = {
    running: true,
    ticks: 0,
    firedCount: 0,
    fired: [],
    mode: "pending",
  };
  let seen: string[] = [];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // cron resolved at bootstrap; undefined => interval fallback.
  let cron: string | undefined = args.cron;

  const scheduleNext = () => {
    if (stopped) return;
    let delay: number;
    if (cron) {
      const ms = nextRun(cron, new Date()).getTime() - Date.now();
      delay = Math.max(0, ms);
    } else {
      delay = args.intervalMs;
    }
    timer = setTimeout(() => {
      void runTick();
    }, delay);
  };

  const runTick = async () => {
    if (stopped) return;
    state.ticks += 1;
    const tick = state.ticks;
    try {
      if (args.beforeTick) await args.beforeTick(tick);

      const { selectNewItems } = await import("./dedup.ts");
      const runRes = await engine.triggerHookOperation.execute(
        makeRunOperation(args.triggerSpec, args),
      );
      const items: unknown[] = runRes?.response?.output ?? [];

      const sel = selectNewItems(items, seen, args.idField);
      seen = sel.seen;
      // Persiste el cursor fuera del proceso (si hay store) tras cada tick,
      // para que un reinicio no re-dispare items ya vistos.
      if (args.cursorStore && args.triggerId) {
        try {
          await args.cursorStore.save(args.triggerId, seen);
        } catch (e) {
          console.error(
            `[reactive-poll] cursor save failed: ${(e as Error)?.message ?? e}`,
          );
        }
      }

      for (const item of sel.newItems) {
        const action = await buildBodyForItem(args.flowSteps, item);
        const runStartedAt = new Date().toISOString();
        const result = await executeFlow({
          action,
          port: args.port,
          engineToken: args.engineToken,
          projectId: args.projectId,
          platformId: args.platformId,
        });
        // Run-history best-effort para el path reactivo de poll. Sin await
        // (fire-and-forget) para no alterar la cadencia del loop.
        if (RUNS_REPO) {
          void recordPollRun(RUNS_REPO, "poll", runStartedAt, new Date().toISOString(), result);
        }
        state.fired.push({
          tick,
          item,
          flowStatus: result?.verdict ?? "UNKNOWN",
          flowSteps: result?.steps ?? {},
          firedAt: Date.now(),
        });
      }
      state.firedCount = state.fired.length;
    } catch (e) {
      // Keep the loop alive across per-tick failures; surface to stderr.
      console.error(
        `[reactive-poll] tick ${tick} error: ${(e as Error)?.message ?? e}`,
      );
    }

    if (stopped) return;
    scheduleNext();
  };

  // Bootstrap: resolve the cron (ON_ENABLE) if requested, then kick off.
  // Cron mode -> first tick is cron-scheduled (proves cron-driven firing).
  // Interval mode -> first tick runs immediately (original behavior).
  const bootstrap = async () => {
    if (args.cursorStore && args.triggerId) {
      try {
        seen = await args.cursorStore.load(args.triggerId);
      } catch (e) {
        console.error(
          `[reactive-poll] cursor load failed: ${(e as Error)?.message ?? e}`,
        );
      }
    }
    if (args.useCron && !cron) {
      try {
        cron = await fetchTriggerCron(engine, args.triggerSpec, args);
      } catch (e) {
        console.error(
          `[reactive-poll] ON_ENABLE cron fetch failed: ${(e as Error)?.message ?? e}`,
        );
      }
    }
    state.cron = cron;
    if (cron) {
      state.mode = "cron";
      console.log(`[reactive-poll] cron schedule: "${cron}"`);
      scheduleNext();
    } else {
      state.mode = "interval";
      console.log(`[reactive-poll] interval fallback: ${args.intervalMs}ms`);
      void runTick();
    }
  };
  void bootstrap();

  return {
    state,
    stop: () => {
      stopped = true;
      state.running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}