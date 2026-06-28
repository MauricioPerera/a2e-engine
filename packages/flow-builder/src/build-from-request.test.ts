import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFlowFromRequest,
  type ExecuteRequest,
  type PieceAction,
} from "./flow-builder.js";

// Oráculo independiente: valores esperados definidos aquí, no importados del target.
const DATE = "2026-01-01T00:00:00.000Z";

type ReqStep = ExecuteRequest["steps"][number];

const baseStep = (over: Partial<ReqStep> = {}): ReqStep => ({
  name: "step_1",
  pieceName: "slack",
  pieceVersion: "1.2.0",
  actionName: "send_message",
  ...over,
});

test("buildFlowFromRequest: lanza si steps es array vacío", () => {
  assert.throws(() => buildFlowFromRequest({ steps: [] }, DATE), /at least one step/);
});

test("buildFlowFromRequest: lanza si steps es undefined", () => {
  const req = { steps: undefined as unknown as ExecuteRequest["steps"] };
  assert.throws(() => buildFlowFromRequest(req, DATE), /at least one step/);
});

test("buildFlowFromRequest: 1 step sin connection deja input intacto", () => {
  const req: ExecuteRequest = {
    steps: [baseStep({ name: "s1", input: { channel: "#general", text: "hi" } })],
  };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal(head.type, "PIECE");
  assert.equal(head.name, "s1");
  assert.deepEqual(head.settings.input, { channel: "#general", text: "hi" });
  assert.equal(head.nextAction, undefined);
});

test("buildFlowFromRequest: step sin input usa {} por defecto", () => {
  const req: ExecuteRequest = { steps: [baseStep({ name: "s1" })] };
  const head = buildFlowFromRequest(req, DATE);
  assert.deepEqual(head.settings.input, {});
});

test("buildFlowFromRequest: inyecta connectionRef en input.auth por defecto", () => {
  const req: ExecuteRequest = {
    steps: [baseStep({ name: "s1", input: { text: "hi" }, connection: { name: "slack" } })],
  };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal(head.settings.input.auth, "{{connections['slack']}}");
  assert.equal(head.settings.input.text, "hi");
});

test("buildFlowFromRequest: respeta property de connection", () => {
  const req: ExecuteRequest = {
    steps: [baseStep({ name: "s1", connection: { name: "slack", property: "token" } })],
  };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal(head.settings.input.token, "{{connections['slack']}}");
  assert.equal(head.settings.input.auth, undefined);
});

test("buildFlowFromRequest: 2 steps se encadenan via nextAction en orden", () => {
  const req: ExecuteRequest = {
    steps: [baseStep({ name: "s1" }), baseStep({ name: "s2" })],
  };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal(head.name, "s1");
  assert.equal(head.nextAction?.name, "s2");
  assert.equal(head.nextAction?.nextAction, undefined);
});

test("buildFlowFromRequest: preserva la referencia como string sin expandir", () => {
  const req: ExecuteRequest = {
    steps: [baseStep({ name: "s1", connection: { name: "secret_conn" } })],
  };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal(typeof head.settings.input.auth, "string");
  assert.equal(head.settings.input.auth, "{{connections['secret_conn']}}");
});

test("buildFlowFromRequest: N steps encadenados en orden (semilla fija)", () => {
  // LCG determinista (semilla fija) — no gameable.
  let state = 123456789;
  const rand = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  const n = 5;
  const steps: ReqStep[] = Array.from({ length: n }, () =>
    baseStep({ name: `s${rand() % 1000}` })
  );
  const head = buildFlowFromRequest({ steps }, DATE);
  let cur: PieceAction | undefined = head;
  for (let i = 0; i < n; i++) {
    assert.ok(cur, `node ${i} no debe ser undefined`);
    assert.equal(cur!.name, steps[i].name, `node ${i} fuera de orden`);
    cur = cur!.nextAction;
  }
  assert.equal(cur, undefined, "la cola debe terminar en undefined");
});

test("buildFlowFromRequest: propaga lastUpdatedDate a cada nodo", () => {
  const req: ExecuteRequest = {
    steps: [baseStep({ name: "s1" }), baseStep({ name: "s2" })],
  };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal(head.lastUpdatedDate, DATE);
  assert.equal(head.nextAction?.lastUpdatedDate, DATE);
});