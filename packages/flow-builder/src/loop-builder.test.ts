import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLoopStep,
  type LoopStepSpec,
  type LoopOnItemsAction,
} from "./loop-builder.js";
import {
  buildFlowFromRequest,
  type ExecuteRequest,
  type StepSpec,
} from "./flow-builder.js";

// Oráculo independiente: valores esperados definidos aquí, no importados del target.
const DATE = "2026-01-01T00:00:00.000Z";

const pieceStep = (name: string): StepSpec => ({
  name,
  pieceName: "slack",
  pieceVersion: "1.2.0",
  actionName: "send_message",
  input: { text: "hi" },
});

const loopSpec = (over: Partial<LoopStepSpec> = {}): LoopStepSpec => ({
  name: "loop_1",
  type: "loop",
  items: "{{trigger.list}}",
  steps: [pieceStep("body_1"), pieceStep("body_2")],
  ...over,
});

test("buildLoopStep: produce type LOOP_ON_ITEMS con settings.items correcto", () => {
  const node = buildLoopStep(loopSpec(), DATE);
  assert.equal(node.type, "LOOP_ON_ITEMS");
  assert.equal(node.valid, true);
  assert.equal(node.settings.items, "{{trigger.list}}");
  assert.equal(node.displayName, "loop_1");
  assert.equal(node.lastUpdatedDate, DATE);
  assert.equal(node.name, "loop_1");
});

test("buildLoopStep: respeta displayName cuando se da", () => {
  const node = buildLoopStep(loopSpec({ displayName: "Iterate items" }), DATE);
  assert.equal(node.displayName, "Iterate items");
});

test("buildLoopStep: firstLoopAction es la cabeza de la cadena del cuerpo", () => {
  const node = buildLoopStep(loopSpec(), DATE);
  const head = node.firstLoopAction as { name: string; nextAction?: { name: string; nextAction?: unknown } };
  assert.equal(head.name, "body_1", "firstLoopAction debe ser el primer step");
  assert.equal(head.nextAction?.name, "body_2", "firstLoopAction.nextAction encadena el segundo");
  assert.equal(head.nextAction?.nextAction, undefined, "la cola del cuerpo termina en undefined");
});

test("buildLoopStep: firstLoopAction es undefined-piso cuando el cuerpo es un solo step", () => {
  const node = buildLoopStep(loopSpec({ steps: [pieceStep("only")] }), DATE);
  const head = node.firstLoopAction as { name: string; nextAction?: unknown };
  assert.equal(head.name, "only");
  assert.equal(head.nextAction, undefined);
});

test("buildLoopStep: lanza si items vacío", () => {
  assert.throws(() => buildLoopStep(loopSpec({ items: "" }), DATE), /items is required/);
});

test("buildLoopStep: lanza si steps vacíos", () => {
  assert.throws(() => buildLoopStep(loopSpec({ steps: [] }), DATE), /steps must not be empty/);
});

test("buildLoopStep: lanza si name inválido", () => {
  assert.throws(() => buildLoopStep(loopSpec({ name: "bad name" }), DATE), /must match/);
});

test("buildFlowFromRequest: un step loop produce un nodo LOOP_ON_ITEMS", () => {
  const req: ExecuteRequest = { steps: [loopSpec()] };
  const head = buildFlowFromRequest(req, DATE) as LoopOnItemsAction;
  assert.equal(head.type, "LOOP_ON_ITEMS");
  assert.equal(head.name, "loop_1");
  assert.equal(head.settings.items, "{{trigger.list}}");
  assert.equal((head.firstLoopAction as { name: string }).name, "body_1");
  assert.equal(head.nextAction, undefined);
});

test("buildFlowFromRequest: mezcla piece+loop+router encadena via nextAction en orden", () => {
  const req: ExecuteRequest = {
    steps: [
      { name: "p1", pieceName: "slack", pieceVersion: "1.2.0", actionName: "send_message", input: { text: "a" } },
      loopSpec({ name: "l1" }),
      {
        name: "r1",
        type: "router",
        branches: [
          { name: "b1", condition: { firstValue: "{{x}}", operator: "EXISTS" }, steps: [pieceStep("rb")] },
        ],
      },
    ],
  };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal((head as { type: string; name: string }).type, "PIECE");
  assert.equal((head as { name: string }).name, "p1");
  const mid = (head as { nextAction?: { type: string; name: string } }).nextAction;
  assert.equal(mid?.type, "LOOP_ON_ITEMS");
  assert.equal(mid?.name, "l1");
  const tail = (mid as { nextAction?: { type: string; name: string; nextAction?: unknown } }).nextAction;
  assert.equal(tail?.type, "ROUTER");
  assert.equal(tail?.name, "r1");
  assert.equal((tail as { nextAction?: unknown }).nextAction, undefined);
});

test("buildFlowFromRequest: step sin type sigue siendo piece step (compatibilidad)", () => {
  const req: ExecuteRequest = {
    steps: [
      { name: "p1", pieceName: "slack", pieceVersion: "1.2.0", actionName: "send_message", input: { text: "a" } },
      loopSpec({ name: "l1" }),
    ],
  };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal((head as { type: string }).type, "PIECE");
  assert.equal((head as { nextAction?: { type: string } }).nextAction?.type, "LOOP_ON_ITEMS");
});