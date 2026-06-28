// One handler per product route. Pure-ish: each takes the parsed inputs and
// returns { status, body } so the server stays a thin dispatcher.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { FileCursorStore } from "../../trigger-runtime/src/cursor-store.js";
import {
  buildFlowFromRequest,
  type ExecuteRequest,
  type PieceStepReq,
} from "../../flow-builder/src/flow-builder.js";
import { validateActionInput } from "../../flow-builder/src/validate-input.js";
import { generateOkfCatalog } from "../../okf-generator/src/okf-generator.js";
import type { OkfFile } from "../../okf-generator/src/types.js";
import {
  appendRun,
  flowRunFromResult,
  listRuns,
  getRun,
} from "../../run-logger/src/run-store.js";
import { demoPieces } from "./pieces-catalog.js";
import { MOCK_PORT, ENGINE_TOKEN, PROJECT_ID } from "./mock-backend.js";
import {
  startReactivePoll,
  type TriggerSpec as RunnerTriggerSpec,
  type StepSpec as RunnerStepSpec,
} from "../../trigger-runtime/src/poll-runner.js";
import {
  registerTrigger,
  getTrigger,
  removeTrigger,
  registerWebhookTrigger,
  getWebhookTrigger,
  removeWebhookTrigger,
  type WebhookTriggerSpec,
  type WebhookStepSpec,
  type WebhookRegistration,
} from "./trigger-registry.js";

const require = createRequire(import.meta.url);
// Persisted cursor store for POLLING triggers: keeps `seen` on disk so the
// dedup cursor survives runner restarts. One shared instance for all triggers;
// each triggerId gets its own <dir>/<triggerId>.json.
const CURSOR_DIR = path.resolve(process.cwd(), ".cursors");
const pollingCursorStore = new FileCursorStore(CURSOR_DIR);

// Repo de run-history (OKF + git por run). Configurable vía env; default bajo
// ~/product/.run-history. Best-effort: SIEMPRE se registra tras cada executeFlow
// (manual/webhook), pero un fallo del run-history NUNCA rompe la respuesta del
// endpoint (recordRunBestEffort traga todo).
const RUNS_REPO = process.env.RUNS_REPO ?? path.join(os.homedir(), "product/.run-history");

// Registra un run en el run-history a partir del resultado del engine. Best-effort:
// captura cualquier error internamente para no propagarlo al caller. `await` para
// que el smoke vea los commits de forma determinista (el coste es ~un commit/run).
async function recordRunBestEffort(args: {
  source: string;
  startedAt: string;
  finishedAt: string;
  verdict: { status: string; failedStep?: string };
  steps: Record<string, { status: string; output: unknown; errorMessage?: string }>;
  error?: { name?: string; message?: string; stack?: string };
}): Promise<void> {
  try {
    const run = flowRunFromResult({
      runId: randomUUID(),
      source: args.source,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
      verdict: args.verdict,
      steps: args.steps,
      ...(args.error ? { error: args.error } : {}),
    });
    await appendRun(run, { repoDir: RUNS_REPO });
  } catch (e) {
    console.error(`[run-history] record failed: ${(e as Error)?.message ?? e}`);
  }
}


const { executeFlow } = require("../../engine-adapter/src/execute-flow.cjs") as {
  executeFlow: (args: {
    action: unknown;
    port: string;
    engineToken?: string;
    projectId?: string;
    platformId?: string;
    stepNames?: string[];
  }) => Promise<{
    verdict: { status: string; failedStep?: string };
    steps: Record<string, { status: string; output: unknown; errorMessage?: string }>;
  }>;
};
// Engine bundle: exposes triggerHookOperation.execute (the same entry point
// run-trigger-probe.ts and poll-runner use to run a trigger's RUN/TEST/ON_ENABLE).
const { triggerHookOperation } = require("../../engine-adapter/dist/engine.cjs") as {
  triggerHookOperation: { execute: (op: unknown) => Promise<unknown> };
};

// --- catalog (built once; OKF is a pure function of the metadata) ---
const catalog: OkfFile[] = generateOkfCatalog(demoPieces);
const catalogByPath = new Map(catalog.map((f) => [f.path, f]));

// Índice de props por action, construido una vez desde las demo pieces: clave
// "<pieceName>|<actionName>" -> Record<propName, {type, required}>. Lo usa
// handleExecute para validar el input del agente ANTES de ejecutar (A2E).
//
// CAMINO AL CATÁLOGO COMPLETO: hoy sólo las pieces demo (json + echo-auth) están
// indexadas. Para validar cualquier piece del catálogo community, construir este
// índice desde la metadata real (piece.metadata()): reusar load-one-piece.mjs
// (engine-adapter), que bundlea + requiere la piece y emite un PieceMetadataInput
// con props por action; indexar todos sus actions aquí. El validador
// (validateActionInput) ya es agnóstico: sólo necesita el Record de props.
// Una action no encontrada en el índice se SALTA la validación (no bloqueamos
// requests de pieces no indexadas) — al indexar el catálogo completo, todas las
// actions conocidas pasarían por el gate.
const actionPropsIndex = new Map<string, Record<string, { type: string; required: boolean }>>();
for (const piece of demoPieces) {
  for (const action of Object.values(piece.actions)) {
    const props: Record<string, { type: string; required: boolean }> = {};
    for (const [k, v] of Object.entries(action.props ?? {})) {
      props[k] = { type: v.type, required: v.required };
    }
    actionPropsIndex.set(`${piece.name}|${action.name}`, props);
  }
}

export interface HandlerResult {
  status: number;
  body: unknown; // string => served as text/markdown; object => JSON
}

// GET /catalog -> root OKF index markdown.
export function handleCatalog(): HandlerResult {
  const root = catalogByPath.get("index.md");
  if (!root) return { status: 500, body: { error: "catalog index not generated" } };
  return { status: 200, body: root.content };
}

// GET /pieces/:name -> that piece's index.md markdown, or 404.
export function handlePiece(name: string): HandlerResult {
  const file = catalogByPath.get(`${name}/index.md`);
  if (!file) return { status: 404, body: { error: `piece not found: ${name}` } };
  return { status: 200, body: file.content };
}

// POST /execute -> validate each step's input, build flow, run it, return REAL result.
export async function handleExecute(req: ExecuteRequest): Promise<HandlerResult> {
  // A2E: valida el input de cada piece step contra las props de su action ANTES
  // de construir/ejecutar. Si algún step es inválido, 400 con errores claros por
  // step y NO se ejecuta el flow. Router/loop steps (sin pieceName+actionName) y
  // actions no indexadas se saltan (ver nota en actionPropsIndex).
  const stepResults: Array<{ name: string; errors: string[] }> = [];
  if (Array.isArray(req.steps)) {
    for (const s of req.steps) {
      const ps = s as PieceStepReq;
      if (!ps.pieceName || !ps.actionName) continue; // router/loop o sin acción
      const props = actionPropsIndex.get(`${ps.pieceName}|${ps.actionName}`);
      if (!props) continue; // piece no indexada -> no se puede validar, no se bloquea
      const res = validateActionInput(ps.input ?? {}, props);
      if (!res.ok) {
        stepResults.push({
          name: ps.name ?? `${ps.pieceName}/${ps.actionName}`,
          errors: res.errors,
        });
      }
    }
  }
  if (stepResults.length > 0) {
    return {
      status: 400,
      body: { error: "validation_failed", steps: stepResults },
    };
  }

  let action: unknown;
  try {
    action = buildFlowFromRequest(req, new Date().toISOString());
  } catch (e) {
    return { status: 400, body: { error: `invalid request: ${(e as Error).message}` } };
  }

  const startedAt = new Date().toISOString();
  try {
    const result = await executeFlow({
      action,
      port: String(MOCK_PORT),
      engineToken: ENGINE_TOKEN,
      projectId: PROJECT_ID,
    });
    const finishedAt = new Date().toISOString();
    const verdict = result.verdict ?? { status: "UNKNOWN" };
    const stepsMap = result.steps ?? {};
    // Run-history best-effort: NO rompe la respuesta si falla.
    await recordRunBestEffort({ source: "manual", startedAt, finishedAt, verdict, steps: stepsMap });
    const stepNames = Object.keys(stepsMap);
    const last = stepNames[stepNames.length - 1];
    const step = last ? stepsMap[last] : undefined;
    return {
      status: 200,
      body: {
        status: step?.status ?? String(result.verdict),
        output: step?.output ?? null,
        ...(step?.errorMessage ? { error: step.errorMessage } : {}),
      },
    };
  } catch (e) {
    const finishedAt = new Date().toISOString();
    // Registra el run FAILED aunque executeFlow haya lanzado (ej. piece inexistente).
    await recordRunBestEffort({
      source: "manual",
      startedAt,
      finishedAt,
      verdict: { status: "FAILED" },
      steps: {},
      error: {
        name: (e as Error)?.name,
        message: (e as Error)?.message,
        stack: (e as Error)?.stack,
      },
    });
    return { status: 500, body: { error: `execution failed: ${(e as Error).message}` } };
  }
}

// --- run-history endpoints ------------------------------------------------

// GET /runs -> { dates: [...], runs: [...] } (fechas disponibles + runs recientes
// o, con ?date=YYYY-MM-DD, los runs de ese día).
export async function handleListRuns(date?: string): Promise<HandlerResult> {
  const { dates, runs } = await listRuns({ repoDir: RUNS_REPO, date });
  return { status: 200, body: { dates, runs } };
}

// GET /runs/:date/:runId -> el markdown del run, o 404.
export async function handleGetRun(date: string, runId: string): Promise<HandlerResult> {
  const md = await getRun({ repoDir: RUNS_REPO, date, runId });
  if (md == null) return { status: 404, body: { error: `run not found: ${date}/${runId}` } };
  return { status: 200, body: md };
}

// --- reactive triggers -----------------------------------------------------

// HTTP body for POST /triggers. flowSteps carry a STATIC input (functions cannot
// cross HTTP); the runner fires the body once per NEW trigger item, and each
// FiredRecord still records the real `item` that triggered it. Per-item input
// templating is a future extension (would need a string-interpolation convention).
export interface TriggerStepSpec {
  name: string;
  pieceName: string;
  pieceVersion: string;
  actionName: string;
  input?: Record<string, unknown>;
}

export interface CreateTriggerRequest {
  triggerSpec: {
    pieceName: string;
    pieceVersion?: string;
    triggerName: string;
    input?: Record<string, unknown>;
  };
  flowSteps: TriggerStepSpec[];
  intervalMs: number;
  idField?: string;
}

// POST /triggers -> start a continuous reactive poll loop, return its id.
export function handleCreateTrigger(req: CreateTriggerRequest): HandlerResult {
  const { triggerSpec, flowSteps, intervalMs } = req;
  if (!triggerSpec || !triggerSpec.pieceName || !triggerSpec.triggerName) {
    return { status: 400, body: { error: "triggerSpec.{pieceName,triggerName} are required" } };
  }
  if (!Array.isArray(flowSteps) || flowSteps.length === 0) {
    return { status: 400, body: { error: "flowSteps must be a non-empty array" } };
  }
  if (typeof intervalMs !== "number" || intervalMs <= 0) {
    return { status: 400, body: { error: "intervalMs must be a positive number" } };
  }

  const runnerTriggerSpec: RunnerTriggerSpec = {
    pieceName: triggerSpec.pieceName,
    pieceVersion: triggerSpec.pieceVersion ?? "0.1.0",
    triggerName: triggerSpec.triggerName,
    input: triggerSpec.input ?? {},
  };
  // Static input per step: inputFor ignores the item (see note on TriggerStepSpec).
  const runnerSteps: RunnerStepSpec[] = flowSteps.map((s) => ({
    name: s.name,
    pieceName: s.pieceName,
    pieceVersion: s.pieceVersion,
    actionName: s.actionName,
    inputFor: () => s.input ?? {},
  }));

  const triggerId = randomUUID();
  // The runner targets the in-process mock backend, same as /execute.
  const handle = startReactivePoll({
    triggerSpec: runnerTriggerSpec,
    flowSteps: runnerSteps,
    intervalMs,
    port: MOCK_PORT,
    engineToken: ENGINE_TOKEN,
    projectId: PROJECT_ID,
    idField: req.idField ?? "id",
    // Dedup cursor persisted to disk so items already seen before a restart
    // are NOT re-fired on resume. Public API (request/response shape) unchanged.
    cursorStore: pollingCursorStore,
    triggerId,
  });
  registerTrigger(triggerId, handle);

  return { status: 201, body: { triggerId } };
}

// GET /triggers/:id -> live state of one reactive loop.
export function handleGetTrigger(id: string): HandlerResult {
  const entry = getTrigger(id);
  if (!entry) return { status: 404, body: { error: `trigger not found: ${id}` } };
  const { state } = entry.handle;
  return {
    status: 200,
    body: {
      triggerId: id,
      running: state.running,
      ticks: state.ticks,
      firedCount: state.firedCount,
      fired: state.fired,
    },
  };
}

// DELETE /triggers/:id -> stop the loop and drop it from the registry.
export function handleDeleteTrigger(id: string): HandlerResult {
  const stopped = removeTrigger(id);
  if (!stopped) return { status: 404, body: { error: `trigger not found: ${id}` } };
  return { status: 200, body: { stopped: true } };
}

export const piecePaths = catalog.map((f) => f.path);

// ===========================================================================
// WEBHOOK ingress (triggers of type WEBHOOK).
//
// Two routes:
//   POST /webhook-triggers       -> register a passive WEBHOOK trigger; returns
//                                   { triggerId, webhookUrl: "/webhooks/<id>" }.
//   POST /webhooks/:triggerId     -> ingress: run the trigger's RUN hook with the
//                                   inbound HTTP event as triggerPayload, then fire
//                                   the body flow once per item returned. Returns
//                                   { fired: N, results: [...] }.
//
// The trigger's run() receives context.payload = the resolved TriggerPayload
// (engine-operation.ts): { body, rawBody?, method?, headers, queryParams }.
// Our demo piece @automators/piece-hook returns [context.payload.body], so each
// inbound body becomes one item. Per-item templating: a step input string equal
// to "{{item}}" is replaced with JSON.stringify(item) at ingress time (functions
// cannot cross HTTP, so this is the MVP seed mechanism — same role as
// poll-runner's StepSpec.inputFor(item)).
// ===========================================================================

export interface CreateWebhookTriggerRequest {
  triggerSpec: WebhookTriggerSpec;
  flowSteps: WebhookStepSpec[];
}

// POST /webhook-triggers -> register, return id + webhookUrl.
export function handleCreateWebhookTrigger(
  req: CreateWebhookTriggerRequest,
): HandlerResult {
  const { triggerSpec, flowSteps } = req;
  if (
    !triggerSpec ||
    !triggerSpec.pieceName ||
    !triggerSpec.triggerName
  ) {
    return {
      status: 400,
      body: { error: "triggerSpec.{pieceName,triggerName} are required" },
    };
  }
  if (!Array.isArray(flowSteps) || flowSteps.length === 0) {
    return { status: 400, body: { error: "flowSteps must be a non-empty array" } };
  }
  for (const s of flowSteps) {
    if (!s.name || !s.pieceName || !s.actionName) {
      return {
        status: 400,
        body: { error: "each flowStep needs {name, pieceName, actionName}" },
      };
    }
  }

  const registration: WebhookRegistration = {
    triggerSpec: {
      pieceName: triggerSpec.pieceName,
      pieceVersion: triggerSpec.pieceVersion ?? "0.1.0",
      triggerName: triggerSpec.triggerName,
      input: triggerSpec.input ?? {},
    },
    flowSteps,
  };
  const triggerId = randomUUID();
  registerWebhookTrigger(triggerId, registration);
  return {
    status: 201,
    body: { triggerId, webhookUrl: `/webhooks/${triggerId}` },
  };
}

// GET /webhook-triggers/:id -> the stored registration (no live state; the
// trigger is passive until a POST hits its webhookUrl).
export function handleGetWebhookTrigger(id: string): HandlerResult {
  const entry = getWebhookTrigger(id);
  if (!entry) return { status: 404, body: { error: `webhook trigger not found: ${id}` } };
  return {
    status: 200,
    body: { triggerId: id, registration: entry.registration, webhookUrl: `/webhooks/${id}` },
  };
}

// DELETE /webhook-triggers/:id -> drop the registration.
export function handleDeleteWebhookTrigger(id: string): HandlerResult {
  const removed = removeWebhookTrigger(id);
  if (!removed) return { status: 404, body: { error: `webhook trigger not found: ${id}` } };
  return { status: 200, body: { stopped: true } };
}

// Build the ExecuteTriggerOperation for a WEBHOOK RUN. Mirrors poll-runner's
// makeRunOperation, but the triggerPayload value is the inbound HTTP event
// (the TriggerPayload shape), not an empty object.
function makeWebhookRunOperation(
  spec: WebhookTriggerSpec,
  event: { body: unknown; headers: Record<string, string>; queryParams: Record<string, string>; method: string },
): unknown {
  const base = `http://localhost:${MOCK_PORT}`;
  return {
    hookType: "RUN",
    test: false,
    flowVersion: {
      id: "demo-flow-version",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      flowId: "demo-flow",
      displayName: "Webhook Flow",
      trigger: {
        name: spec.triggerName,
        valid: true,
        displayName: spec.triggerName,
        type: "PIECE",
        settings: {
          pieceName: spec.pieceName,
          pieceVersion: spec.pieceVersion ?? "0.1.0",
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
    },
    webhookUrl: `${base}/webhook`,
    // Inline JobPayload: engine's resolveJobPayload unwraps `.value` and hands
    // it to the trigger as context.payload (see engine trigger-hook.operation.ts
    // + resolve-job-payload.ts). value = TriggerPayload {body,headers,queryParams,method}.
    triggerPayload: {
      type: "inline",
      value: {
        body: event.body,
        headers: event.headers,
        queryParams: event.queryParams,
        method: event.method,
      },
    },
    projectId: PROJECT_ID,
    platformId: "demo-platform",
    engineToken: ENGINE_TOKEN,
    internalApiUrl: `${base}/`,
    publicApiUrl: `${base}/api/`,
    timeoutInSeconds: 60,
  };
}

// Replace "{{item}}" string tokens in a step's input with JSON.stringify(item).
// Recurses into nested objects/arrays. Anything else is left untouched.
function templateItemInput(
  input: Record<string, unknown> | undefined,
  item: unknown,
): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (v === "{{item}}") return JSON.stringify(item);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const resolved = walk(input ?? {});
  return (resolved && typeof resolved === "object" ? resolved : {}) as Record<string, unknown>;
}

export interface WebhookIngressResult {
  status: number;
  body: unknown;
}

// POST /webhooks/:triggerId -> run the trigger with the inbound event, fire the
// body flow once per item, return { fired, results }.
export async function handleWebhookIngress(
  triggerId: string,
  event: { body: unknown; headers: Record<string, string>; queryParams: Record<string, string>; method: string },
): Promise<WebhookIngressResult> {
  const entry = getWebhookTrigger(triggerId);
  if (!entry) {
    return { status: 404, body: { error: `webhook trigger not found: ${triggerId}` } };
  }
  const { registration } = entry;

  let runRes: { response?: { output?: unknown[] } };
  try {
    runRes = (await triggerHookOperation.execute(
      makeWebhookRunOperation(registration.triggerSpec, event),
    )) as { response?: { output?: unknown[] } };
  } catch (e) {
    return {
      status: 502,
      body: { error: `trigger RUN failed: ${(e as Error).message}` },
    };
  }

  const items: unknown[] = runRes?.response?.output ?? [];
  const results: Array<{ status: string; output: unknown; errorMessage?: string }> = [];

  for (const item of items) {
    const steps = registration.flowSteps.map((s) => ({
      name: s.name,
      pieceName: s.pieceName,
      pieceVersion: s.pieceVersion,
      actionName: s.actionName,
      input: templateItemInput(s.input, item),
    }));
    const action = buildFlowFromRequest({ steps } as ExecuteRequest, new Date().toISOString());
    const startedAt = new Date().toISOString();
    let result: {
      verdict: { status: string; failedStep?: string };
      steps: Record<string, { status: string; output: unknown; errorMessage?: string }>;
    };
    try {
      result = await executeFlow({
        action,
        port: String(MOCK_PORT),
        engineToken: ENGINE_TOKEN,
        projectId: PROJECT_ID,
        platformId: "demo-platform",
      });
    } catch (e) {
      const finishedAt = new Date().toISOString();
      // Run-history best-effort para el path reactivo de webhooks.
      await recordRunBestEffort({
        source: "webhook",
        startedAt,
        finishedAt,
        verdict: { status: "FAILED" },
        steps: {},
        error: { name: (e as Error)?.name, message: (e as Error)?.message, stack: (e as Error)?.stack },
      });
      results.push({
        status: "FAILED",
        output: null,
        errorMessage: (e as Error).message,
      });
      continue;
    }
    const finishedAt = new Date().toISOString();
    const verdict = result.verdict ?? { status: "UNKNOWN" };
    const stepsMap = result.steps ?? {};
    // Run-history best-effort para el path reactivo de webhooks.
    await recordRunBestEffort({ source: "webhook", startedAt, finishedAt, verdict, steps: stepsMap });
    const stepNames = Object.keys(stepsMap);
    const last = stepNames[stepNames.length - 1];
    const step = last ? stepsMap[last] : undefined;
    results.push({
      status: step?.status ?? String(result.verdict),
      output: step?.output ?? null,
      ...(step?.errorMessage ? { errorMessage: step.errorMessage } : {}),
    });
  }

  return { status: 200, body: { fired: items.length, results } };
}