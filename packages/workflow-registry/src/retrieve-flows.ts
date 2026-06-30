// retrieve-flows — Retriever estructural de WORKFLOWS guardados (reuso).
//
// Descubre flujos guardados relevantes para una query y los renderiza como
// contexto OKF acotado a un budget, con DOS gates de confianza:
//   - VALIDEZ: re-valida el flow contra el catálogo actual (la validación la
//     inyecta el wiring como función pura; este módulo no toca el catálogo).
//   - SALUD: agrega los runs enlazados al flow por workflowId (éxito/total/
//     último estado) vía computeFlowHealth.
//
// Rankea por relevancia (scoreFlow: keywords en name/description/pieceNames) y
// DEGRADA a los flujos inválidos (stale: pieces que cambiaron), sin runs (no
// probados) y con baja successRate. Marca claramente válidos vs inválidos y
// no probados, para que el agente reuse un flujo validado+sano ANTES de
// re-componer desde cero.
//
// Sin red, sin FS, sin Date. Todo funciones puras. Reusa estimateTokens de
// okf-retriever y tokenize de two-level; el resto es local y autónomo. Patrón
// del retriever de pieces (retrieve/trimByBudget) aplicado a flows.

import { estimateTokens } from "../../okf-retriever/src/okf-retriever.js";
import { tokenize } from "../../okf-retriever/src/two-level.js";
import {
  extractPiecesUsed,
  type WorkflowRecord,
  type WorkflowStep,
} from "./workflow-registry.js";
import type { FlowRun } from "../../run-logger/src/run-logger.js";
import type { WfValidation, WfFinding } from "../../flow-builder/src/validate-workflow-context.js";

// Pesos de coincidencia para scoreFlow: name pesa más que pieces, que pesan más
// que description (mismo criterio que scorePiece del retriever de pieces).
const WEIGHT_NAME = 3;
const WEIGHT_PIECES = 2;
const WEIGHT_DESC = 1;

/**
 * Salud agregada de un flujo a partir de sus runs enlazados por workflowId.
 * successRate = succeeded/total, o null si 0 runs (no probado).
 */
export type FlowHealth = {
  total: number;
  succeeded: number;
  failed: number;
  lastStatus: string;
  lastSuccessAt: string;
  successRate: number | null;
};

/**
 * Computa la salud de un flujo (puro). Filtra `runs` por workflowId, cuenta
 * totales/éxitos/fallos, y determina el último estado y la última marca de
 * tiempo de un run SUCCEEDED (ordenando por startedAt ISO lexicográfico, que
 * es monótono para timestamps UTC en formato ISO 8601).
 *
 * - total 0 -> { total:0, succeeded:0, failed:0, lastStatus:'', lastSuccessAt:'',
 *                successRate: null }  (flujo no probado).
 * - failed = total - succeeded (todo run no-exitoso cuenta como fallo).
 * - successRate = succeeded/total (número en [0,1]).
 */
export function computeFlowHealth(runs: FlowRun[], workflowId: string): FlowHealth {
  const mine = runs.filter((r) => r.workflowId === workflowId);
  const total = mine.length;
  if (total === 0) {
    return { total: 0, succeeded: 0, failed: 0, lastStatus: "", lastSuccessAt: "", successRate: null };
  }
  const succeeded = mine.filter((r) => r.status === "SUCCEEDED").length;
  const failed = total - succeeded;
  // lastStatus: status del run con startedAt mayor (ISO lexicográfico = orden
  // cronológico para timestamps UTC). Empate estable: el último en el orden
  // original (slice sin reordena estable).
  const byStart = [...mine].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const last = byStart[byStart.length - 1];
  const lastStatus = last ? last.status : "";
  // lastSuccessAt: startedAt del SUCCEEDED más reciente ('' si ninguno).
  const successes = mine
    .filter((r) => r.status === "SUCCEEDED")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const lastSuccessAt = successes.length > 0 ? successes[successes.length - 1].startedAt : "";
  return { total, succeeded, failed, lastStatus, lastSuccessAt, successRate: succeeded / total };
}

// --- NIVEL 3: índice inverso action -> flows (recetas que la usan) ----------
//
// El descubrimiento de actions (nivel 2) ahora adjunta, por action, los flujos
// guardados VALIDOS y SANOS que la usan: así el agente, al buscar una action
// útil, descubre una receta probada que la ejercita. El gate (validez + salud)
// lo computa el wiring (igual que retrieveFlows) y se pasa ya computado; aquí
// sólo se indexa (puro, sin red/FS/Date).

/**
 * Referencia a un flujo guardado con su gate ya computado: id, name, validez y
 * salud agregada. Es el valor del índice inverso `${pieceName}:${actionName}`.
 */
export type FlowRef = {
  id: string;
  name: string;
  validity: "valid" | "invalid";
  health: FlowHealth;
};

/**
 * Flujo + gate (validez + salud) ya computados por el wiring. Entrada de
 * buildFlowsByAction: el wiring re-valida contra el catálogo actual (validez) y
 * agrega runs por workflowId (salud), igual que retrieveFlows.
 */
export type FlowWithGate = {
  flow: WorkflowRecord;
  valid: boolean;
  health: FlowHealth;
  // Findings de la re-validación contra el catálogo actual (gate de VALIDEZ).
  // El wiring los computa una vez al construir el snapshot; retrieveFlows los
  // reusa para renderizar el motivo de invalidez sin re-validar por request.
  findings: WfFinding[];
};

// Recorre el árbol de steps del flow y devuelve las claves
// `${pieceName}:${actionName}` únicas (dedupe por flujo: dos steps con la misma
// action indexan el flujo una sola vez bajo esa clave). Visita branches, loop
// y fallback como collectPieces/extractPiecesUsed (mismo criterio de árbol).
function flowActionKeys(flow: WorkflowRecord): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (step: WorkflowStep): void => {
    if (step.pieceName && step.actionName) {
      const k = `${step.pieceName}:${step.actionName}`;
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
    if (step.steps) for (const s of step.steps) visit(s);
    for (const b of step.branches ?? []) for (const s of b.steps ?? []) visit(s);
    if (step.fallback) for (const s of step.fallback.steps ?? []) visit(s);
  };
  for (const s of flow.steps) visit(s);
  return order;
}

// Comparador de refs por salud desc: mayor successRate primero; null (no
// probado) último; empate -> más runs; empate -> por name estable. Pre-ordena
// cada lista del índice para que el caller sólo haga .slice(0, K).
function byHealthDesc(a: FlowRef, b: FlowRef): number {
  const ar = a.health.successRate ?? -1;
  const br = b.health.successRate ?? -1;
  if (br !== ar) return br - ar;
  if (b.health.total !== a.health.total) return b.health.total - a.health.total;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Construye el índice inverso action -> flows (puro). Para cada flujo VALIDO
 * (los inválidos/stale se EXCLUYEN: no son receta confiable), y por cada step
 * (pieceName, actionName) de su árbol, indexa el flujo bajo
 * `${pieceName}:${actionName}`. SOLO válidos: un flujo válido basta (cubre el
 * caso "al menos válido" aunque no tenga runs; un inválido nunca se indexa).
 *
 * Cada lista queda pre-ordenada por salud desc (byHealthDesc), así el caller
 * (handlePieceActions) toma los top-K más sanos con un simple slice. Devuelve un
 * Map vacío si no hay flujos válidos -> el nivel 3 no añade coste (esparso).
 */
export function buildFlowsByAction(
  flowsWithGate: FlowWithGate[],
): Map<string, FlowRef[]> {
  const index = new Map<string, FlowRef[]>();
  for (const { flow, valid, health } of flowsWithGate) {
    if (!valid) continue; // excluye inválidos/stale: no son receta confiable
    const ref: FlowRef = { id: flow.id, name: flow.name, validity: "valid", health };
    for (const key of flowActionKeys(flow)) {
      const list = index.get(key);
      if (list) list.push(ref);
      else index.set(key, [ref]);
    }
  }
  for (const list of index.values()) list.sort(byHealthDesc);
  return index;
}

/**
 * Puntúa un flow por coincidencia (case-insensitive) de los terms en name,
 * description y los pieceName de sus steps (vía extractPiecesUsed). Más peso a
 * name que a pieces que a description. 0 si no matchea nada (o terms vacíos).
 */
export function scoreFlow(flow: WorkflowRecord, terms: string[]): number {
  if (terms.length === 0) return 0;
  const nameField = flow.name.toLowerCase();
  const desc = (flow.description ?? "").toLowerCase();
  const pieces = extractPiecesUsed(flow.steps).join(" ").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (nameField.includes(term)) score += WEIGHT_NAME;
    if (pieces.includes(term)) score += WEIGHT_PIECES;
    if (desc.includes(term)) score += WEIGHT_DESC;
  }
  return score;
}

// Resultado de la validación inyectada por el wiring (shape de WfValidation:
// { ok, findings }). El wiring valida el flow contra el catálogo ACTUAL.
type FlowValidateResult = { ok: boolean; findings: WfFinding[] };

// Item rankeado interno: flow + score + validez + salud + índice original.
type RankedFlow = {
  flow: WorkflowRecord;
  score: number;
  valid: boolean;
  findings: WfFinding[];
  health: FlowHealth;
  i: number;
};

// Comparador de ranking: relevancia (score) desc; empate -> degrada inválidos,
// luego sin runs, luego baja successRate; empate final -> índice estable.
function byRankDesc(a: RankedFlow, b: RankedFlow): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.valid !== b.valid) return a.valid ? -1 : 1; // válido antes que inválido
  const aRuns = a.health.total > 0;
  const bRuns = b.health.total > 0;
  if (aRuns !== bRuns) return aRuns ? -1 : 1; // con runs antes que sin runs
  const aRate = a.health.successRate ?? -1;
  const bRate = b.health.successRate ?? -1;
  if (aRate !== bRate) return bRate - aRate; // mayor successRate antes
  return a.i - b.i; // estable por índice original
}

// Primer finding de error como motivo de invalidez ("code: message"), o
// "invalid" si no hay findings de error (caso defensivo).
function invalidReason(findings: WfFinding[]): string {
  const err = findings.find((f) => f.level === "error");
  return err ? `${err.code}: ${err.message}` : "invalid";
}

// Render compacto de la salud: "0 runs (untested)" o "N runs, X% ok, last STATUS".
// Exportado para que el handler del nivel 3 (handlePieceActions) reutilice el
// MISMO string de salud al adjuntar flujos a una action (receta válida+sana).
export function renderFlowHealth(h: FlowHealth): string {
  if (h.total === 0) return "0 runs (untested)";
  const pct = Math.round((h.successRate ?? 0) * 100);
  return `${h.total} runs, ${pct}% ok, last ${h.lastStatus}`;
}

// Render del bloque OKF de un flow rankeado: name + id, description, pieces
// usados, VALIDEZ (valid | invalid — motivo) y SALUD. Compacto para el budget.
function renderFlowBlock(r: RankedFlow): string {
  const f = r.flow;
  const lines: string[] = [`## ${f.name}  (id: ${f.id})`];
  if (f.description && f.description.length > 0) lines.push(f.description);
  const pieces = extractPiecesUsed(f.steps);
  lines.push(`pieces: ${pieces.length > 0 ? pieces.join(", ") : "(none)"}`);
  lines.push(`validity: ${r.valid ? "valid" : `invalid — ${invalidReason(r.findings)}`}`);
  lines.push(`health: ${renderFlowHealth(r.health)}`);
  return lines.join("\n");
}

/**
 * Punto de entrada: descubre, valida, puntúa, rankea y renderiza los flows
 * relevantes que caben en el budget.
 *
 * - `validate`: función pura inyectada por el wiring que re-valida un flow
 *   contra el catálogo ACTUAL (devuelve { ok, findings }). Es el gate de
 *   VALIDEZ: un flow guardado puede haber quedado stale (pieces que cambiaron).
 * - `runsByWorkflow`: runs agrupados por workflowId (gate de SALUD). Un flow sin
 *   entrada en el mapa = no probado.
 * - Query vacía o sin terms: candidatos = todos los flows (fallback). Sino:
 *   candidatos = flows con score > 0 (que matchean la query).
 * - Rankea por relevancia, degradando inválidos / sin runs / baja successRate.
 * - Rendera OKF acotado por budget (estimateTokens), incluyendo SIEMPRE al
 *   primer candidato aunque exceda el budget (best-effort) y deteniéndose cuando
 *   el siguiente excedería el budget.
 *
 * Devuelve { context, included:[ids], total, omitted, estimatedTokens } como el
 * retriever de pieces: total = matching, omitted = matching - incluidos.
 */
export function retrieveFlows(args: {
  flows: WorkflowRecord[];
  runsByWorkflow: Record<string, FlowRun[]>;
  validate: (flow: WorkflowRecord) => FlowValidateResult | WfValidation;
  query: string;
  budget: number;
}): {
  context: string;
  included: string[];
  total: number;
  omitted: number;
  estimatedTokens: number;
} {
  const { flows, runsByWorkflow, validate, query, budget } = args;
  const maxTokens = budget > 0 ? budget : 4000;
  const terms = tokenize(query);

  // Score + valida + health por flow (un pase). La validación es el gate de
  // VALIDEZ contra el catálogo actual; la salud es el gate de SALUD por workflowId.
  const ranked: RankedFlow[] = flows.map((flow, i) => {
    const v = validate(flow);
    const valid = !!(v && v.ok);
    const findings = (v && v.findings) ?? [];
    const runs = runsByWorkflow[flow.id] ?? [];
    const health = computeFlowHealth(runs, flow.id);
    return { flow, score: scoreFlow(flow, terms), valid, findings, health, i };
  });

  // Candidatos: si hay terms, sólo los que matchean (score>0); sino todos.
  const candidates =
    terms.length === 0 ? ranked.slice() : ranked.filter((r) => r.score > 0);
  candidates.sort(byRankDesc);

  // Render acotado al budget. Header compacto + un bloque por flow incluido.
  const header = "# flows-retrieve";
  let context = header;
  const included: string[] = [];
  for (const c of candidates) {
    const block = renderFlowBlock(c);
    const candidateContext = included.length === 0 ? `${header}\n${block}` : `${context}\n${block}`;
    // Siempre incluye al primer candidato (aunque exceda el budget, best-effort);
    // a partir del segundo, detente si excede el budget.
    if (included.length > 0 && estimateTokens(candidateContext) > maxTokens) break;
    context = candidateContext;
    included.push(c.flow.id);
  }

  const total = candidates.length;
  const omitted = total - included.length;
  return {
    context,
    included,
    total,
    omitted,
    estimatedTokens: estimateTokens(context),
  };
}