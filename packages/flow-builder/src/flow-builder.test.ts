import { test } from "node:test";
import assert from "node:assert/strict";
import {
  connectionRef,
  validateStepSpec,
  buildPieceStep,
  chainSteps,
  type StepSpec,
  type PieceAction,
} from "./flow-builder.js";

const goodSpec = (over: Partial<StepSpec> = {}): StepSpec => ({
  name: "step_1",
  pieceName: "slack",
  pieceVersion: "1.2.0",
  actionName: "send_message",
  input: { channel: "#general", text: "hi" },
  ...over,
});

test("connectionRef: formato exacto {{connections['<name>']}}", () => {
  assert.equal(connectionRef("slack"), "{{connections['slack']}}");
  assert.equal(connectionRef("my_conn_2"), "{{connections['my_conn_2']}}");
});

test("connectionRef: lanza si name vacío", () => {
  assert.throws(() => connectionRef(""), /name is required/);
  assert.throws(() => connectionRef("" as string), /name is required/);
});

test("validateStepSpec: acepta un spec válido (no lanza)", () => {
  assert.doesNotThrow(() => validateStepSpec(goodSpec()));
});

test("validateStepSpec: rechaza name con guion", () => {
  assert.throws(() => validateStepSpec(goodSpec({ name: "step-1" })), /must match/);
});

test("validateStepSpec: rechaza name con espacio", () => {
  assert.throws(() => validateStepSpec(goodSpec({ name: "step 1" })), /must match/);
});

test("validateStepSpec: rechaza pieceName vacío", () => {
  assert.throws(() => validateStepSpec(goodSpec({ pieceName: "" })), /pieceName is required/);
});

test("validateStepSpec: rechaza pieceVersion vacío", () => {
  assert.throws(() => validateStepSpec(goodSpec({ pieceVersion: "" })), /pieceVersion is required/);
});

test("validateStepSpec: rechaza actionName vacío", () => {
  assert.throws(() => validateStepSpec(goodSpec({ actionName: "" })), /actionName is required/);
});

test("buildPieceStep: produce la forma exacta del nodo PieceAction", () => {
  const node = buildPieceStep(goodSpec(), "2026-01-01T00:00:00.000Z");
  assert.equal(node.name, "step_1");
  assert.equal(node.valid, true);
  assert.equal(node.displayName, "step_1"); // default = name
  assert.equal(node.lastUpdatedDate, "2026-01-01T00:00:00.000Z");
  assert.equal(node.type, "PIECE");
  assert.deepEqual(node.settings.pieceName, "slack");
  assert.deepEqual(node.settings.pieceVersion, "1.2.0");
  assert.deepEqual(node.settings.actionName, "send_message");
  assert.deepEqual(node.settings.input, { channel: "#general", text: "hi" });
  assert.equal(node.settings.errorHandlingOptions, undefined);
});

test("buildPieceStep: respeta displayName cuando se da", () => {
  const node = buildPieceStep(goodSpec({ displayName: "Send Slack" }), "2026-01-01T00:00:00.000Z");
  assert.equal(node.displayName, "Send Slack");
});

test("buildPieceStep: propertySettings tiene una key {} por cada key de input", () => {
  const node = buildPieceStep(goodSpec({ input: { a: 1, b: 2, c: 3 } }), "2026-01-01T00:00:00.000Z");
  assert.deepEqual(node.settings.propertySettings, { a: {}, b: {}, c: {} });
  // input vacío => propertySettings vacío
  const node2 = buildPieceStep(goodSpec({ input: {} }), "2026-01-01T00:00:00.000Z");
  assert.deepEqual(node2.settings.propertySettings, {});
});

test("buildPieceStep: valida el spec antes de construir", () => {
  assert.throws(() => buildPieceStep(goodSpec({ name: "bad name" }), "2026-01-01T00:00:00.000Z"), /must match/);
});

test("buildPieceStep: preserva connectionRef dentro de input", () => {
  const ref = connectionRef("slack");
  const node = buildPieceStep(goodSpec({ input: { auth: ref } }), "2026-01-01T00:00:00.000Z");
  assert.equal(node.settings.input.auth, "{{connections['slack']}}");
});

test("chainSteps: enlaza nextAction en orden y devuelve la cabeza", () => {
  const a = buildPieceStep(goodSpec({ name: "step_1" }), "2026-01-01T00:00:00.000Z");
  const b = buildPieceStep(goodSpec({ name: "step_2" }), "2026-01-01T00:00:00.000Z");
  const c = buildPieceStep(goodSpec({ name: "step_3" }), "2026-01-01T00:00:00.000Z");
  const head = chainSteps([a, b, c]);
  assert.ok(head, "head no debe ser null");
  assert.equal(head!.name, "step_1");
  assert.equal(head!.nextAction?.name, "step_2");
  assert.equal(head!.nextAction?.nextAction?.name, "step_3");
  assert.equal(head!.nextAction?.nextAction?.nextAction, undefined);
});

test("chainSteps([]) -> null", () => {
  assert.equal(chainSteps([]), null);
});

test("chainSteps: no muta los nodos originales", () => {
  const a = buildPieceStep(goodSpec({ name: "step_1" }), "2026-01-01T00:00:00.000Z");
  const b = buildPieceStep(goodSpec({ name: "step_2" }), "2026-01-01T00:00:00.000Z");
  assert.equal(a.nextAction, undefined, "a no debe tener nextAction antes");
  chainSteps([a, b]);
  assert.equal(a.nextAction, undefined, "a no debe haber sido mutado por chainSteps");
});