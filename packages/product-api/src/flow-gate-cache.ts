// flow-gate-cache — Snapshot memoizado del "gate de flujos" (validez + salud).
//
// buildFlowsByActionIndex (NIVEL 3) y handleRetrieveFlows (retrieve_flows)
// computaban, EN CADA REQUEST, el mismo gate: listWorkflowRecords (todos los
// flujos) + listAllRuns (TODOS los runs de TODAS las fechas, leyendo disco) +
// re-validar TODOS los flujos contra el catálogo. Sin cache, escala
// O(todos los runs+flujos) por request. Este módulo lo computa UNA vez por
// ventana de cache y lo sirve a ambos paths.
//
// Invalidación: (a) TTL de seguridad (default 5000ms, override por env
// FLOW_GATE_TTL_MS) para cambios externos/catálogo; (b) invalidateFlowGateSnapshot()
// la llama el wiring tras cada write (record-run, save-workflow) para que un
// save+run+retrieve en la misma corrida vea datos frescos — el TTL es sólo red
// de seguridad, la invalidación en write es la fuente de verdad.
//
// Best-effort: si listWorkflowRecords/listAllRuns lanzan, devuelve snapshot
// vacío y NO cachea el error (próxima request reintenta).

import os from "node:os";
import path from "node:path";
import { listAllRuns } from "../../run-logger/src/run-store.js";
import { listWorkflowRecords } from "../../workflow-registry/src/workflow-store.js";
import {
  computeFlowHealth,
  type FlowWithGate,
} from "../../workflow-registry/src/retrieve-flows.js";
import type { FlowRun } from "../../run-logger/src/run-logger.js";
import type { WorkflowRecord } from "../../workflow-registry/src/workflow-registry.js";
import type { WfFinding } from "../../flow-builder/src/validate-workflow-context.js";

// Mismos repos que handlers.ts. Se leen al cargar el módulo (los smokes setean
// WORKFLOWS_REPO/RUNS_REPO ANTES del import dinámico de index.ts, igual que
// handlers.ts).
const WORKFLOWS_REPO = process.env.WORKFLOWS_REPO ?? path.join(os.homedir(), "product/.workflow-registry");
const RUNS_REPO = process.env.RUNS_REPO ?? path.join(os.homedir(), "product/.run-history");

// TTL de seguridad: ventana durante la cual se sirve el snapshot cacheado sin
// releer disco. Override por env FLOW_GATE_TTL_MS. Default 5000ms: corto para
// que cambios externos (catálogo, runs escritos por fuera) no se sirvan stale
// mucho tiempo; la invalidación en write lo refresca antes.
const TTL_MS = Number(process.env.FLOW_GATE_TTL_MS ?? 5000);

// Validador inyectado por el wiring: re-valida un flow contra el catálogo ACTUAL
// (validateWorkflowCore en handlers.ts). Devuelve { ok, findings }. Es PURA; el
// snapshot la invoca una sola vez por (re)build, no por request.
export type FlowGateValidator = (flow: WorkflowRecord) => { ok: boolean; findings: WfFinding[] };

// Snapshot del gate: flujos guardados, runs agrupados por workflowId, y cada
// flow con su gate (validez + salud + findings) ya computado. Es la entrada
// compartida de buildFlowsByAction (NIVEL 3) y de retrieveFlows.
export type FlowGateSnapshot = {
  flows: WorkflowRecord[];
  runsByWorkflow: Record<string, FlowRun[]>;
  flowsWithGate: FlowWithGate[];
};

type Cached = { snapshot: FlowGateSnapshot; expiresAt: number };
let cached: Cached | null = null;

// Vacía la cache. La llama el wiring tras cada write que muta los repos
// (record-run, save-workflow) para que la próxima lectura reconstruya el
// snapshot con datos frescos. Idempotente: no-op si no había cache.
export function invalidateFlowGateSnapshot(): void {
  cached = null;
}

// Computa el snapshot del gate (UN pase: listWorkflowRecords + listAllRuns +
// agrupar runs + validar+health por flow) y lo memoiza por TTL_MS. En cache hit
// devuelve el snapshot sin tocar disco. En error de lectura (repo ausente o
// corrupto) devuelve snapshot vacío SIN cachear (próxima request reintenta).
export async function getFlowGateSnapshot(
  validate: FlowGateValidator,
): Promise<FlowGateSnapshot> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.snapshot;
  }
  try {
    const flows = await listWorkflowRecords({ repoDir: WORKFLOWS_REPO });
    const runs = await listAllRuns({ repoDir: RUNS_REPO });
    // Agrupa runs por workflowId (retrieve-flows espera un map; un flow sin
    // entrada = no probado -> health "0 runs (untested)").
    const runsByWorkflow: Record<string, FlowRun[]> = {};
    for (const r of runs) {
      if (!r.workflowId) continue;
      (runsByWorkflow[r.workflowId] ??= []).push(r);
    }
    // Gate por flow: validez (catálogo actual) + salud (runs por workflowId) +
    // findings (motivo de invalidez, para que retrieveFlows renderice sin
    // re-validar).
    const flowsWithGate: FlowWithGate[] = flows.map((flow) => {
      const v = validate(flow);
      const valid = !!(v && v.ok);
      const findings: WfFinding[] = (v && v.findings) ?? [];
      const health = computeFlowHealth(runsByWorkflow[flow.id] ?? [], flow.id);
      return { flow, valid, health, findings };
    });
    const snapshot: FlowGateSnapshot = { flows, runsByWorkflow, flowsWithGate };
    cached = { snapshot, expiresAt: now + TTL_MS };
    return snapshot;
  } catch {
    // Best-effort: repo vacío/ausente/corrupto -> snapshot vacío. NO cachea el
    // error: la próxima request reintenta (un repo que se inicializa después
    // debe verse sin esperar el TTL).
    return { flows: [], runsByWorkflow: {}, flowsWithGate: [] };
  }
}