import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPiecesUsed,
  workflowFilePath,
  renderWorkflowDoc,
  renderWorkflowIndex,
  type WorkflowRecord,
  type WorkflowStep,
} from "./workflow-registry.js";

const plainSteps: WorkflowStep[] = [
  { name: "s1", pieceName: "slack", actionName: "send", input: { x: 1 } },
  { name: "s2", pieceName: "gmail", actionName: "read" },
  { name: "s3", pieceName: "slack", actionName: "list" },
];

const routerSteps: WorkflowStep[] = [
  {
    name: "router",
    type: "router",
    branches: [
      { steps: [{ name: "b1", pieceName: "http", actionName: "get" }] },
      { steps: [{ name: "b2", pieceName: "sheets", actionName: "append" }, { name: "b2b", pieceName: "http", actionName: "post" }] },
    ],
    fallback: { steps: [{ name: "fb", pieceName: "slack", actionName: "send" }] },
  },
];

const loopNestedSteps: WorkflowStep[] = [
  {
    name: "loop",
    type: "loop",
    steps: [
      { name: "inner", pieceName: "github", actionName: "list" },
      {
        name: "innerRouter",
        type: "router",
        branches: [{ steps: [{ name: "deep", pieceName: "github", actionName: "get" }] }],
        fallback: { steps: [{ name: "deepfb", pieceName: "notion", actionName: "create" }] },
      },
    ],
  },
  { name: "after", pieceName: "github", actionName: "star" },
];

function sampleWorkflow(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: "001",
    name: "My Workflow",
    description: "desc",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    version: "1.0.0",
    steps: plainSteps,
    ...overrides,
  };
}

test("extractPiecesUsed: plain steps keep order, dedupe", () => {
  assert.deepEqual(extractPiecesUsed(plainSteps), ["slack", "gmail"]);
});

test("extractPiecesUsed: router branches + fallback, dedupe", () => {
  assert.deepEqual(extractPiecesUsed(routerSteps), ["http", "sheets", "slack"]);
});

test("extractPiecesUsed: nested loop + router, dedupe across depth", () => {
  assert.deepEqual(extractPiecesUsed(loopNestedSteps), ["github", "notion"]);
});

test("extractPiecesUsed: empty input -> empty list", () => {
  assert.deepEqual(extractPiecesUsed([]), []);
});

test("workflowFilePath: workflows/wf-<id>.md", () => {
  const wf = sampleWorkflow({ id: "042" });
  assert.deepEqual(workflowFilePath(wf), { dir: "workflows", file: "wf-042.md" });
});

test("renderWorkflowDoc: frontmatter has type:workflow, piecesUsed, stepCount", () => {
  const wf = sampleWorkflow({ steps: routerSteps });
  const doc = renderWorkflowDoc(wf);
  assert.ok(doc.startsWith("---\n"), "starts with frontmatter");
  assert.match(doc, /^type: workflow$/m);
  assert.match(doc, /^id: 001$/m);
  assert.match(doc, /^createdAt: 2026-01-01T00:00:00Z$/m);
  assert.match(doc, /^updatedAt: 2026-01-02T00:00:00Z$/m);
  assert.match(doc, /^version: 1\.0\.0$/m);
  assert.match(doc, /^stepCount: 1$/m);
  assert.match(doc, /^piecesUsed:$/m);
  assert.match(doc, /^  - "http"$/m);
  assert.match(doc, /^  - "sheets"$/m);
  assert.match(doc, /^  - "slack"$/m);
  assert.match(doc, /^# My Workflow$/m);
});

test("renderWorkflowDoc: ## Definition has ```json block with the steps array", () => {
  const wf = sampleWorkflow({ steps: plainSteps });
  const doc = renderWorkflowDoc(wf);
  assert.ok(doc.includes("## Definition"), "has Definition section");
  assert.ok(doc.includes("```json"), "has json code fence");
  const block = doc.split("```json")[1].split("```")[0];
  const parsed = JSON.parse(block);
  assert.deepEqual(parsed, plainSteps);
});

test("renderWorkflowDoc: stepCount is top-level count, not recursive", () => {
  const wf = sampleWorkflow({ steps: loopNestedSteps });
  const doc = renderWorkflowDoc(wf);
  assert.match(doc, /^stepCount: 2$/m);
});

test("renderWorkflowDoc: optional description/version omitted when absent", () => {
  const wf: WorkflowRecord = {
    id: "wf-002",
    name: "Bare",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    steps: [{ name: "s", pieceName: "p", actionName: "a" }],
  };
  const doc = renderWorkflowDoc(wf);
  assert.doesNotMatch(doc, /^description:/m);
  assert.doesNotMatch(doc, /^version:/m);
  assert.match(doc, /^name: "Bare"$/m);
});

test("renderWorkflowIndex: frontmatter type index, title set", () => {
  const idx = renderWorkflowIndex([sampleWorkflow()]);
  assert.ok(idx.startsWith("---\n"));
  assert.match(idx, /^type: index$/m);
  assert.match(idx, /^title: "Workflow registry"$/m);
  assert.match(idx, /^# Workflow registry$/m);
  assert.match(idx, /^Total workflows: 1$/m);
});

test("renderWorkflowIndex: table has N rows with name link, pieces, steps, updated", () => {
  const wfs = [
    sampleWorkflow({ id: "001", name: "Alpha", updatedAt: "2026-01-02T00:00:00Z", steps: plainSteps }),
    sampleWorkflow({ id: "002", name: "Beta", updatedAt: "2026-01-03T00:00:00Z", steps: routerSteps }),
  ];
  const idx = renderWorkflowIndex(wfs);
  const rows = idx.split("\n").filter((l) => l.startsWith("| ["));
  assert.equal(rows.length, 2, "one table row per workflow");
  assert.ok(rows[0].includes("[Alpha](/workflows/wf-001.md)"), "row 0 link");
  assert.ok(rows[0].includes("slack, gmail"), "row 0 pieces");
  assert.ok(rows[0].includes("3"), "row 0 stepCount");
  assert.ok(rows[0].includes("2026-01-02T00:00:00Z"), "row 0 updated");
  assert.ok(rows[1].includes("[Beta](/workflows/wf-002.md)"), "row 1 link");
  assert.ok(rows[1].includes("http, sheets, slack"), "row 1 pieces");
  assert.ok(rows[1].includes("1"), "row 1 stepCount");
});

test("renderWorkflowIndex: empty registry still has header and zero count", () => {
  const idx = renderWorkflowIndex([]);
  assert.match(idx, /^Total workflows: 0$/m);
  assert.match(idx, /^\| Workflow \| Pieces \| Steps \| Updated \|$/m);
  assert.equal(idx.split("\n").filter((l) => l.startsWith("| [")).length, 0);
});