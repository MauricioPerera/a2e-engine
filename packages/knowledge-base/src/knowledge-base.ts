// knowledge-base.ts — lógica PURA de la base de conocimiento operacional OKF.
// Sin red, sin FS, sin git, sin reloj: `now` llega siempre como ISO string.

export type Attestation = {
  by: string;
  at: string;
  sha256: string;
  expiresAt: string;
};

export type KnowledgeEntry = {
  id: string;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  ttlDays: number;
  problem: string;
  resolution: string;
  sourceRunId?: string;
  attestation?: Attestation;
};

export type FreshnessStatus = {
  ageDays: number;
  ttlDays: number;
  expired: boolean;
  attested: boolean;
  attestationValid: boolean;
  verdict: 'fresh' | 'stale' | 'attested' | 'expired';
};

const MS_PER_DAY = 86_400_000;

// Devuelve el timestamp UTC (ms) de un ISO string. Determinista.
function toMs(iso: string): number {
  return Date.parse(iso);
}

// Suma `days` enteros a un ISO y devuelve ISO UTC. Determinista (no lee el reloj).
function addDaysIso(iso: string, days: number): string {
  return new Date(toMs(iso) + days * MS_PER_DAY).toISOString();
}

// 1. Días enteros (floor) entre dos ISO: (b - a).
export function daysBetween(aIso: string, bIso: string): number {
  return Math.floor((toMs(bIso) - toMs(aIso)) / MS_PER_DAY);
}

// 2. Estado de freshness de un entry respecto a `now`.
export function checkFreshness(
  entry: KnowledgeEntry,
  nowIso: string,
): FreshnessStatus {
  const ageDays = daysBetween(entry.updatedAt, nowIso);
  const expired = ageDays > entry.ttlDays;
  const attested = !!entry.attestation;
  const attestationValid =
    attested && toMs(nowIso) <= toMs(entry.attestation!.expiresAt);

  let verdict: FreshnessStatus['verdict'];
  if (attestationValid) verdict = 'attested';
  else if (!expired) verdict = 'fresh';
  else if (attested) verdict = 'expired';
  else verdict = 'stale';

  return { ageDays, ttlDays: entry.ttlDays, expired, attested, attestationValid, verdict };
}

// 3. Línea legible de vigencia humana.
export function attestationLine(att?: Attestation): string {
  if (!att) return '';
  return `attested by ${att.by} until ${att.expiresAt}`;
}

// 4. Bloque YAML de frontmatter de un entry.
function renderDocFrontmatter(entry: KnowledgeEntry, verdict: FreshnessStatus['verdict']): string {
  const expiresAt = addDaysIso(entry.updatedAt, entry.ttlDays);
  const lines: string[] = [
    '---',
    'type: knowledge',
    `id: ${entry.id}`,
    `title: ${entry.title}`,
    `tags: [${entry.tags.join(', ')}]`,
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
    `ttlDays: ${entry.ttlDays}`,
    `expiresAt: ${expiresAt}`,
  ];
  if (entry.sourceRunId !== undefined) lines.push(`sourceRunId: ${entry.sourceRunId}`);
  if (entry.attestation) {
    lines.push('attestation:');
    lines.push(`  by: ${entry.attestation.by}`);
    lines.push(`  at: ${entry.attestation.at}`);
    lines.push(`  sha256: ${entry.attestation.sha256}`);
    lines.push(`  expiresAt: ${entry.attestation.expiresAt}`);
  }
  lines.push(`freshness: ${verdict}`);
  lines.push('---');
  return lines.join('\n');
}

// 4. Cuerpo markdown de un entry.
function renderDocBody(entry: KnowledgeEntry, verdict: FreshnessStatus['verdict']): string {
  const att = attestationLine(entry.attestation);
  return [
    `# ${entry.title}`,
    '',
    '## Problem',
    entry.problem,
    '',
    '## Resolution',
    entry.resolution,
    '',
    '## Vigencia',
    att,
    `freshness: ${verdict}`,
  ].join('\n');
}

// 4. Documento completo (frontmatter + cuerpo) de un entry.
export function renderKnowledgeDoc(entry: KnowledgeEntry, nowIso: string): string {
  const { verdict } = checkFreshness(entry, nowIso);
  return renderDocFrontmatter(entry, verdict) + '\n\n' + renderDocBody(entry, verdict);
}

// 5. Fila de la tabla del índice para un entry.
function renderIndexRow(entry: KnowledgeEntry, verdict: FreshnessStatus['verdict']): string {
  return `| [${entry.title}](/knowledge/kb-${entry.id}.md) | ${entry.tags.join(', ')} | ${verdict} | ${entry.updatedAt} |`;
}

// 5. Índice de la base de conocimiento.
export function renderKnowledgeIndex(entries: KnowledgeEntry[], nowIso: string): string {
  const rows = entries.map((e) => renderIndexRow(e, checkFreshness(e, nowIso).verdict));
  const frontmatter = ['---', 'type: index', 'title: Knowledge base', '---'].join('\n');
  const body = [
    '# Knowledge base',
    '',
    '| Entry | Tags | Freshness | Updated |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
  return frontmatter + '\n\n' + body;
}

// 6. Ruta canónica del archivo de un entry.
export function knowledgeFilePath(entry: KnowledgeEntry): { dir: 'knowledge'; file: string } {
  return { dir: 'knowledge', file: `kb-${entry.id}.md` };
}