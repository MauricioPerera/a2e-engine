// validate-workflow-context.ts — validación PRE-EJECUCIÓN tier CONTEXTO.
// Verifica que las pieces/actions referenciadas existan contra el catálogo y que
// las connections referenciadas en los inputs resuelvan contra el vault (externalIds
// disponibles). Módulo PURO: recibe catálogo y connections disponibles como DATOS
// (sin red, sin FS, sin Date). El wiring (product-api/handlers) los alimenta.
//
// Reusa flattenSteps + extractRefs + validateWorkflowStructure de validate-workflow
// (tier estructural). No duplica esa lógica: la combina con la de contexto.
//
// Códigos de finding que emite (todos level error):
//   - piece-not-found:     pieceName del step no está en el catálogo.
//   - action-not-found:    actionName del step no está entre las actions de su piece.
//   - connection-not-found: una connectionRef del input no está en `available`.

import {
  flattenSteps,
  extractRefs,
  validateWorkflowStructure,
  type ExecuteRequest,
  type WfStep,
  type WfFinding,
  type WfValidation,
} from "./validate-workflow.js";

// Catálogo mínimo que necesita este tier: por piece, su nombre y los NOMBRES de
// sus actions. El wiring decide de dónde salen (aquí es opaco: son datos).
export type CatalogAction = { name: string };
export type CatalogPiece = { name: string; actions: CatalogAction[] };

// --- validatePiecesExist ---------------------------------------------------
// Por cada piece step (type piece/default), comprueba que pieceName exista en el
// catálogo y que actionName exista entre las actions de esa piece. Steps no-piece
// (router/loop) y steps sin pieceName/actionName se saltan (el tier estructural ya
// cubre piece-missing-action). Devuelve solo findings de error.
export function validatePiecesExist(req: ExecuteRequest, catalog: CatalogPiece[]): WfFinding[] {
  const byName = new Map(catalog.map((p) => [p.name, p]));
  const findings: WfFinding[] = [];
  for (const step of flattenSteps(req.steps)) {
    const t = step.type ?? "piece";
    if (t !== "piece") continue;
    if (!step.pieceName || !step.actionName) continue;
    const path = step.name ?? "<unnamed>";
    const piece = byName.get(step.pieceName);
    if (!piece) {
      findings.push({
        level: "error",
        code: "piece-not-found",
        message: `piece "${step.pieceName}" not found in catalog`,
        path,
      });
      continue;
    }
    const actionNames = piece.actions.map((a) => a.name);
    if (!actionNames.includes(step.actionName)) {
      findings.push({
        level: "error",
        code: "action-not-found",
        message: `action "${step.actionName}" not found in piece "${step.pieceName}"`,
        path,
      });
    }
  }
  return findings;
}

// --- validateConnections ----------------------------------------------------
// Por cada input, extrae sus connectionRefs ({{connections['<id>']}}); cada ref que
// NO esté en `available` (externalIds del vault del proyecto) -> connection-not-found.
// Solo mira inputs: las connections declaradas en step.connection (no en input) las
// resuelve el flow-builder al construir, no se validan aquí.
export function validateConnections(req: ExecuteRequest, available: string[]): WfFinding[] {
  const avail = new Set(available);
  const findings: WfFinding[] = [];
  for (const step of flattenSteps(req.steps)) {
    if (!step.input) continue;
    const refs = extractRefs(step.input).connectionRefs;
    const path = step.name ?? "<unnamed>";
    for (const r of refs) {
      if (!avail.has(r)) {
        findings.push({
          level: "error",
          code: "connection-not-found",
          message: `connection "${r}" not found in project`,
          path,
        });
      }
    }
  }
  return findings;
}

// --- validateWorkflow: combinación estructura + contexto --------------------
// Orquesta el tier estructural (validateWorkflowStructure: forma, unicidad, refs
// de steps) + el tier de contexto (pieces + connections). Devuelve { ok, findings };
// ok = sin findings de error. PURA: solo combina datos que recibe.
export function validateWorkflow(
  req: ExecuteRequest,
  catalog: CatalogPiece[],
  available: string[],
): WfValidation {
  const findings: WfFinding[] = [
    ...validateWorkflowStructure(req).findings,
    ...validatePiecesExist(req, catalog),
    ...validateConnections(req, available),
  ];
  const ok = !findings.some((f) => f.level === "error");
  return { ok, findings };
}

// Tipo re-exportado para el wiring ( handlers construye ExecuteRequest desde el body).
export type { WfStep, ExecuteRequest, WfFinding, WfValidation };