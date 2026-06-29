// sanitize-steps.ts — AUTO-SANITIZADO PRE-VALIDACIÓN de nombres de step.
// El agente a veces pone nombres inválidos (ej. "Convert Text to JSON" con
// espacios); en lugar de rechazar y forzar reintentos, reescribimos los
// nombres a la forma válida y actualizamos las referencias {{name.output}}
// para que no se rompan. Módulo PURO: sin red/FS/Date, no muta el input.

import type { WfStep, ExecuteRequest } from "./validate-workflow.js";

export type { WfStep, ExecuteRequest };

// --- 1. sanitizeName: normaliza un nombre a /^[a-zA-Z0-9_]+$/ ---

export function sanitizeName(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "_");
  s = s.replace(/_+/g, "_");
  s = s.replace(/^_+|_+$/g, "");
  if (s.length === 0) return "step";
  if (/^[0-9]/.test(s)) return "s_" + s;
  return s;
}

// --- 2. buildNameMap: originalName -> finalName único (recursivo) ---

// Recorre todos los steps (incluidos branches/fallback/loop) en orden.
function visitNames(step: WfStep, nameMap: Map<string, string>, used: Set<string>): void {
  if (typeof step.name === "string" && !nameMap.has(step.name)) {
    nameMap.set(step.name, uniqueName(sanitizeName(step.name), used));
  }
  if (step.branches) for (const b of step.branches) for (const s of b.steps) visitNames(s, nameMap, used);
  if (step.fallback) for (const s of step.fallback.steps) visitNames(s, nameMap, used);
  if (step.steps) for (const s of step.steps) visitNames(s, nameMap, used);
}

// Garantiza unicidad sufijando '_2','_3',... si colisiona con uno ya asignado.
function uniqueName(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let i = 2;
  while (used.has(`${candidate}_${i}`)) i++;
  const final = `${candidate}_${i}`;
  used.add(final);
  return final;
}

export function buildNameMap(steps: WfStep[]): Map<string, string> {
  const nameMap = new Map<string, string>();
  const used = new Set<string>();
  for (const s of steps) visitNames(s, nameMap, used);
  return nameMap;
}

// --- 3. rewriteRefs: reescribe {{orig...}} -> {{final...}} en strings ---

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Entradas a reescribir: orig != final, excluyendo 'connections' y 'trigger'
// (palabras reservadas del lenguaje de expresiones, no step names).
function collectRewrites(nameMap: Map<string, string>): [string, string][] {
  const out: [string, string][] = [];
  for (const [orig, final] of nameMap) {
    if (orig === final) continue;
    if (orig === "connections" || orig === "trigger") continue;
    out.push([orig, final]);
  }
  return out;
}

// Reemplaza, en un string, cada `{{` + espacios + orig (+ límite no-identificador)
// por `{{` + espacios + final. Conserva los espacios internos de `{{  orig`.
function rewriteString(s: string, rewrites: [string, string][]): string {
  let out = s;
  for (const [orig, final] of rewrites) {
    const re = new RegExp(`(\\{\\{\\s*)${escapeRe(orig)}(?=[.\\[\\}\\s])`, "g");
    out = out.replace(re, `$1${final}`);
  }
  return out;
}

// Recorre recursivo objetos/arrays/strings sin mutar el original.
function rewriteValue(value: unknown, rewrites: [string, string][]): unknown {
  if (typeof value === "string") return rewriteString(value, rewrites);
  if (Array.isArray(value)) return value.map((v) => rewriteValue(v, rewrites));
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k in rec) out[k] = rewriteValue(rec[k], rewrites);
    return out;
  }
  return value;
}

export function rewriteRefs(value: unknown, nameMap: Map<string, string>): unknown {
  return rewriteValue(value, collectRewrites(nameMap));
}

// --- 4. sanitizeSteps: nuevo árbol con names sanitizados y refs reescritas ---

function rewriteStep(step: WfStep, nameMap: Map<string, string>): WfStep {
  const out: WfStep = { ...step };
  if (typeof step.name === "string") out.name = nameMap.get(step.name) ?? step.name;
  if (step.input) out.input = rewriteRefs(step.input, nameMap) as Record<string, unknown>;
  if (step.branches) out.branches = step.branches.map((b) => ({ ...b, steps: b.steps.map((s) => rewriteStep(s, nameMap)) }));
  if (step.fallback) out.fallback = { ...step.fallback, steps: step.fallback.steps.map((s) => rewriteStep(s, nameMap)) };
  if (step.steps) out.steps = step.steps.map((s) => rewriteStep(s, nameMap));
  return out;
}

export function sanitizeSteps(req: ExecuteRequest): ExecuteRequest {
  const nameMap = buildNameMap(req.steps);
  return { steps: req.steps.map((s) => rewriteStep(s, nameMap)) };
}