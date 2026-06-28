import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validatePiecesExist,
  validateConnections,
  validateWorkflow,
  type CatalogPiece,
} from "./validate-workflow-context.js";
import type { WfStep, ExecuteRequest } from "./validate-workflow.js";

// Oráculo independiente: fixtures aquí, no importados del target.

const piece = (name: string, pieceName = "slack", actionName = "send_message", input: Record<string, unknown> = {}): WfStep => ({
  name,
  pieceName,
  pieceVersion: "1.0.0",
  actionName,
  input,
});

const wf = (steps: WfStep[]): ExecuteRequest => ({ steps });

const catalog: CatalogPiece[] = [
  { name: "slack", actions: [{ name: "send_message" }, { name: "list_channels" }] },
  { name: "json", actions: [{ name: "convert_text_to_json" }] },
];

const hasCode = (findings: { code: string }[], code: string): boolean =>
  findings.some((f) => f.code === code);

// --- validatePiecesExist ---

test("validatePiecesExist: piece+action existentes -> sin findings", () => {
  const f = validatePiecesExist(wf([piece("s1", "slack", "send_message")]), catalog);
  assert.equal(f.length, 0, JSON.stringify(f));
});

test("validatePiecesExist: piece inexistente -> piece-not-found", () => {
  const f = validatePiecesExist(wf([piece("s1", "nope", "x")]), catalog);
  assert.equal(f.length, 1);
  assert.equal(hasCode(f, "piece-not-found"), true);
  assert.equal(f[0].level, "error");
});

test("validatePiecesExist: piece existe, action inexistente -> action-not-found", () => {
  const f = validatePiecesExist(wf([piece("s1", "slack", "nope_action")]), catalog);
  assert.equal(f.length, 1);
  assert.equal(hasCode(f, "action-not-found"), true);
});

test("validatePiecesExist: router/loop steps se saltan", () => {
  const f = validatePiecesExist(
    wf([
      { name: "r", type: "router", branches: [{ name: "b", steps: [piece("rb", "slack", "send_message")] }] } as WfStep,
    ]),
    catalog,
  );
  assert.equal(f.length, 0, JSON.stringify(f));
});

// --- validateConnections ---

test("validateConnections: ref disponible -> sin findings", () => {
  const f = validateConnections(
    wf([piece("s1", "slack", "send_message", { auth: "{{connections['slack_c'].token}}" })]),
    ["slack_c"],
  );
  assert.equal(f.length, 0, JSON.stringify(f));
});

test("validateConnections: ref inexistente -> connection-not-found", () => {
  const f = validateConnections(
    wf([piece("s1", "slack", "send_message", { auth: "{{connections['no-existe'].token}}" })]),
    ["slack_c"],
  );
  assert.equal(f.length, 1);
  assert.equal(hasCode(f, "connection-not-found"), true);
  assert.equal(f[0].level, "error");
});

test("validateConnections: sin connectionRefs -> sin findings", () => {
  const f = validateConnections(
    wf([piece("s1", "slack", "send_message", { text: "hi", ref: "{{step1.output}}" })]),
    [],
  );
  assert.equal(f.length, 0, JSON.stringify(f));
});

// --- validateWorkflow: combinación estructura + contexto ---

test("validateWorkflow: workflow válido -> ok", () => {
  const v = validateWorkflow(
    wf([
      piece("s1", "json", "convert_text_to_json", { text: "hi" }),
      piece("s2", "slack", "send_message", { text: "{{s1.output}}" }),
    ]),
    catalog,
    [],
  );
  assert.equal(v.ok, true, JSON.stringify(v.findings));
});

test("validateWorkflow: ref rota + piece inexistente combina findings de ambos tiers", () => {
  const v = validateWorkflow(
    wf([
      piece("s1", "nope", "x", { text: "{{stepX.output}}" }),
    ]),
    catalog,
    [],
  );
  assert.equal(v.ok, false);
  assert.equal(hasCode(v.findings, "unknown-step-ref"), true);
  assert.equal(hasCode(v.findings, "piece-not-found"), true);
});

test("validateWorkflow: connection inexistente -> ok:false connection-not-found", () => {
  const v = validateWorkflow(
    wf([piece("s1", "slack", "send_message", { auth: "{{connections['nope']}}" })]),
    catalog,
    ["slack_c"],
  );
  assert.equal(v.ok, false);
  assert.equal(hasCode(v.findings, "connection-not-found"), true);
});