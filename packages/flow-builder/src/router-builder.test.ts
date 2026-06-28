import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRouterStep,
  type RouterStepSpec,
  type RouterBranchSpec,
  type RouterAction,
} from "./router-builder.js";
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

const branch = (over: Partial<RouterBranchSpec> = {}): RouterBranchSpec => ({
  name: "b1",
  condition: { firstValue: "{{trigger.body.status}}", operator: "TEXT_EXACTLY_MATCHES", secondValue: "ok" },
  steps: [pieceStep("b1_step")],
  ...over,
});

const routerSpec = (over: Partial<RouterStepSpec> = {}): RouterStepSpec => ({
  name: "router_1",
  type: "router",
  branches: [branch()],
  ...over,
});

test("buildRouterStep: produce type ROUTER con settings.branches y children de igual longitud", () => {
  const node = buildRouterStep(routerSpec({ branches: [branch(), branch({ name: "b2" })] }), DATE);
  assert.equal(node.type, "ROUTER");
  assert.equal(node.valid, true);
  assert.equal(node.displayName, "router_1");
  assert.equal(node.lastUpdatedDate, DATE);
  assert.equal(node.settings.branches.length, 2);
  assert.equal(node.children.length, 2);
  assert.equal(node.settings.branches.length, node.children.length);
});

test("buildRouterStep: condicion mapeada a conditions [[...]] con operator/firstValue/secondValue correctos", () => {
  const node = buildRouterStep(routerSpec(), DATE);
  const b0 = node.settings.branches[0];
  assert.equal(b0.branchType, "CONDITION");
  assert.equal((b0 as { branchName: string }).branchName, "b1");
  const cond = (b0 as { conditions: unknown[][] }).conditions[0][0] as {
    firstValue: string; secondValue: string; operator: string; caseSensitive?: boolean;
  };
  assert.equal(cond.firstValue, "{{trigger.body.status}}");
  assert.equal(cond.operator, "TEXT_EXACTLY_MATCHES");
  assert.equal(cond.secondValue, "ok");
  assert.equal(cond.caseSensitive, undefined, "caseSensitive no debe estar si no se da");
});

test("buildRouterStep: secondValue por defecto '' y caseSensitive se propaga cuando se da", () => {
  const node = buildRouterStep(
    routerSpec({
      branches: [
        branch({
          condition: { firstValue: "x", operator: "EXISTS" },
          steps: [pieceStep("s")],
        }),
        branch({
          name: "b2",
          condition: { firstValue: "y", operator: "TEXT_CONTAINS", secondValue: "z", caseSensitive: true },
          steps: [pieceStep("s2")],
        }),
      ],
    }),
    DATE
  );
  const c0 = ((node.settings.branches[0] as { conditions: unknown[][] }).conditions[0][0]) as { secondValue: string; caseSensitive?: boolean };
  assert.equal(c0.secondValue, "");
  assert.equal(c0.caseSensitive, undefined);
  const c1 = ((node.settings.branches[1] as { conditions: unknown[][] }).conditions[0][0]) as { secondValue: string; caseSensitive?: boolean };
  assert.equal(c1.secondValue, "z");
  assert.equal(c1.caseSensitive, true);
});

test("buildRouterStep: executionType ausente o first_match -> EXECUTE_FIRST_MATCH", () => {
  const a = buildRouterStep(routerSpec(), DATE);
  assert.equal(a.settings.executionType, "EXECUTE_FIRST_MATCH");
  const b = buildRouterStep(routerSpec({ executionType: "first_match" }), DATE);
  assert.equal(b.settings.executionType, "EXECUTE_FIRST_MATCH");
});

test("buildRouterStep: executionType all_match -> EXECUTE_ALL_MATCH", () => {
  const node = buildRouterStep(routerSpec({ executionType: "all_match" }), DATE);
  assert.equal(node.settings.executionType, "EXECUTE_ALL_MATCH");
});

test("buildRouterStep: fallback añade branch FALLBACK + su child, children == branches", () => {
  const node = buildRouterStep(
    routerSpec({ branches: [branch(), branch({ name: "b2" })], fallback: { name: "else", steps: [pieceStep("else_step")] } }),
    DATE
  );
  assert.equal(node.settings.branches.length, 3);
  assert.equal(node.children.length, 3);
  const last = node.settings.branches[2];
  assert.equal(last.branchType, "FALLBACK");
  assert.equal((last as { branchName: string }).branchName, "else");
  assert.notEqual(node.children[2], null, "el child del fallback no debe ser null");
  assert.equal((node.children[2] as { name: string }).name, "else_step");
});

test("buildRouterStep: cada child es la cabeza de la cadena de su branch", () => {
  const node = buildRouterStep(
    routerSpec({ branches: [branch({ steps: [pieceStep("a"), pieceStep("b")] })] }),
    DATE
  );
  const head = node.children[0] as { name: string; nextAction?: { name: string } };
  assert.equal(head.name, "a");
  assert.equal(head.nextAction?.name, "b");
});

test("buildRouterStep: lanza si no hay branches", () => {
  assert.throws(
    () => buildRouterStep(routerSpec({ branches: [] }), DATE),
    /at least one branch/
  );
});

test("buildRouterStep: lanza si operator vacío", () => {
  assert.throws(
    () => buildRouterStep(routerSpec({ branches: [branch({ condition: { firstValue: "x", operator: "" } })] }), DATE),
    /operator is required/
  );
});

test("buildRouterStep: lanza si steps vacíos en una branch", () => {
  assert.throws(
    () => buildRouterStep(routerSpec({ branches: [branch({ steps: [] })] }), DATE),
    /steps must not be empty/
  );
});

test("buildRouterStep: lanza si name inválido", () => {
  assert.throws(
    () => buildRouterStep(routerSpec({ name: "bad name" }), DATE),
    /must match/
  );
});

test("buildRouterStep: lanza si fallback con name inválido o steps vacíos", () => {
  assert.throws(
    () => buildRouterStep(routerSpec({ fallback: { name: "bad name", steps: [pieceStep("s")] } }), DATE),
    /must match/
  );
  assert.throws(
    () => buildRouterStep(routerSpec({ fallback: { name: "else", steps: [] } }), DATE),
    /fallback steps must not be empty/
  );
});

test("buildFlowFromRequest: un step router produce un nodo ROUTER", () => {
  const req: ExecuteRequest = { steps: [routerSpec()] };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal(head.type, "ROUTER");
  const r = head as RouterAction;
  assert.equal(r.settings.branches.length, 1);
  assert.equal(r.children.length, 1);
  assert.equal(r.nextAction, undefined);
});

test("buildFlowFromRequest: mezcla piece+router encadena via nextAction en orden", () => {
  const req: ExecuteRequest = {
    steps: [
      { name: "p1", pieceName: "slack", pieceVersion: "1.2.0", actionName: "send_message", input: { text: "a" } },
      routerSpec({ name: "r1" }),
      { name: "p2", pieceName: "slack", pieceVersion: "1.2.0", actionName: "send_message", input: { text: "b" } },
    ],
  };
  const head = buildFlowFromRequest(req, DATE);
  assert.equal(head.type, "PIECE");
  assert.equal((head as { name: string }).name, "p1");
  const mid = (head as { nextAction?: { type: string; name: string } }).nextAction;
  assert.equal(mid?.type, "ROUTER");
  assert.equal(mid?.name, "r1");
  const tail = (mid as { nextAction?: { type: string; name: string } }).nextAction;
  assert.equal(tail?.type, "PIECE");
  assert.equal(tail?.name, "p2");
  assert.equal((tail as { nextAction?: unknown }).nextAction, undefined);
});

test("buildFlowFromRequest: router seguido de router encadena via nextAction", () => {
  const req: ExecuteRequest = { steps: [routerSpec({ name: "r1" }), routerSpec({ name: "r2" })] };
  const head = buildFlowFromRequest(req, DATE) as RouterAction;
  assert.equal(head.type, "ROUTER");
  assert.equal(head.name, "r1");
  assert.equal(head.nextAction?.type, "ROUTER");
  assert.equal((head.nextAction as RouterAction).name, "r2");
});