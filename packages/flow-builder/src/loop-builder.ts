// loop-builder.ts — construye el nodo LOOP_ON_ITEMS (iteración sobre items) con la
// forma exacta que el engine de Activepieces valida. Módulo PURO: solo arma JSON.
// Reutiliza las funciones puras de flow-builder (buildPieceStep, chainSteps).

import {
  buildPieceStep,
  chainSteps,
  type StepSpec,
  type FlowAction,
} from "./flow-builder.js";

const NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

// --- Tipo agent-facing (lo que el agente manda dentro de un step loop) ---

export type LoopStepSpec = {
  name: string;
  displayName?: string;
  type: "loop";
  items: string;
  steps: StepSpec[];
};

// --- Tipo engine-facing (la forma exacta que el engine valida) ---

export type LoopOnItemsAction = {
  name: string;
  valid: boolean;
  displayName: string;
  lastUpdatedDate: string;
  type: "LOOP_ON_ITEMS";
  settings: { items: string };
  firstLoopAction?: FlowAction;
  nextAction?: FlowAction;
};

// Valida un LoopStepSpec: name válido, items no vacío, steps no vacíos. Lanza claro.
function validateLoopStepSpec(spec: LoopStepSpec): void {
  if (!NAME_PATTERN.test(spec.name))
    throw new Error(`buildLoopStep: name "${spec.name}" must match /^[a-zA-Z0-9_]+$/`);
  if (!spec.items) throw new Error("buildLoopStep: items is required");
  if (!Array.isArray(spec.steps) || spec.steps.length === 0)
    throw new Error("buildLoopStep: steps must not be empty");
}

// Construye un nodo LoopOnItemsAction con la forma exacta que el engine valida.
// firstLoopAction es la cabeza de la cadena que corre por cada item (cuerpo del loop).
export function buildLoopStep(
  spec: LoopStepSpec,
  lastUpdatedDate: string
): LoopOnItemsAction {
  validateLoopStepSpec(spec);
  const firstLoopAction =
    chainSteps(spec.steps.map((s) => buildPieceStep(s, lastUpdatedDate))) ?? undefined;
  return {
    name: spec.name,
    valid: true,
    displayName: spec.displayName ?? spec.name,
    lastUpdatedDate,
    type: "LOOP_ON_ITEMS",
    settings: { items: spec.items },
    firstLoopAction,
  };
}