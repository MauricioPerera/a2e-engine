// router-builder.ts — construye el nodo ROUTER (ramas condicionales) con la forma
// exacta que el engine de Activepieces valida. Módulo PURO: solo arma objetos JSON.
// Importa y reutiliza las funciones puras de flow-builder (buildPieceStep, chainSteps).

import {
  buildPieceStep,
  chainSteps,
  type StepSpec,
  type PieceAction,
  type FlowAction,
} from "./flow-builder.js";

const NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

// --- Tipos agent-facing (lo que el agente manda dentro de un step router) ---

export type RouterBranchSpec = {
  name: string;
  condition: {
    firstValue: string;
    operator: string;
    secondValue?: string;
    caseSensitive?: boolean;
  };
  steps: StepSpec[];
};

export type RouterStepSpec = {
  name: string;
  displayName?: string;
  type: "router";
  executionType?: "first_match" | "all_match";
  branches: RouterBranchSpec[];
  fallback?: { name: string; steps: StepSpec[] };
};

// --- Tipos engine-facing (la forma exacta que el engine valida) ---

export type RouterBranchCondition = {
  firstValue: string;
  secondValue: string;
  operator: string;
  caseSensitive?: boolean;
};

export type RouterBranch =
  | {
      branchType: "CONDITION";
      branchName: string;
      conditions: RouterBranchCondition[][];
    }
  | { branchType: "FALLBACK"; branchName: string };

export type RouterAction = {
  name: string;
  valid: boolean;
  displayName: string;
  lastUpdatedDate: string;
  type: "ROUTER";
  settings: {
    executionType: "EXECUTE_FIRST_MATCH" | "EXECUTE_ALL_MATCH";
    branches: RouterBranch[];
  };
  children: Array<PieceAction | null>;
  nextAction?: FlowAction;
};

// Valida un RouterBranchSpec: operator no vacío y steps no vacíos.
function validateBranch(branch: RouterBranchSpec): void {
  if (!branch.condition.operator)
    throw new Error(`buildRouterStep: branch "${branch.name}" operator is required`);
  if (branch.steps.length === 0)
    throw new Error(`buildRouterStep: branch "${branch.name}" steps must not be empty`);
}

// Valida el fallback: name válido y steps no vacíos.
function validateFallback(fb: { name: string; steps: StepSpec[] }): void {
  if (!NAME_PATTERN.test(fb.name))
    throw new Error(`buildRouterStep: fallback name "${fb.name}" must match /^[a-zA-Z0-9_]+$/`);
  if (fb.steps.length === 0)
    throw new Error("buildRouterStep: fallback steps must not be empty");
}

// Valida un RouterStepSpec completo. Lanza con mensaje claro; no lanza si todo ok.
function validateRouterStepSpec(spec: RouterStepSpec): void {
  if (!NAME_PATTERN.test(spec.name))
    throw new Error(`buildRouterStep: name "${spec.name}" must match /^[a-zA-Z0-9_]+$/`);
  if (!Array.isArray(spec.branches) || spec.branches.length === 0)
    throw new Error("buildRouterStep: at least one branch is required");
  for (const b of spec.branches) validateBranch(b);
  if (spec.fallback) validateFallback(spec.fallback);
}

// Mapea una RouterBranchSpec a la branch CONDITION que el engine espera:
// conditions es AND de grupos OR; caso común un solo grupo con una sola cond -> [[cond]].
function buildBranchSettings(branch: RouterBranchSpec): RouterBranch {
  const c = branch.condition;
  const cond: RouterBranchCondition = {
    firstValue: c.firstValue,
    secondValue: c.secondValue ?? "",
    operator: c.operator,
  };
  if (c.caseSensitive != null) cond.caseSensitive = c.caseSensitive;
  return {
    branchType: "CONDITION",
    branchName: branch.name,
    conditions: [[cond]],
  };
}

// Construye la cabeza de la cadena que corre si la branch matchea (o null si steps vacío).
function buildBranchChild(
  branch: { steps: StepSpec[] },
  lastUpdatedDate: string
): PieceAction | null {
  return chainSteps(branch.steps.map((s) => buildPieceStep(s, lastUpdatedDate)));
}

// Construye un nodo RouterAction con la forma exacta que el engine valida.
export function buildRouterStep(
  spec: RouterStepSpec,
  lastUpdatedDate: string
): RouterAction {
  validateRouterStepSpec(spec);
  const branches = spec.branches.map(buildBranchSettings);
  const children = spec.branches.map((b) => buildBranchChild(b, lastUpdatedDate));
  if (spec.fallback) {
    branches.push({ branchType: "FALLBACK", branchName: spec.fallback.name });
    children.push(buildBranchChild(spec.fallback, lastUpdatedDate));
  }
  return {
    name: spec.name,
    valid: true,
    displayName: spec.displayName ?? spec.name,
    lastUpdatedDate,
    type: "ROUTER",
    settings: {
      executionType:
        spec.executionType === "all_match"
          ? "EXECUTE_ALL_MATCH"
          : "EXECUTE_FIRST_MATCH",
      branches,
    },
    children,
  };
}