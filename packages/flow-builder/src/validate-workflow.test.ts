import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flattenSteps,
  collectStepNames,
  extractRefs,
  validateStructure,
  validateReferences,
  validateWorkflowStructure,
  type WfStep,
  type ExecuteRequest,
  type WfValidation,
} from "./validate-workflow.js";

// Oráculo independiente: helpers de fixture aquí, no importados del target.

const piece = (name: string, input: Record<string, unknown> = {}): WfStep => ({
  name,
  pieceName: "slack",
  pieceVersion: "1.2.0",
  actionName: "send_message",
  input,
});

const wf = (steps: WfStep[]): ExecuteRequest => ({ steps });

const hasCode = (v: WfValidation, code: string): boolean =>
  v.findings.some((f) => f.code === code && f.level === "error");

// --- validateWorkflowStructure: flujo lineal válido ---

test("validateWorkflowStructure: flujo lineal válido (2 piece steps con ref) -> ok", () => {
  const v = validateWorkflowStructure(wf([
    piece("step1", { text: "hi" }),
    piece("step2", { text: "{{step1.output}}" }),
  ]));
  assert.equal(v.ok, true);
  assert.equal(v.findings.length, 0, JSON.stringify(v.findings));
});

// --- duplicate-step-name ---

test("validateWorkflowStructure: nombre duplicado -> error duplicate-step-name", () => {
  const v = validateWorkflowStructure(wf([
    piece("dup", { text: "a" }),
    piece("dup", { text: "b" }),
  ]));
  assert.equal(v.ok, false);
  assert.equal(hasCode(v, "duplicate-step-name"), true);
});

// --- unknown-step-ref ---

test("validateWorkflowStructure: ref a step inexistente -> error unknown-step-ref", () => {
  const v = validateWorkflowStructure(wf([
    piece("s1", { t: "{{stepX.output}}" }),
  ]));
  assert.equal(v.ok, false);
  assert.equal(hasCode(v, "unknown-step-ref"), true);
});

// --- piece-missing-action ---

test("validateWorkflowStructure: piece step sin actionName -> error piece-missing-action", () => {
  const v = validateWorkflowStructure(wf([
    { name: "s1", pieceName: "slack" } as WfStep,
  ]));
  assert.equal(v.ok, false);
  assert.equal(hasCode(v, "piece-missing-action"), true);
});

// --- router-no-branches ---

test("validateWorkflowStructure: router sin branches -> error router-no-branches", () => {
  const v = validateWorkflowStructure(wf([
    { name: "r1", type: "router" } as WfStep,
  ]));
  assert.equal(v.ok, false);
  assert.equal(hasCode(v, "router-no-branches"), true);
});

// --- loop-incomplete ---

test("validateWorkflowStructure: loop sin items -> error loop-incomplete", () => {
  const v = validateWorkflowStructure(wf([
    { name: "l1", type: "loop", steps: [piece("b", { x: "{{step1.y}}" })] } as WfStep,
  ]));
  assert.equal(v.ok, false);
  assert.equal(hasCode(v, "loop-incomplete"), true);
});

// --- self-ref ---

test("validateWorkflowStructure: self-ref -> error self-ref", () => {
  const v = validateWorkflowStructure(wf([
    piece("s1", { t: "{{s1.output}}" }),
  ]));
  assert.equal(v.ok, false);
  assert.equal(hasCode(v, "self-ref"), true);
});

// --- empty-workflow ---

test("validateWorkflowStructure: workflow vacío -> error empty-workflow", () => {
  const v = validateWorkflowStructure(wf([]));
  assert.equal(v.ok, false);
  assert.equal(hasCode(v, "empty-workflow"), true);
});

// --- invalid-step-name ---

test("validateWorkflowStructure: nombre inválido -> error invalid-step-name", () => {
  const v = validateWorkflowStructure(wf([
    { name: "bad name", pieceName: "a", actionName: "x" } as WfStep,
  ]));
  assert.equal(v.ok, false);
  assert.equal(hasCode(v, "invalid-step-name"), true);
});

// --- extractRefs distingue stepRefs / connectionRefs / trigger ---

test("extractRefs: distingue stepRefs, connectionRefs y trigger", () => {
  const r = extractRefs({
    a: "{{step1.output}}",
    b: "{{connections['slack_c'].token}}",
    c: "{{trigger.body}}",
    nested: { d: "{{step2.value}}", e: "{{step1.output}}" }, // step1 dup -> único
  });
  assert.deepEqual(r.stepRefs, ["step1", "step2"]);
  assert.deepEqual(r.connectionRefs, ["slack_c"]);
  assert.equal(r.usesTrigger, true);
});

test("extractRefs: sin interpolaciones -> listas vacías, usesTrigger false", () => {
  const r = extractRefs({ a: "plain text", b: 123, c: { d: [true, null] } });
  assert.deepEqual(r.stepRefs, []);
  assert.deepEqual(r.connectionRefs, []);
  assert.equal(r.usesTrigger, false);
});

// --- flattenSteps cuenta anidados (router branch + loop body) ---

test("flattenSteps: aplanado recursivo de router branch y loop body en orden", () => {
  const flat = flattenSteps([
    piece("p"),
    {
      name: "r",
      type: "router",
      branches: [{ name: "b1", steps: [piece("rb")] }],
    } as WfStep,
    { name: "l", type: "loop", items: "{{x}}", steps: [piece("lb")] } as WfStep,
  ]);
  assert.equal(flat.length, 5);
  assert.deepEqual(flat.map((s) => s.name), ["p", "r", "rb", "l", "lb"]);
});

test("flattenSteps: fallback steps se incluyen", () => {
  const flat = flattenSteps([
    {
      name: "r",
      type: "router",
      branches: [{ name: "b1", steps: [piece("rb")] }],
      fallback: { steps: [piece("fb")] },
    } as WfStep,
  ]);
  assert.deepEqual(flat.map((s) => s.name), ["r", "rb", "fb"]);
});

// --- collectStepNames ---

test("collectStepNames: names en orden, sin undefined", () => {
  const names = collectStepNames([
    piece("a"),
    { type: "router", branches: [{ steps: [piece("b")] }] } as WfStep,
    { type: "loop", items: "{{x}}", steps: [piece("c")] } as WfStep,
  ]);
  assert.deepEqual(names, ["a", "b", "c"]);
});

// --- connectionRef NO genera error en este tier ---

test("validateReferences: connectionRef no genera error (tier estructural sin vault)", () => {
  const v = validateWorkflowStructure(wf([
    piece("s1", { t: "{{connections['slack_c'].token}}" }),
  ]));
  assert.equal(v.ok, true, JSON.stringify(v.findings));
  assert.equal(v.findings.length, 0);
});

// --- composición válida con router/loop anidados ---

test("validateWorkflowStructure: router+loop válidos con refs correctas -> ok", () => {
  const v = validateWorkflowStructure(wf([
    piece("step1", { text: "hi" }),
    {
      name: "r1",
      type: "router",
      branches: [{ name: "b1", condition: { v: "{{step1.out}}" }, steps: [piece("rb1", { x: "{{step1.out}}" })] }],
    } as WfStep,
    { name: "l1", type: "loop", items: "{{step1.list}}", steps: [piece("lb", { v: "{{step1.x}}" })] } as WfStep,
  ]));
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

// --- router-empty-branch ---

test("validateStructure: branch vacía -> error router-empty-branch", () => {
  const f = validateStructure([{ name: "r1", type: "router", branches: [{ name: "b1", steps: [] }] } as WfStep]);
  assert.equal(f.some((x) => x.code === "router-empty-branch"), true);
});

// --- validateReferences aislado ---

test("validateReferences: devuelve solo self-ref y unknown, no structure errors", () => {
  const f = validateReferences([
    piece("s1", { a: "{{s1.x}}" }),
    piece("s2", { a: "{{nope.x}}" }),
  ]);
  const codes = f.map((x) => x.code);
  assert.deepEqual(codes.sort(), ["self-ref", "unknown-step-ref"]);
});