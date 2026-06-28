// Pure rendering logic for the workflow registry.
// No network, no FS, no git, no Date. Just transforms of in-memory records.

export type WorkflowStep = {
  name: string;
  type?: string;
  pieceName?: string;
  actionName?: string;
  input?: Record<string, unknown>;
  branches?: { steps: WorkflowStep[] }[];
  fallback?: { steps: WorkflowStep[] };
  steps?: WorkflowStep[];
};

export type WorkflowRecord = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  version?: string;
  steps: WorkflowStep[];
};

type PieceAcc = { seen: Set<string>; order: string[] };

function collectPieces(step: WorkflowStep, acc: PieceAcc): void {
  const name = step.pieceName;
  if (name !== undefined && !acc.seen.has(name)) {
    acc.seen.add(name);
    acc.order.push(name);
  }
  walkPieces(step.steps ?? [], acc);
  for (const branch of step.branches ?? []) {
    walkPieces(branch.steps ?? [], acc);
  }
  if (step.fallback !== undefined) {
    walkPieces(step.fallback.steps ?? [], acc);
  }
}

function walkPieces(steps: WorkflowStep[], acc: PieceAcc): void {
  for (const step of steps) {
    collectPieces(step, acc);
  }
}

/** Recursively collects every pieceName mentioned in the step tree, deduped, in order of appearance. */
export function extractPiecesUsed(steps: WorkflowStep[]): string[] {
  const acc: PieceAcc = { seen: new Set(), order: [] };
  walkPieces(steps, acc);
  return acc.order;
}

/** Stable path for a workflow doc inside the registry. */
export function workflowFilePath(wf: WorkflowRecord): { dir: string; file: string } {
  return { dir: "workflows", file: `wf-${wf.id}.md` };
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function stepSummary(step: WorkflowStep): string {
  const kind = step.type ?? "piece";
  if (kind === "router") {
    const branchCount = step.branches?.length ?? 0;
    const hasFallback = step.fallback !== undefined ? " + fallback" : "";
    return `- ${step.name} (router: ${branchCount} branches${hasFallback})`;
  }
  if (kind === "loop") {
    return `- ${step.name} (loop: ${step.steps?.length ?? 0} steps)`;
  }
  return `- ${step.name} [${step.pieceName ?? "?"}/${step.actionName ?? "?"}]`;
}

function workflowFrontmatter(wf: WorkflowRecord, pieces: string[]): string {
  const lines: string[] = ["---"];
  lines.push("type: workflow");
  lines.push(`id: ${wf.id}`);
  lines.push(`name: ${yamlScalar(wf.name)}`);
  if (wf.description !== undefined) {
    lines.push(`description: ${yamlScalar(wf.description)}`);
  }
  lines.push(`createdAt: ${wf.createdAt}`);
  lines.push(`updatedAt: ${wf.updatedAt}`);
  if (wf.version !== undefined) {
    lines.push(`version: ${wf.version}`);
  }
  lines.push(`stepCount: ${wf.steps.length}`);
  if (pieces.length === 0) {
    lines.push("piecesUsed: []");
  } else {
    lines.push("piecesUsed:");
    for (const piece of pieces) {
      lines.push(`  - ${yamlScalar(piece)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

/** Renders the OKF markdown document for a single workflow. */
export function renderWorkflowDoc(wf: WorkflowRecord): string {
  const pieces = extractPiecesUsed(wf.steps);
  const sections: string[] = [];
  sections.push(workflowFrontmatter(wf, pieces));
  sections.push("");
  sections.push(`# ${wf.name}`);
  if (wf.description !== undefined && wf.description.length > 0) {
    sections.push("");
    sections.push(wf.description);
  }
  sections.push("");
  sections.push("## Steps");
  for (const step of wf.steps) {
    sections.push(stepSummary(step));
  }
  sections.push("");
  sections.push("## Definition");
  sections.push("```json");
  sections.push(JSON.stringify(wf.steps, null, 2));
  sections.push("```");
  sections.push("");
  return sections.join("\n");
}

function indexFrontmatter(): string {
  return ["---", "type: index", 'title: "Workflow registry"', "---"].join("\n");
}

/** Renders the registry index markdown listing every workflow. */
export function renderWorkflowIndex(workflows: WorkflowRecord[]): string {
  const lines: string[] = [];
  lines.push(indexFrontmatter());
  lines.push("");
  lines.push("# Workflow registry");
  lines.push("");
  lines.push(`Total workflows: ${workflows.length}`);
  lines.push("");
  lines.push("| Workflow | Pieces | Steps | Updated |");
  lines.push("| --- | --- | --- | --- |");
  for (const wf of workflows) {
    const pieces = extractPiecesUsed(wf.steps).join(", ");
    lines.push(`| [${wf.name}](/workflows/wf-${wf.id}.md) | ${pieces} | ${wf.steps.length} | ${wf.updatedAt} |`);
  }
  lines.push("");
  return lines.join("\n");
}