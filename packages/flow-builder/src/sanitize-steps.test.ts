import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeName,
  buildNameMap,
  rewriteRefs,
  sanitizeSteps,
  type WfStep,
  type ExecuteRequest,
} from "./sanitize-steps.js";

// --- Helpers de fixture (oráculo independiente, no importa del target) ---

const piece = (name: string, input: Record<string, unknown> = {}): WfStep => ({
  name,
  pieceName: "slack",
  pieceVersion: "1.2.0",
  actionName: "send_message",
  input,
});

const wf = (steps: WfStep[]): ExecuteRequest => ({ steps });

// ======================= sanitizeName =======================

test("sanitizeName: 'Convert Text to JSON' -> 'Convert_Text_to_JSON'", () => {
  assert.equal(sanitizeName("Convert Text to JSON"), "Convert_Text_to_JSON");
});

test("sanitizeName: cadena vacía -> 'step'", () => {
  assert.equal(sanitizeName(""), "step");
  assert.equal(sanitizeName("   "), "step");
  assert.equal(sanitizeName("!!!"), "step");
});

test("sanitizeName: empieza con dígito -> prefijo 's_'", () => {
  assert.equal(sanitizeName("123abc"), "s_123abc");
  assert.equal(sanitizeName("9 lives"), "s_9_lives");
});

test("sanitizeName: chars raros se reemplazan por _ y se colapsan", () => {
  assert.equal(sanitizeName("a-b!c"), "a_b_c");
  assert.equal(sanitizeName("a  b"), "a_b");
  assert.equal(sanitizeName("__foo__"), "foo");
  assert.equal(sanitizeName("naïve café"), "na_ve_caf"); // trailing _ trimmed
});

test("sanitizeName: resultado SIEMPRE matchea /^[a-zA-Z0-9_]+$/", () => {
  const cases = ["Convert Text to JSON", "", "!!!", "123", "a b c", "___", "9lives", "ok"];
  for (const c of cases) assert.match(sanitizeName(c), /^[a-zA-Z0-9_]+$/);
});

// ======================= buildNameMap =======================

test("buildNameMap: mapea nombre inválido a su forma sanitizada", () => {
  const m = buildNameMap([piece("Convert Text to JSON")]);
  assert.equal(m.get("Convert Text to JSON"), "Convert_Text_to_JSON");
});

test("buildNameMap: dos steps que sanitizan al mismo -> sufijo _2", () => {
  // "foo bar" y "foo_bar" ambos sanitizan a "foo_bar"
  const m = buildNameMap([piece("foo bar"), piece("foo_bar")]);
  assert.equal(m.get("foo bar"), "foo_bar");
  assert.equal(m.get("foo_bar"), "foo_bar_2");
});

test("buildNameMap: incluye también entradas donde original == final", () => {
  const m = buildNameMap([piece("valid_name")]);
  assert.equal(m.get("valid_name"), "valid_name");
});

test("buildNameMap: recorre steps anidados (router branch + loop)", () => {
  const m = buildNameMap([
    piece("outer"),
    {
      name: "r",
      type: "router",
      branches: [{ name: "b1", steps: [piece("Branch Step")] }],
    } as WfStep,
    { name: "l", type: "loop", items: "{{x}}", steps: [piece("Loop Step")] } as WfStep,
  ]);
  assert.equal(m.get("Branch Step"), "Branch_Step");
  assert.equal(m.get("Loop Step"), "Loop_Step");
});

test("buildNameMap: colisión triple produce _2 y _3", () => {
  const m = buildNameMap([piece("a b"), piece("a_b"), piece("a-b")]);
  assert.equal(m.get("a b"), "a_b");
  assert.equal(m.get("a_b"), "a_b_2");
  assert.equal(m.get("a-b"), "a_b_3");
});

// ======================= rewriteRefs =======================

test("rewriteRefs: reescribe {{Old Name.output}} -> {{New_Name.output}}", () => {
  const m = new Map([["Old Name", "New_Name"]]);
  const out = rewriteRefs({ text: "{{Old Name.output}}" }, m) as { text: string };
  assert.equal(out.text, "{{New_Name.output}}");
});

test("rewriteRefs: NO toca {{connections['x']}}", () => {
  const m = new Map([["connections", "connections_2"], ["Some Step", "Some_Step"]]);
  const out = rewriteRefs({ a: "{{connections['slack_c'].token}}", b: "{{Some Step.x}}" }, m) as Record<string, string>;
  assert.equal(out.a, "{{connections['slack_c'].token}}");
  assert.equal(out.b, "{{Some_Step.x}}");
});

test("rewriteRefs: NO toca {{trigger...}}", () => {
  const m = new Map([["trigger", "trigger_2"], ["My Step", "My_Step"]]);
  const out = rewriteRefs({ a: "{{trigger.body}}", b: "{{My Step.x}}" }, m) as Record<string, string>;
  assert.equal(out.a, "{{trigger.body}}");
  assert.equal(out.b, "{{My_Step.x}}");
});

test("rewriteRefs: no reescribe si orig == final (step ya válido)", () => {
  const m = new Map([["valid_step", "valid_step"]]);
  const out = rewriteRefs({ a: "{{valid_step.output}}" }, m) as { a: string };
  assert.equal(out.a, "{{valid_step.output}}");
});

test("rewriteRefs: respeta límite no-identificador (no reescribe prefijos)", () => {
  // "step" NO debe reescribir "{{step1.output}}" porque "1" es identificador
  const m = new Map([["step", "step_renamed"]]);
  const out = rewriteRefs({ a: "{{step1.output}}", b: "{{step.output}}" }, m) as Record<string, string>;
  assert.equal(out.a, "{{step1.output}}");
  assert.equal(out.b, "{{step_renamed.output}}");
});

test("rewriteRefs: recorre arrays y objetos anidados, no muta original", () => {
  const m = new Map([["Old Name", "New_Name"]]);
  const input = { list: ["{{Old Name.x}}", { deep: "{{Old Name.y}}" }] };
  const inputCopy = JSON.parse(JSON.stringify(input));
  const out = rewriteRefs(input, m) as { list: [string, { deep: string }] };
  assert.equal(out.list[0], "{{New_Name.x}}");
  assert.equal(out.list[1].deep, "{{New_Name.y}}");
  assert.deepEqual(input, inputCopy, "original sin mutar");
});

// ======================= sanitizeSteps =======================

test("sanitizeSteps: renombra step y reescribe refs en inputs", () => {
  const req = wf([
    piece("Convert Text to JSON", { raw: "x" }),
    piece("Consumer", { text: "{{Convert Text to JSON.output}}" }),
  ]);
  const out = sanitizeSteps(req);
  assert.equal(out.steps[0].name, "Convert_Text_to_JSON");
  assert.equal(out.steps[1].name, "Consumer");
  assert.equal((out.steps[1].input as { text: string }).text, "{{Convert_Text_to_JSON.output}}");
});

test("sanitizeSteps: renombra steps anidados (router branch + loop)", () => {
  const req = wf([
    piece("Step One", { v: "1" }),
    {
      name: "My Router",
      type: "router",
      branches: [
        { name: "b1", condition: { x: 1 }, steps: [piece("Branch Step", { ref: "{{Step One.output}}" })] },
      ],
    } as WfStep,
    { name: "My Loop", type: "loop", items: "{{Step One.list}}", steps: [piece("Loop Step", { ref: "{{Step One.x}}" })] } as WfStep,
  ]);
  const out = sanitizeSteps(req);
  assert.equal(out.steps[0].name, "Step_One");
  assert.equal(out.steps[1].name, "My_Router");
  assert.equal(out.steps[1].branches![0].steps[0].name, "Branch_Step");
  assert.equal(out.steps[2].name, "My_Loop");
  assert.equal(out.steps[2].steps![0].name, "Loop_Step");
  // refs reescritas en inputs anidados
  assert.equal((out.steps[1].branches![0].steps[0].input as { ref: string }).ref, "{{Step_One.output}}");
  assert.equal((out.steps[2].steps![0].input as { ref: string }).ref, "{{Step_One.x}}");
});

test("sanitizeSteps: NO muta el input original", () => {
  const req = wf([
    piece("Convert Text to JSON", { text: "{{Convert Text to JSON.output}}" }),
  ]);
  const reqCopy = JSON.parse(JSON.stringify(req));
  sanitizeSteps(req);
  assert.deepEqual(req, reqCopy, "request original sin mutar");
});

test("sanitizeSteps: step ya válido no cambia", () => {
  const req = wf([piece("valid_step", { text: "{{valid_step.output}}" })]);
  const out = sanitizeSteps(req);
  assert.equal(out.steps[0].name, "valid_step");
  assert.equal((out.steps[0].input as { text: string }).text, "{{valid_step.output}}");
});

test("sanitizeSteps: conserva campos del step (type, pieceName, actionName)", () => {
  const req = wf([
    { name: "Bad Name", type: "router", pieceName: "x", actionName: "y", branches: [{ steps: [] }] } as WfStep,
  ]);
  const out = sanitizeSteps(req);
  const s = out.steps[0];
  assert.equal(s.name, "Bad_Name");
  assert.equal(s.type, "router");
  assert.equal(s.pieceName, "x");
  assert.equal(s.actionName, "y");
});

test("sanitizeSteps: resultado pasa el validador (nombres válidos + refs coherentes)", async () => {
  const { validateWorkflowStructure } = await import("./validate-workflow.js");
  const req = wf([
    piece("Convert Text to JSON", { raw: "x" }),
    piece("Second Step", { text: "{{Convert Text to JSON.output}}" }),
  ]);
  const sanitized = sanitizeSteps(req);
  const v = validateWorkflowStructure(sanitized);
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});