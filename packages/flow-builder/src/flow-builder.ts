// flow-builder.ts — construye el JSON del workflow que el motor de Activepieces ejecuta.
// Módulo PURO: solo arma objetos JSON. No ejecuta nada, no importa el engine.

import {
  buildRouterStep,
  type RouterStepSpec,
  type RouterAction,
} from "./router-builder.js";
import {
  buildLoopStep,
  type LoopStepSpec,
  type LoopOnItemsAction,
} from "./loop-builder.js";

const NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

export type StepSpec = {
  name: string;
  displayName?: string;
  pieceName: string;
  pieceVersion: string;
  actionName: string;
  input: Record<string, unknown>;
};

export type PieceAction = {
  name: string;
  valid: boolean;
  displayName: string;
  lastUpdatedDate: string;
  type: "PIECE";
  settings: {
    pieceName: string;
    pieceVersion: string;
    actionName: string;
    input: Record<string, unknown>;
    propertySettings: Record<string, unknown>;
    errorHandlingOptions: undefined;
  };
  nextAction?: FlowAction;
};

// Unión de nodos que el engine ejecuta: piece, router o loop. Encadenable vía nextAction.
export type FlowAction = PieceAction | RouterAction | LoopOnItemsAction;

// Referencia a una credencial por nombre, sin exponer el secreto.
export function connectionRef(name: string): string {
  if (!name) throw new Error("connectionRef: name is required");
  return `{{connections['${name}']}}`;
}

// Valida un StepSpec. Lanza con mensaje claro si algo está mal; no lanza si todo ok.
export function validateStepSpec(spec: StepSpec): void {
  if (!NAME_PATTERN.test(spec.name))
    throw new Error(`validateStepSpec: name "${spec.name}" must match /^[a-zA-Z0-9_]+$/`);
  if (!spec.pieceName) throw new Error("validateStepSpec: pieceName is required");
  if (!spec.pieceVersion) throw new Error("validateStepSpec: pieceVersion is required");
  if (!spec.actionName) throw new Error("validateStepSpec: actionName is required");
}

// Construye un nodo PieceAction con la forma exacta que el engine valida.
export function buildPieceStep(spec: StepSpec, lastUpdatedDate: string): PieceAction {
  validateStepSpec(spec);
  const propertySettings: Record<string, unknown> = {};
  for (const key of Object.keys(spec.input)) propertySettings[key] = {};
  return {
    name: spec.name,
    valid: true,
    displayName: spec.displayName ?? spec.name,
    lastUpdatedDate,
    type: "PIECE",
    settings: {
      pieceName: spec.pieceName,
      pieceVersion: spec.pieceVersion,
      actionName: spec.actionName,
      input: spec.input,
      propertySettings,
      errorHandlingOptions: undefined,
    },
  };
}

// Encadena pasos vía nextAction y devuelve la cabeza, o null si está vacío.
// No muta los inputs originales: clona superficialmente cada nodo.
export function chainSteps(steps: PieceAction[]): PieceAction | null {
  if (steps.length === 0) return null;
  const nodes = steps.map((s) => ({ ...s }));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].nextAction = nodes[i + 1];
  return nodes[0] ?? null;
}

// Request que el agente manda: describe el workflow sin exponer secretos.
// Cada step puede ser un piece step (sin `type` o `type !== 'router'`) o un router step.
export type PieceStepReq = {
  name: string;
  displayName?: string;
  pieceName: string;
  pieceVersion: string;
  actionName: string;
  input?: Record<string, unknown>;
  connection?: { name: string; property?: string };
};

export type ExecuteRequest = {
  steps: Array<PieceStepReq | RouterStepSpec | LoopStepSpec>;
};

// Construye un PieceAction desde un piece step del request, inyectando la connection
// en input[property ?? "auth"] sin mutar el input original del step.
function buildPieceStepFromReq(
  s: PieceStepReq,
  lastUpdatedDate: string
): PieceAction {
  const input: Record<string, unknown> = { ...(s.input ?? {}) };
  if (s.connection) input[s.connection.property ?? "auth"] = connectionRef(s.connection.name);
  return buildPieceStep(
    {
      name: s.name,
      displayName: s.displayName,
      pieceName: s.pieceName,
      pieceVersion: s.pieceVersion,
      actionName: s.actionName,
      input,
    },
    lastUpdatedDate
  );
}

// Encadena nodos FlowAction vía nextAction y devuelve la cabeza. No muta los originales.
function chainFlow(nodes: FlowAction[]): FlowAction {
  if (nodes.length === 0) throw new Error("request must have at least one step");
  const copies = nodes.map((n) => ({ ...n }));
  for (let i = 0; i < copies.length - 1; i++) copies[i].nextAction = copies[i + 1];
  return copies[0];
}

// Convierte un step del request en el FlowAction que le corresponde según su type:
// "router" -> RouterAction, "loop" -> LoopOnItemsAction, sin type / otro -> PieceAction.
function stepToNode(
  s: PieceStepReq | RouterStepSpec | LoopStepSpec,
  lastUpdatedDate: string
): FlowAction {
  if (s.type === "router") return buildRouterStep(s, lastUpdatedDate);
  if (s.type === "loop") return buildLoopStep(s, lastUpdatedDate);
  return buildPieceStepFromReq(s, lastUpdatedDate);
}

// Convierte un ExecuteRequest en el FlowAction encadenado que el engine ejecuta.
// Pureza: lastUpdatedDate llega por parámetro (sin Date.now); no muta los steps de entrada.
export function buildFlowFromRequest(
  req: ExecuteRequest,
  lastUpdatedDate: string
): FlowAction {
  if (!Array.isArray(req.steps) || req.steps.length === 0)
    throw new Error("request must have at least one step");
  const nodes = req.steps.map((s) => stepToNode(s, lastUpdatedDate));
  return chainFlow(nodes);
}