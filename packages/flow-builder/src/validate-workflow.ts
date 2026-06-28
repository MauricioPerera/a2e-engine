// validate-workflow.ts — validación PRE-EJECUCIÓN de un workflow entero (tier
// estructural puro, sin catálogo ni vault). Caza errores de composición del agente
// ANTES de ejecutar: nombres duplicados, referencias a steps inexistentes, estructura
// de router/loop. Módulo PURO: solo lee el request, sin red/FS/Date.

// --- Tipos agent-facing ---

export type WfStep = {
  name?: string;
  type?: string;
  pieceName?: string;
  pieceVersion?: string;
  actionName?: string;
  input?: Record<string, unknown>;
  connection?: { name: string; property?: string };
  branches?: { name?: string; condition?: unknown; steps: WfStep[] }[];
  fallback?: { name?: string; steps: WfStep[] };
  items?: string;
  steps?: WfStep[];
};

export type ExecuteRequest = { steps: WfStep[] };

export type WfFinding = {
  level: "error" | "warn";
  code: string;
  message: string;
  path?: string;
};

export type WfValidation = { ok: boolean; findings: WfFinding[] };

// --- Constantes ---

const NAME_PATTERN = /^[a-zA-Z0-9_]+$/;
const MUSTACHE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const CONN_RE = /connections\[?['"]?([a-zA-Z0-9_-]+)/;
const LEADING_ID_RE = /^([a-zA-Z0-9_]+)/;

// --- Acumulador interno de refs (mutable, recorrido recursivo) ---

type RefsAcc = { stepRefs: string[]; connectionRefs: string[]; usesTrigger: boolean };

function addUnique(list: string[], v: string): void {
  if (!list.includes(v)) list.push(v);
}

// --- 1. flattenSteps: aplanado recursivo, en orden de aparición ---

// Agrega step y recursa sobre sus hijos (branch bodies, fallback, loop body).
function pushFlat(out: WfStep[], step: WfStep): void {
  out.push(step);
  if (step.branches) for (const b of step.branches) for (const s of b.steps) pushFlat(out, s);
  if (step.fallback) for (const s of step.fallback.steps) pushFlat(out, s);
  if (step.steps) for (const s of step.steps) pushFlat(out, s);
}

export function flattenSteps(steps: WfStep[]): WfStep[] {
  const out: WfStep[] = [];
  for (const s of steps) pushFlat(out, s);
  return out;
}

// --- 2. collectStepNames: names (no undefined) de flattenSteps ---

export function collectStepNames(steps: WfStep[]): string[] {
  return flattenSteps(steps)
    .map((s) => s.name)
    .filter((n): n is string => typeof n === "string");
}

// --- 3. extractRefs: clasifica identificadores dentro de {{ ... }} ---

// Clasifica el contenido de una interpolación según su identificador líder.
function classifyRef(content: string, acc: RefsAcc): void {
  if (content.startsWith("connections")) {
    const cm = CONN_RE.exec(content);
    if (cm) addUnique(acc.connectionRefs, cm[1]);
    return;
  }
  const im = LEADING_ID_RE.exec(content);
  if (!im) return;
  const id = im[1];
  if (id === "trigger") {
    acc.usesTrigger = true;
    return;
  }
  addUnique(acc.stepRefs, id);
}

// Recorre un string extrayendo todas las interpolaciones {{ ... }}.
function collectFromString(s: string, acc: RefsAcc): void {
  let m: RegExpExecArray | null;
  while ((m = MUSTACHE_RE.exec(s)) !== null) classifyRef(m[1], acc);
}

// Recorre recursivamente objetos/arrays/strings del input.
function walkRefs(value: unknown, acc: RefsAcc): void {
  if (typeof value === "string") {
    collectFromString(value, acc);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkRefs(v, acc);
    return;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const k in rec) walkRefs(rec[k], acc);
  }
}

export function extractRefs(input: unknown): {
  stepRefs: string[];
  connectionRefs: string[];
  usesTrigger: boolean;
} {
  const acc: RefsAcc = { stepRefs: [], connectionRefs: [], usesTrigger: false };
  walkRefs(input, acc);
  return {
    stepRefs: acc.stepRefs,
    connectionRefs: acc.connectionRefs,
    usesTrigger: acc.usesTrigger,
  };
}

// --- 4. validateStructure: forma del workflow y de cada step + unicidad ---

function pathOf(step: WfStep): string {
  return step.name ?? "<unnamed>";
}

function validateName(step: WfStep, findings: WfFinding[]): void {
  if (step.name === undefined) {
    findings.push({ level: "error", code: "invalid-step-name", message: "step missing name", path: pathOf(step) });
  } else if (!NAME_PATTERN.test(step.name)) {
    findings.push({
      level: "error",
      code: "invalid-step-name",
      message: `step name "${step.name}" must match /^[a-zA-Z0-9_]+$/`,
      path: step.name,
    });
  }
}

function validatePiece(step: WfStep, findings: WfFinding[]): void {
  if (!step.pieceName || !step.actionName) {
    const missing = !step.pieceName && !step.actionName ? "pieceName and actionName" : !step.pieceName ? "pieceName" : "actionName";
    findings.push({ level: "error", code: "piece-missing-action", message: `piece step requires ${missing}`, path: pathOf(step) });
  }
}

function validateRouter(step: WfStep, findings: WfFinding[]): void {
  if (!step.branches || step.branches.length === 0) {
    findings.push({ level: "error", code: "router-no-branches", message: "router step requires non-empty branches", path: pathOf(step) });
    return;
  }
  for (const b of step.branches) {
    if (!b.steps || b.steps.length === 0) {
      findings.push({ level: "error", code: "router-empty-branch", message: "router branch requires non-empty steps", path: pathOf(step) });
    }
  }
}

function validateLoop(step: WfStep, findings: WfFinding[]): void {
  if (!step.items || !step.steps || step.steps.length === 0) {
    findings.push({ level: "error", code: "loop-incomplete", message: "loop step requires items and non-empty steps", path: pathOf(step) });
  }
}

// Despacha la validación específica según el tipo (default = piece).
function validateTypedStep(step: WfStep, findings: WfFinding[]): void {
  const t = step.type ?? "piece";
  if (t === "piece") validatePiece(step, findings);
  else if (t === "router") validateRouter(step, findings);
  else if (t === "loop") validateLoop(step, findings);
}

function validateStepStructure(step: WfStep, findings: WfFinding[]): void {
  validateName(step, findings);
  validateTypedStep(step, findings);
}

function findDuplicateNames(names: string[], findings: WfFinding[]): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const n of names) {
    if (seen.has(n) && !reported.has(n)) {
      findings.push({ level: "error", code: "duplicate-step-name", message: `duplicate step name "${n}"`, path: n });
      reported.add(n);
    }
    seen.add(n);
  }
}

export function validateStructure(steps: WfStep[]): WfFinding[] {
  const findings: WfFinding[] = [];
  if (steps.length === 0) {
    findings.push({ level: "error", code: "empty-workflow", message: "workflow has no steps" });
  }
  for (const step of flattenSteps(steps)) validateStepStructure(step, findings);
  findDuplicateNames(collectStepNames(steps), findings);
  return findings;
}

// --- 5. validateReferences: stepRefs apuntan a steps definidos (no self) ---

function validateOneRef(ref: string, step: WfStep, defined: Set<string>, findings: WfFinding[]): void {
  const sp = pathOf(step);
  if (ref === step.name) {
    findings.push({ level: "error", code: "self-ref", message: `step "${ref}" references itself`, path: sp });
  } else if (!defined.has(ref)) {
    findings.push({ level: "error", code: "unknown-step-ref", message: `step references unknown step "${ref}"`, path: `${sp} -> ${ref}` });
  }
}

export function validateReferences(steps: WfStep[]): WfFinding[] {
  const findings: WfFinding[] = [];
  const defined = new Set(collectStepNames(steps));
  for (const step of flattenSteps(steps)) {
    if (!step.input) continue;
    const refs = extractRefs(step.input).stepRefs;
    for (const ref of refs) validateOneRef(ref, step, defined, findings);
  }
  return findings;
}

// --- 6. validateWorkflowStructure: orquesta estructura + referencias ---

export function validateWorkflowStructure(req: ExecuteRequest): WfValidation {
  const findings = [...validateStructure(req.steps), ...validateReferences(req.steps)];
  const ok = !findings.some((f) => f.level === "error");
  return { ok, findings };
}