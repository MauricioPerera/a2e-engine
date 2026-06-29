// One handler per product route. Pure-ish: each takes the parsed inputs and
// returns { status, body } so the server stays a thin dispatcher.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { retrieve, type PieceSummary } from "../../okf-retriever/src/okf-retriever.js";
import { retrievePieces, retrieveActions, type ActionDetail } from "../../okf-retriever/src/two-level.js";
import { parseActionMd } from "./action-md-parser.js";
import { FileCursorStore } from "../../trigger-runtime/src/cursor-store.js";
import {
  buildFlowFromRequest,
  type ExecuteRequest,
  type PieceStepReq,
} from "../../flow-builder/src/flow-builder.js";
import { validateActionInput } from "../../flow-builder/src/validate-input.js";
import { flattenSteps } from "../../flow-builder/src/validate-workflow.js";
import { sanitizeSteps } from "../../flow-builder/src/sanitize-steps.js";
import {
  validateWorkflow,
  type CatalogPiece,
  type WfFinding,
} from "../../flow-builder/src/validate-workflow-context.js";
import { generateOkfCatalog } from "../../okf-generator/src/okf-generator.js";
import type { OkfFile } from "../../okf-generator/src/types.js";
import {
  appendRun,
  flowRunFromResult,
  listRuns,
  getRun,
} from "../../run-logger/src/run-store.js";
import {
  addEntry,
  listEntries,
  getEntry,
  attestEntry,
  getKnowledgeIndexMarkdown,
} from "../../knowledge-base/src/knowledge-store.js";
import type { KnowledgeEntry } from "../../knowledge-base/src/knowledge-base.js";
import {
  saveWorkflow,
  listWorkflows,
  getWorkflow,
  getIndexMarkdown,
} from "../../workflow-registry/src/workflow-store.js";
import type { WorkflowRecord, WorkflowStep } from "../../workflow-registry/src/workflow-registry.js";
import { demoPieces } from "./pieces-catalog.js";
import { MOCK_PORT, ENGINE_TOKEN, PROJECT_ID, getVault } from "./mock-backend.js";
import { assembleAgentContext } from "./assemble-agent-context.js";
import {
  renderConnectionRefs,
  filterByPiece,
} from "../../connection-provider/src/connection-provider.js";
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
import { generateSecret, verifySignature } from "./webhook-hmac.js";
import { discoverSource, type DiscoverOptions } from "../../piece-source-manager/src/discover.js";
import { buildSelectedPieces } from "../../piece-source-manager/src/build-source.js";
import { runAgent } from "../../agent-runtime/src/orchestrator.js";
import { callOllama } from "../../agent-runtime/src/ollama-provider.js";

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

// Repo de workflow-registry (OKF + git por workflow). Configurable vía env;
// default bajo ~/product/.workflow-registry. Aquí los fallos SÍ son fatales
// para el endpoint de guardado (el agente debe saber si su workflow no se
// persistió); listado/lectura son best-effort (repo vacío = lista vacía).
const WORKFLOWS_REPO = process.env.WORKFLOWS_REPO ?? path.join(os.homedir(), "product/.workflow-registry");

// Repo de knowledge-base (OKF + git por entry). Configurable vía env; default
// bajo ~/product/.knowledge-base. Los fallos de los endpoints de escritura
// (POST /knowledge, POST /knowledge/:id/attest) SÍ son fatales para esos
// endpoints; listado/lectura son best-effort (repo vacío = lista vacía).
const KNOWLEDGE_REPO = process.env.KNOWLEDGE_REPO ?? path.join(os.homedir(), "product/.knowledge-base");

// Registra un run en el run-history a partir del resultado del engine. Best-effort:
// captura cualquier error internamente para no propagarlo al caller. `await` para
// que el smoke vea los commits de forma determinista (el coste es ~un commit/run).
//
// BUCLE DE APRENDIZAJE: si el run resulta FAILED, crea BEST-EFFORT un stub de
// conocimiento (addEntry) con title "Run failed: <failedStep>", problem = el error,
// resolution = "" (a completar por humano/agente), sourceRunId = runId,
// tags=["auto","run-failure"], ttlDays corto (7). Opt-in vía KNOWLEDGE_REPO
// presente en el env (así otros flujos que no configuren knowledge-base no
// ensucian el repo por defecto). Nunca rompe la respuesta del endpoint: va
// dentro del try/catch best-effort y se traga sus propios fallos.
async function recordRunBestEffort(args: {
  source: string;
  startedAt: string;
  finishedAt: string;
  verdict: { status: string; failedStep?: string };
  steps: Record<string, { status: string; output: unknown; errorMessage?: string }>;
  error?: { name?: string; message?: string; stack?: string };
}): Promise<void> {
  try {
    const runId = randomUUID();
    const run = flowRunFromResult({
      runId,
      source: args.source,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
      verdict: args.verdict,
      steps: args.steps,
      ...(args.error ? { error: args.error } : {}),
    });
    await appendRun(run, { repoDir: RUNS_REPO });
    // BUCLE APRENDIZAJE: run FAILED -> stub de conocimiento best-effort.
    if (String(run.status).toUpperCase() === "FAILED" && process.env.KNOWLEDGE_REPO !== undefined) {
      try {
        await recordFailureKnowledgeStub(runId, run, args);
      } catch (e) {
        console.error(`[knowledge] failure-stub failed: ${(e as Error)?.message ?? e}`);
      }
    }
  } catch (e) {
    console.error(`[run-history] record failed: ${(e as Error)?.message ?? e}`);
  }
}

// Crea un stub de conocimiento a partir de un run FAILED. Best-effort: el caller
// (recordRunBestEffort) ya aísla los fallos. El stub queda con resolution vacía
// para que un humano/agente la complete luego (ésa es la "lección" pendiente).
async function recordFailureKnowledgeStub(
  runId: string,
  run: { failedStep?: string; error?: { name?: string; message?: string } },
  args: { error?: { name?: string; message?: string }; verdict?: { failedStep?: string } },
): Promise<void> {
  const failedStep =
    run.failedStep ??
    (typeof args.verdict?.failedStep === "string" ? args.verdict.failedStep : undefined) ??
    args.error?.name ??
    "unknown";
  const errName = args.error?.name ?? run.error?.name ?? "";
  const errMsg = args.error?.message ?? run.error?.message ?? "";
  const problem = [errName, errMsg].filter(Boolean).join(": ") || "execution failed";
  const now = new Date().toISOString();
  const entry: KnowledgeEntry = {
    id: randomUUID(),
    title: `Run failed: ${failedStep}`,
    tags: ["auto", "run-failure"],
    createdAt: now,
    updatedAt: now,
    ttlDays: 7,
    problem,
    resolution: "",
    sourceRunId: runId,
  };
  await addEntry(entry, { repoDir: KNOWLEDGE_REPO });
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

// --- okf_catalog provider: retriever estructural acotado a budget ---------------------
// Carga perezosa (cache en modulo) de catalog-summary.json: array de PieceSummary
// construido por okf-retriever/build-catalog-summary.mjs desde la metadata real del
// catalogo (710 pieces). Ruta via env CATALOG_SUMMARY; default al summary de
// okf-retriever (resuelto relativo a este archivo). Si no existe -> 503 con mensaje
// claro para que el agente sepa que falta el build (no un 500 silencioso).
const HANDLERS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG_SUMMARY = path.resolve(HANDLERS_DIR, "../../okf-retriever/catalog-summary.json");
let catalogSummaryCache: PieceSummary[] | null | undefined = undefined; // undefined = no intentado aun
function loadCatalogSummary(): PieceSummary[] | null {
  if (catalogSummaryCache !== undefined) return catalogSummaryCache;
  const p = process.env.CATALOG_SUMMARY ?? DEFAULT_CATALOG_SUMMARY;
  try {
    if (!existsSync(p)) { catalogSummaryCache = null; return null; }
    catalogSummaryCache = JSON.parse(readFileSync(p, "utf8")) as PieceSummary[];
    return catalogSummaryCache;
  } catch (e) {
    console.error(`[catalog-retrieve] failed to load ${p}: ${(e as Error).message}`);
    catalogSummaryCache = null;
    return null;
  }
}
// GET /catalog/retrieve?q=<query>&budget=<maxTokens>&mode=index|detail ->
//   { context, included, estimatedTokens, total, omitted }  (subconjunto del catalogo
//   que cabe en el budget de tokens). Resuelve "el catalogo no cabe en el contexto".
export function handleCatalogRetrieve(
  query: string,
  budget: number | undefined,
  mode: string | undefined,
): HandlerResult {
  const summary = loadCatalogSummary();
  if (!summary) {
    return {
      status: 503,
      body: { error: "catalog-summary.json not built. Run: node packages/okf-retriever/build-catalog-summary.mjs" },
    };
  }
  const maxTokens = budget && budget > 0 ? budget : 4000;
  const m = mode === "detail" ? "detail" : "index";
  const result = retrieve(summary, query ?? "", { maxTokens, mode: m });
  return { status: 200, body: result };
}

// --- retriever jerárquico de 2 niveles ---------------------------------------
// NIVEL 1: pieces relevantes + NOMBRES de sus actions (hints, sin props),
// acotado a su propio budget. Reusa retrievePieces del two-level.
// GET /catalog/pieces?q=&budget= -> { context, included, total, omitted, estimatedTokens }.
export function handleCatalogPieces(query: string, budget: number | undefined): HandlerResult {
  const summary = loadCatalogSummary();
  if (!summary) {
    return {
      status: 503,
      body: { error: "catalog-summary.json not built. Run: node packages/okf-retriever/build-catalog-summary.mjs" },
    };
  }
  const maxTokens = budget && budget > 0 ? budget : 3000;
  const result = retrievePieces(summary, query ?? "", { maxTokens });
  return { status: 200, body: result };
}

// full-catalog: docs action.md por piece. Ruta via env FULL_CATALOG_DIR; default
// al full-catalog de engine-adapter (resuelto relativo a este archivo).
const DEFAULT_FULL_CATALOG = path.resolve(HANDLERS_DIR, "../../engine-adapter/full-catalog");
function fullCatalogDir(): string {
  return process.env.FULL_CATALOG_DIR ?? DEFAULT_FULL_CATALOG;
}

// Cache por piece name -> ActionDetail[] (parsear los action.md de UNA piece es
// barato, pero no tiene sentido repetirlo por request). null = piece ausente.
const pieceActionsCache = new Map<string, ActionDetail[] | null>();
function loadPieceActions(pieceName: string): ActionDetail[] | null {
  if (pieceActionsCache.has(pieceName)) return pieceActionsCache.get(pieceName) ?? null;
  const dir = path.join(fullCatalogDir(), pieceName, "actions");
  let actions: ActionDetail[] | null = null;
  try {
    if (!existsSync(dir)) {
      pieceActionsCache.set(pieceName, null);
      return null;
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    actions = files.map((f) => parseActionMd(readFileSync(path.join(dir, f), "utf8"), f));
  } catch (e) {
    console.error(`[catalog-pieces] failed to load actions for ${pieceName}: ${(e as Error).message}`);
    actions = null;
  }
  pieceActionsCache.set(pieceName, actions);
  return actions;
}

// NIVEL 2: las actions DE UNA piece (con props), filtradas por query y acotadas
// a su propio budget. Parsea solo los action.md de ESA piece del full-catalog.
// GET /catalog/pieces/:name/actions?q=&budget= -> { context, included, total, omitted, estimatedTokens }.
// 404 claro si la piece no existe en el full-catalog.
export function handlePieceActions(
  name: string,
  query: string | undefined,
  budget: number | undefined,
): HandlerResult {
  const actions = loadPieceActions(name);
  if (!actions) {
    return { status: 404, body: { error: `piece not found in full-catalog: ${name}` } };
  }
  const maxTokens = budget && budget > 0 ? budget : 2000;
  const result = retrieveActions(actions, query, { maxTokens });
  return { status: 200, body: result };
}

// Ejecuta un action YA CONSTRUIDO contra el engine, registra el run en el
// run-history (best-effort) y devuelve el body {status, output, error?}. Lanza
// si executeFlow falla de forma fatal (el caller decide el status HTTP). Es el
// CAMINO COMÚN de ejecución: lo usan /execute y /workflows/:id/execute (reuso
// de flows: el agente guarda una vez, ejecuta muchas).
async function runFlow(
  action: unknown,
  source: string,
): Promise<{ status: string; output: unknown; error?: string }> {
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
    await recordRunBestEffort({ source, startedAt, finishedAt, verdict, steps: stepsMap });
    const stepNames = Object.keys(stepsMap);
    const last = stepNames[stepNames.length - 1];
    const step = last ? stepsMap[last] : undefined;
    return {
      status: step?.status ?? String(result.verdict),
      output: step?.output ?? null,
      ...(step?.errorMessage ? { error: step.errorMessage } : {}),
    };
  } catch (e) {
    const finishedAt = new Date().toISOString();
    // Registra el run FAILED aunque executeFlow haya lanzado (ej. piece inexistente).
    await recordRunBestEffort({
      source,
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
    throw e;
  }
}

// --- validación combinada (estructura + contexto) ---------------------------
// Catálogo de validación TARGETED: solo las pieces referenciadas por el workflow,
// con los NOMBRES (keys) reales de sus actions. Combina dos fuentes para no regresar
// pieces custom del demo:
//   - demoPieces: pieces custom bundled (echo, json-demo) -> actions vía action.name.
//   - full-catalog (loadPieceActions): 710 pieces community -> actions vía
//     `**action name:**` del action.md (key real, no displayName).
// Una piece referenciada que no está en ninguna fuente NO se añade al catálogo ->
// validatePiecesExist emite piece-not-found. Nota: catalog-summary.json NO sirve
// para validar actions porque sus actions[].name son displayNames ("Convert Text
// to Json"), no las keys que el workflow usa ("convert_text_to_json").
const demoPiecesByName = new Map(demoPieces.map((p) => [p.name, p]));

function pieceStepPieceNames(req: ExecuteRequest): string[] {
  const names = new Set<string>();
  for (const s of flattenSteps(req.steps)) {
    const t = s.type ?? "piece";
    if (t !== "piece") continue;
    if (s.pieceName) names.add(s.pieceName);
  }
  return [...names];
}

function buildValidationCatalog(req: ExecuteRequest): CatalogPiece[] {
  // UNION de fuentes de actions: demoPieces (custom bundled) OR full-catalog
  // (action.md). Antes, si una piece estaba en demoPieces se usaba SOLO su set
  // (recortado) y se ignoraba el full-catalog -> el agente descubría actions vía
  // retrieve_actions (que lee full-catalog) que /execute luego rechazaba falsamente.
  // Ahora: una action existe si la lista demoPieces.actions O los action.md del
  // full-catalog de esa piece. Cualquiera que retrieve_actions liste, se acepta.
  const catalog: CatalogPiece[] = [];
  for (const pn of pieceStepPieceNames(req)) {
    const demo = demoPiecesByName.get(pn);
    const fcActions = loadPieceActions(pn); // ActionDetail[] | null (cached)
    const names = new Set<string>();
    if (demo) Object.values(demo.actions).forEach((a) => names.add(a.name));
    if (fcActions) fcActions.forEach((a) => names.add(a.name));
    if (names.size > 0) {
      catalog.push({ name: pn, actions: [...names].map((n) => ({ name: n })) });
    }
    // ni demo ni full-catalog -> se omite -> piece-not-found (detección real)
  }
  return catalog;
}

function availableConnections(projectId: string): string[] {
  const vault = getVault();
  if (!vault) return [];
  return vault.listReferences(projectId).map((r) => r.externalId);
}

// validateWorkflowCore: combinación PURA structure+context. La usa el pre-flight de
// /execute y (con validateActionInput añadido) el endpoint /workflows/validate.
function validateWorkflowCore(
  req: ExecuteRequest,
  projectId: string,
): { ok: boolean; findings: WfFinding[] } {
  return validateWorkflow(req, buildValidationCatalog(req), availableConnections(projectId));
}

// POST /workflows/validate { steps, projectId? } -> { ok, findings }.
// Corre la validación combinada: estructura (forma/unicidad/refs de steps) +
// contexto (pieces+actions contra el catálogo, connections contra el vault) +
// validateActionInput por step (reusado, opcional). ok = sin findings de error.
export interface ValidateWorkflowRequest {
  steps: Array<Record<string, unknown>>;
  projectId?: string;
}

export async function handleValidateWorkflow(req: ValidateWorkflowRequest): Promise<HandlerResult> {
  if (!req || !Array.isArray(req.steps)) {
    return { status: 400, body: { error: "steps (array) required" } };
  }
  const wfReq: ExecuteRequest = sanitizeSteps({ steps: req.steps as ExecuteRequest["steps"] });
  const projectId = typeof req.projectId === "string" && req.projectId ? req.projectId : PROJECT_ID;
  const core = validateWorkflowCore(wfReq, projectId);
  const findings: WfFinding[] = [...core.findings];
  // Reuso opcional: validateActionInput por piece step indexado (mismo índice que
  // /execute). Añade findings 'input-invalid' sin alterar los del core.
  for (const s of flattenSteps(wfReq.steps)) {
    const ps = s as PieceStepReq;
    if (!ps.pieceName || !ps.actionName) continue;
    const props = actionPropsIndex.get(`${ps.pieceName}|${ps.actionName}`);
    if (!props) continue;
    const res = validateActionInput(ps.input ?? {}, props);
    if (!res.ok) {
      for (const e of res.errors) {
        findings.push({
          level: "error",
          code: "input-invalid",
          message: e,
          path: ps.name ?? `${ps.pieceName}/${ps.actionName}`,
        });
      }
    }
  }
  const ok = !findings.some((f) => f.level === "error");
  return { status: 200, body: { ok, findings } };
}

// POST /execute -> validate each step's input, build flow, run it, return REAL result.
export async function handleExecute(req: ExecuteRequest): Promise<HandlerResult> {
  // AUTO-SANITIZADO PRE-VALIDACIÓN: el agente a veces manda nombres de step
  // inválidos (ej. "Convert Text to JSON" con espacios). En lugar de rechazar
  // con 'invalid-step-name' y forzar un reintento del agente, reescribimos los
  // nombres a la forma válida (/^[a-zA-Z0-9_]+$/) y las refs {{name.output}} en
  // sincronía, ANTES de validar/ejecutar. Módulo puro: no muta el input original.
  // El resto del pre-flight (refs a steps inexistentes, piece/connection) sigue
  // igual sobre el request ya sanitizado.
  const sreq = sanitizeSteps(req);
  // PRE-FLIGHT (tier estructura + contexto): caza workflows inválidos ANTES de
  // tocar el engine. piece inexistente (antes PieceNotFoundError del engine en
  // runtime), ref a step inexistente, connection inexistente -> 400 workflow_invalid
  // con los findings, SIN ejecutar. NO incluye validateActionInput (esa gatea el
  // input per-step y sigue devolviendo 400 validation_failed para no romper la
  // semántica previa); por eso el pre-flight es estructura+contexto únicamente.
  const preflight = validateWorkflowCore(sreq, PROJECT_ID);
  if (!preflight.ok) {
    return { status: 400, body: { error: "workflow_invalid", findings: preflight.findings } };
  }

  // A2E: valida el input de cada piece step contra las props de su action ANTES
  // de construir/ejecutar. Si algún step es inválido, 400 con errores claros por
  // step y NO se ejecuta el flow. Router/loop steps (sin pieceName+actionName) y
  // actions no indexadas se saltan (ver nota en actionPropsIndex).
  const stepResults: Array<{ name: string; errors: string[] }> = [];
  if (Array.isArray(sreq.steps)) {
    for (const s of sreq.steps) {
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
    action = buildFlowFromRequest(sreq, new Date().toISOString());
  } catch (e) {
    return { status: 400, body: { error: `invalid request: ${(e as Error).message}` } };
  }

  try {
    const body = await runFlow(action, "manual");
    return { status: 200, body };
  } catch (e) {
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

// --- workflow-registry (OKF + git por workflow) ----------------------------
//
// El agente GUARDA workflows (POST /workflows), los DESCUBRE (GET /workflows),
// los LEE (GET /workflows/:id) y los RE-EJECUTA (POST /workflows/:id/execute).
// Cada workflow se persiste como doc OKF + commit de git en WORKFLOWS_REPO.

// HTTP body for POST /workflows. `id` es opcional: si se omite, se genera un
// uuid; si se pasa, se reusa (y saveWorkflow versiona: v1->v2... en re-save).
// `steps` sigue la misma forma que /execute (PieceStepReq | router | loop).
export interface CreateWorkflowRequest {
  id?: string;
  name: string;
  description?: string;
  steps: Array<Record<string, unknown>>;
}

// POST /workflows -> genera id (uuid si no viene), createdAt/updatedAt, guarda
// via saveWorkflow (OKF + commit). Devuelve { id, version }.
export async function handleCreateWorkflow(req: CreateWorkflowRequest): Promise<HandlerResult> {
  if (!req || typeof req.name !== "string" || !req.name) {
    return { status: 400, body: { error: "name is required" } };
  }
  if (!Array.isArray(req.steps) || req.steps.length === 0) {
    return { status: 400, body: { error: "steps must be a non-empty array" } };
  }
  const now = new Date().toISOString();
  const wf: WorkflowRecord = {
    id: typeof req.id === "string" && req.id ? req.id : randomUUID(),
    name: req.name,
    createdAt: now,
    updatedAt: now,
    steps: req.steps as WorkflowStep[],
    ...(req.description !== undefined ? { description: req.description } : {}),
  };
  let saved: { path: string; version: string };
  try {
    saved = await saveWorkflow(wf, { repoDir: WORKFLOWS_REPO });
  } catch (e) {
    return { status: 500, body: { error: `save failed: ${(e as Error).message}` } };
  }
  return { status: 201, body: { id: wf.id, version: saved.version, path: saved.path } };
}

// GET /workflows -> lista los workflows (id/name/piecesUsed/stepCount/updatedAt
// /version). Con ?format=okf devuelve el index.md crudo del registro.
export async function handleListWorkflows(format?: string): Promise<HandlerResult> {
  if (format === "okf") {
    const md = await getIndexMarkdown({ repoDir: WORKFLOWS_REPO });
    if (md == null) return { status: 404, body: { error: "registry index not generated yet" } };
    return { status: 200, body: md };
  }
  const workflows = await listWorkflows({ repoDir: WORKFLOWS_REPO });
  return { status: 200, body: { workflows } };
}

// GET /workflows/:id -> el doc OKF (markdown) + el record (con steps[]).
export async function handleGetWorkflow(id: string): Promise<HandlerResult> {
  const got = await getWorkflow({ repoDir: WORKFLOWS_REPO, id });
  if (got == null) return { status: 404, body: { error: `workflow not found: ${id}` } };
  return { status: 200, body: { markdown: got.markdown, record: got.record } };
}

// POST /workflows/:id/execute -> carga el workflow guardado, toma sus steps[] y
// los EJECUTA por el mismo camino que /execute (buildFlowFromRequest -> runFlow).
// Reuso de flows: el agente guarda una vez, ejecuta muchas.
export async function handleExecuteWorkflow(id: string): Promise<HandlerResult> {
  const got = await getWorkflow({ repoDir: WORKFLOWS_REPO, id });
  if (got == null) return { status: 404, body: { error: `workflow not found: ${id}` } };
  let action: unknown;
  try {
    action = buildFlowFromRequest({ steps: got.record.steps } as ExecuteRequest, new Date().toISOString());
  } catch (e) {
    return { status: 400, body: { error: `invalid stored workflow: ${(e as Error).message}` } };
  }
  try {
    const body = await runFlow(action, `workflow:${id}`);
    return { status: 200, body };
  } catch (e) {
    return { status: 500, body: { error: `execution failed: ${(e as Error).message}` } };
  }
}

// --- knowledge-base (OKF + git por entry) -----------------------------------
//
// El agente APRENDE y CONSULTA: guarda aprendizajes operacionales (POST
// /knowledge), descubre qué se sabe y si sigue vigente (GET /knowledge, con
// freshness por entry), lee un doc OKF concreto (GET /knowledge/:id) y el
// agente/humano atesta la vigencia de un entry (POST /knowledge/:id/attest).

// HTTP body for POST /knowledge. ttlDays default 30. sourceRunId opcional
// (vínculo al run que originó el aprendizaje, ej. un stub de fallo).
export interface CreateKnowledgeRequest {
  title: string;
  tags?: string[];
  ttlDays?: number;
  problem: string;
  resolution: string;
  sourceRunId?: string;
}

// POST /knowledge -> genera id (uuid), createdAt/updatedAt now, ttlDays default
// 30, guarda via addEntry (OKF + commit). Devuelve { id }.
export async function handleCreateKnowledge(req: CreateKnowledgeRequest): Promise<HandlerResult> {
  if (!req || typeof req.title !== "string" || !req.title) {
    return { status: 400, body: { error: "title is required" } };
  }
  if (typeof req.problem !== "string" || typeof req.resolution !== "string") {
    return { status: 400, body: { error: "problem and resolution are required strings" } };
  }
  const now = new Date().toISOString();
  const entry: KnowledgeEntry = {
    id: randomUUID(),
    title: req.title,
    tags: Array.isArray(req.tags) ? req.tags : [],
    createdAt: now,
    updatedAt: now,
    ttlDays: typeof req.ttlDays === "number" && Number.isFinite(req.ttlDays) ? req.ttlDays : 30,
    problem: req.problem,
    resolution: req.resolution,
    ...(req.sourceRunId !== undefined ? { sourceRunId: req.sourceRunId } : {}),
  };
  try {
    await addEntry(entry, { repoDir: KNOWLEDGE_REPO });
  } catch (e) {
    return { status: 500, body: { error: `knowledge save failed: ${(e as Error).message}` } };
  }
  return { status: 201, body: { id: entry.id } };
}

// GET /knowledge -> lista de entries con su freshness verdict por entry (para
// que el agente consulte "¿qué se sabe / sigue vigente?"). Con ?format=okf
// devuelve el index.md crudo del repo de conocimiento.
export async function handleListKnowledge(format?: string): Promise<HandlerResult> {
  if (format === "okf") {
    const md = await getKnowledgeIndexMarkdown({ repoDir: KNOWLEDGE_REPO });
    if (md == null) return { status: 404, body: { error: "knowledge index not generated yet" } };
    return { status: 200, body: md };
  }
  const entries = await listEntries({ repoDir: KNOWLEDGE_REPO });
  return { status: 200, body: { entries } };
}

// GET /knowledge/:id -> el doc OKF (markdown) + el record (con freshness).
export async function handleGetKnowledge(id: string): Promise<HandlerResult> {
  const got = await getEntry({ repoDir: KNOWLEDGE_REPO, id });
  if (got == null) return { status: 404, body: { error: `knowledge not found: ${id}` } };
  return { status: 200, body: { markdown: got.markdown, record: got.record } };
}

// HTTP body for POST /knowledge/:id/attest. Vigencia humana: `by` firma y
// `expiresAt` fija hasta cuándo es válida la attestation.
export interface AttestKnowledgeRequest {
  by: string;
  expiresAt: string;
}

// POST /knowledge/:id/attest -> attestEntry (vigencia humana). Devuelve { ok }.
export async function handleAttestKnowledge(id: string, req: AttestKnowledgeRequest): Promise<HandlerResult> {
  if (!req || typeof req.by !== "string" || !req.by) {
    return { status: 400, body: { error: "by is required" } };
  }
  if (typeof req.expiresAt !== "string" || !req.expiresAt) {
    return { status: 400, body: { error: "expiresAt is required" } };
  }
  try {
    const r = await attestEntry({ repoDir: KNOWLEDGE_REPO, id, by: req.by, expiresAt: req.expiresAt });
    if (!r.ok) return { status: 404, body: { error: `knowledge not found: ${id}` } };
    return { status: 200, body: { ok: true } };
  } catch (e) {
    return { status: 500, body: { error: `attest failed: ${(e as Error).message}` } };
  }
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

  const signingSecret = generateSecret();
  const registration: WebhookRegistration = {
    triggerSpec: {
      pieceName: triggerSpec.pieceName,
      pieceVersion: triggerSpec.pieceVersion ?? "0.1.0",
      triggerName: triggerSpec.triggerName,
      input: triggerSpec.input ?? {},
    },
    flowSteps,
    signingSecret,
  };
  const triggerId = randomUUID();
  registerWebhookTrigger(triggerId, registration);
  // The signingSecret is returned ONCE here; the registrant stores it to sign
  // future ingress payloads. It is NOT echoed by GET /webhook-triggers/:id.
  return {
    status: 201,
    body: { triggerId, webhookUrl: `/webhooks/${triggerId}`, signingSecret },
  };
}

// GET /webhook-triggers/:id -> the stored registration (no live state; the
// trigger is passive until a POST hits its webhookUrl).
export function handleGetWebhookTrigger(id: string): HandlerResult {
  const entry = getWebhookTrigger(id);
  if (!entry) return { status: 404, body: { error: `webhook trigger not found: ${id}` } };
  // Never echo the signingSecret on GET (it was returned once at registration).
  const { signingSecret: _omit, ...registrationSansSecret } = entry.registration;
  void _omit;
  return {
    status: 200,
    body: { triggerId: id, registration: registrationSansSecret, webhookUrl: `/webhooks/${id}` },
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
  event: { body: unknown; headers: Record<string, string>; queryParams: Record<string, string>; method: string; rawBody: string },
): Promise<WebhookIngressResult> {
  const entry = getWebhookTrigger(triggerId);
  if (!entry) {
    return { status: 404, body: { error: `webhook trigger not found: ${triggerId}` } };
  }
  const { registration } = entry;

  // --- HMAC signature gate -------------------------------------------------
  // New webhooks (registered with a signingSecret) REQUIRE a valid
  // X-A2E-Signature header over the RAW body, UNLESS WEBHOOK_HMAC_OPTIONAL=1.
  // Legacy registrations (no secret, e.g. registered by an older route) and
  // optional mode fall back to the original triggerId-only behavior.
  // node:http lowercases inbound header names, so look up the lowercased key.
  const sigHeader = event.headers["x-a2e-signature"];
  const hasSecret =
    typeof registration.signingSecret === "string" && registration.signingSecret.length > 0;
  const enforce = hasSecret && process.env.WEBHOOK_HMAC_OPTIONAL !== "1";
  if (enforce) {
    if (!verifySignature(registration.signingSecret as string, event.rawBody, sigHeader)) {
      return { status: 401, body: { error: "invalid_signature" } };
    }
  }

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

// --- connections (REFERENCES only, never secrets) -------------------------------
// GET /connections?projectId=&piece=&format=json|context&budget=
//   json    -> { connections: [{externalId,displayName,pieceName,type}], total }
//   context -> { context, included, total, omitted }  (slot connections del CCDD)
// Las referencias vienen del vault via listReferences (solo nombres). El secreto
// NUNCA se sirve: listReferences no lo expone y renderConnectionRefs solo emite
// {{connections.<externalId>}}.
export interface ListConnectionsParams {
  projectId?: string;
  piece?: string;
  format?: string;
  budget?: number;
}

export function handleListConnections(params: ListConnectionsParams): HandlerResult {
  const vault = getVault();
  if (!vault) {
    return { status: 503, body: { error: "vault not initialized" } };
  }
  const projectId = params.projectId || PROJECT_ID;
  const refs = vault.listReferences(projectId).map((r) => ({
    externalId: r.externalId,
    displayName: r.displayName,
    pieceName: r.pieceName,
    type: r.type,
  }));
  const format = params.format ?? "json";

  if (format === "context") {
    const rendered = renderConnectionRefs(refs, {
      maxTokens: params.budget ?? 1000,
      pieceName: params.piece,
    });
    return {
      status: 200,
      body: {
        context: rendered.context,
        included: rendered.included,
        total: rendered.total,
        omitted: rendered.omitted,
      },
    };
  }

  // format === json (default)
  const filtered = params.piece ? filterByPiece(refs, params.piece) : refs;
  return {
    status: 200,
    body: {
      connections: filtered,
      total: filtered.length,
    },
  };
}

// --- agent context (L3 CCDD: runtime assembly contrato -> contexto acotado) -----
// POST /agent/context { query, projectId? } -> ensambla el contexto del agente
// respetando slots firmados + budget + guardrails (ver assemble-agent-context.ts).
export interface AssembleAgentContextRequest {
  query: string;
  projectId?: string;
}

export function handleAssembleAgentContext(req: AssembleAgentContextRequest): HandlerResult {
  try {
    const result = assembleAgentContext({ query: req.query, projectId: req.projectId });
    return { status: 200, body: result };
  } catch (e) {
    return { status: 500, body: { error: (e as Error).message } };
  }
}

// --- piece source discovery (fase SEGURA: solo clona/lee + parsea, 0 exec) ------
// POST /sources/discover { source, ref? } -> { sourceId, pieces, total, warnings }
// Lista pieces de un repo git (clone --depth 1) o ruta local SIN ejecutar codigo
// de las pieces. dir es relativo al root del source (no expone rutas absolutas).
export interface DiscoverSourcesRequest {
  source: string;
  ref?: string;
  workdir?: string;
}

export async function handleDiscoverSources(req: DiscoverSourcesRequest): Promise<HandlerResult> {
  if (typeof req.source !== "string" || req.source.length === 0) {
    return { status: 400, body: { error: "source (string) required" } };
  }
  const opts: DiscoverOptions = { source: req.source };
  if (typeof req.ref === "string" && req.ref.length > 0) opts.ref = req.ref;
  if (typeof req.workdir === "string" && req.workdir.length > 0) opts.workdir = req.workdir;
  try {
    const result = await discoverSource(opts);
    return {
      status: 200,
      body: {
        sourceId: result.sourceId,
        pieces: result.pieces.map((p) => ({
          name: p.name,
          displayName: p.displayName,
          description: p.description,
          ...(p.auth ? { auth: p.auth } : {}),
          dir: p.dir,
        })),
        total: result.total,
        warnings: result.warnings,
      },
    };
  } catch (e) {
    return { status: 500, body: { error: (e as Error).message } };
  }
}

// --- agent run (L3 CCDD: orquestador A2E que envuelve un LLM via Ollama) -----
// POST /agent/run { task, projectId? } -> ejecuta runAgent con el ollama-provider
// real (model gemma4:31b-cloud por defecto) -> { ok, result, request, attempts, transcript }.
// El orquestador llama de vuelta a esta misma API (/agent/context, /execute, /knowledge).
export interface AgentRunRequest {
  task: string;
  projectId?: string;
}

export async function handleAgentRun(req: AgentRunRequest): Promise<HandlerResult> {
  if (typeof req.task !== "string" || req.task.length === 0) {
    return { status: 400, body: { error: "task (string) required" } };
  }
  const port = Number(process.env.PORT ?? "8080");
  const apiBase = `http://localhost:${port}`;
  try {
    const result = await runAgent(req.task, {
      apiBase,
      ...(req.projectId ? { projectId: req.projectId } : {}),
      llm: (prompt, system) => callOllama(prompt, { system }),
    });
    return { status: 200, body: result };
  } catch (e) {
    return { status: 500, body: { error: `agent run failed: ${(e as Error).message}` } };
  }
}


// POST /sources/build { sourceDir, pieces:[names], outRoot?, catalogOut? } ->
//   { built, rejected, catalogPath }. Valida cada piece (validatePieceDir),
//   bundlea solo las validas (build-piece.mjs) a un outRoot aislado y genera
//   un catalogo OKF aislado. sourceDir puede ser ~/ap o un dir clonado por
//   discover. CAVEAT: la extraccion de metadata + el bundle EJECUTAN codigo del
//   piece in-process; para repos T2 NO confiables esto deberia ir sandboxeado.
export interface BuildSourcesRequest {
  sourceDir: string;
  pieces: string[];
  outRoot?: string;
  catalogOut?: string;
}

export async function handleBuildSources(req: BuildSourcesRequest): Promise<HandlerResult> {
  if (typeof req.sourceDir !== "string" || req.sourceDir.length === 0) {
    return { status: 400, body: { error: "sourceDir (string) required" } };
  }
  if (!Array.isArray(req.pieces) || req.pieces.length === 0) {
    return { status: 400, body: { error: "pieces (string[]) required" } };
  }
  const outRoot =
    typeof req.outRoot === "string" && req.outRoot.length > 0
      ? req.outRoot
      : path.join(os.tmpdir(), `t2-build-${randomUUID()}`);
  const catalogOut =
    typeof req.catalogOut === "string" && req.catalogOut.length > 0
      ? req.catalogOut
      : path.join(os.tmpdir(), `t2-cat-${randomUUID()}`);
  try {
    const result = await buildSelectedPieces({
      sourceDir: req.sourceDir,
      pieceNames: req.pieces,
      outRoot,
      catalogOut,
    });
    return {
      status: 200,
      body: {
        built: result.built,
        rejected: result.rejected,
        catalogPath: result.catalogPath,
      },
    };
  } catch (e) {
    return { status: 500, body: { error: (e as Error).message } };
  }
}
