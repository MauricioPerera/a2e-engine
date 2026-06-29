export type StepRecord = {
  name: string;
  status: string;
  output?: unknown;
  error?: { name?: string; message?: string; stack?: string };
};

export type FlowRun = {
  runId: string;
  source: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepRecord[];
  workflowId?: string;
  failedStep?: string;
  error?: { name?: string; message?: string; stack?: string };
};

export function redactValue(value: unknown, maxLen = 2000): string {
  let s: string;
  if (value === undefined) {
    s = 'undefined';
  } else if (typeof value === 'string') {
    s = value;
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  if (s.length > maxLen) {
    const kept = s.slice(0, maxLen);
    const truncated = s.length - maxLen;
    return `${kept} ... [truncated ${truncated} chars]`;
  }
  return s;
}

export function runFilePath(run: FlowRun): { dir: string; file: string } {
  const date = run.startedAt.slice(0, 10);
  return { dir: `runs/${date}`, file: `run-${run.runId}.md` };
}

export function escapeYaml(s: string): string {
  if (s == null) return 'null';
  const needsQuote = /[:#\{\}\[\]&*!|>'"%@,\n\r]/.test(s) || /^\s|\s$/.test(s);
  if (!needsQuote) return s;
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

export function formatErrorLine(err?: { name?: string; message?: string }): string {
  if (!err) return '';
  const name = err.name ?? '';
  const msg = err.message ?? '';
  if (name && msg) return `${name}: ${msg}`;
  if (name) return name;
  return msg;
}

export function renderFrontmatter(run: FlowRun): string {
  const lines: string[] = [
    'type: run',
    `runId: ${escapeYaml(run.runId)}`,
    `source: ${escapeYaml(run.source)}`,
    `status: ${escapeYaml(run.status)}`,
    `startedAt: ${escapeYaml(run.startedAt)}`,
    `finishedAt: ${escapeYaml(run.finishedAt)}`,
    `durationMs: ${run.durationMs}`,
  ];
  if (run.workflowId !== undefined) {
    lines.push(`workflowId: ${escapeYaml(run.workflowId)}`);
  }
  if (run.status !== 'SUCCEEDED') {
    if (run.failedStep !== undefined) {
      lines.push(`failedStep: ${escapeYaml(run.failedStep)}`);
    }
    lines.push(`error: ${escapeYaml(formatErrorLine(run.error))}`);
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

export function renderStepItem(step: StepRecord): string {
  const lines: string[] = [`- ${step.name} — ${step.status}`];
  if (step.output !== undefined) {
    lines.push(`  output: ${redactValue(step.output)}`);
  }
  if (step.error) {
    const line = formatErrorLine(step.error);
    if (line) lines.push(`  error: ${line}`);
    if (step.error.stack) lines.push(`  stack: ${step.error.stack}`);
  }
  return lines.join('\n');
}

export function renderStepsSection(run: FlowRun): string {
  const items = run.steps.map(renderStepItem).join('\n');
  return `## Steps\n${items}`;
}

export function renderErrorSection(err: { name?: string; message?: string; stack?: string }): string {
  const line = formatErrorLine(err);
  const parts: string[] = ['## Error', '', line];
  if (err.stack) {
    parts.push('', '```', err.stack, '```');
  }
  return parts.join('\n');
}

export function renderRunDoc(run: FlowRun): string {
  const parts: string[] = [
    renderFrontmatter(run),
    `# Run ${run.runId} — ${run.status}`,
    '',
    renderStepsSection(run),
  ];
  if (run.status !== 'SUCCEEDED') {
    parts.push('', renderErrorSection(run.error ?? {}));
  }
  return parts.join('\n') + '\n';
}

export function renderIndexRow(run: FlowRun, date: string): string {
  const link = `[${run.runId}](/runs/${date}/run-${run.runId}.md)`;
  const failed = run.failedStep ?? '-';
  return `| ${link} | ${run.status} | ${run.durationMs} | ${failed} |`;
}

export function renderDayIndex(date: string, runs: FlowRun[]): string {
  const fm = `---\ntype: index\ndate: ${escapeYaml(date)}\n---\n`;
  const header = '| Run | Status | Duration (ms) | Failed step |';
  const sep = '| --- | --- | --- | --- |';
  const rows = runs.map((r) => renderIndexRow(r, date));
  const parts: string[] = [fm, `# Runs ${date}`, '', header, sep, ...rows];
  return parts.join('\n') + '\n';
}