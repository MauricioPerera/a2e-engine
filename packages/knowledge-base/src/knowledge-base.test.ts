import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  daysBetween,
  checkFreshness,
  attestationLine,
  renderKnowledgeDoc,
  renderKnowledgeIndex,
  knowledgeFilePath,
  type KnowledgeEntry,
  type Attestation,
} from './knowledge-base.js';

const UPDATED = '2024-01-01T00:00:00Z';
const TTL = 30; // vence después del 2024-01-31

function baseEntry(over: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: 'kb-001',
    title: 'Cómo reiniciar el servicio X',
    tags: ['ops', 'servicio-x'],
    createdAt: '2023-12-01T00:00:00Z',
    updatedAt: UPDATED,
    ttlDays: TTL,
    problem: 'El servicio X no responde tras un deploy.',
    resolution: 'Reiniciar el nodo y limpiar la caché.',
    ...over,
  };
}

function attestation(over: Partial<Attestation> = {}): Attestation {
  return {
    by: 'mp',
    at: '2024-01-05T00:00:00Z',
    sha256: 'abc123',
    expiresAt: '2024-12-31T00:00:00Z',
    ...over,
  };
}

test('daysBetween: diferencia entera con floor (positiva)', () => {
  // 10 días y medio -> floor 10
  assert.equal(daysBetween('2024-01-01T00:00:00Z', '2024-01-11T12:00:00Z'), 10);
});

test('daysBetween: diferencia negativa cuando b < a', () => {
  assert.equal(daysBetween('2024-01-11T00:00:00Z', '2024-01-01T00:00:00Z'), -10);
});

test('daysBetween: mismo día -> 0', () => {
  assert.equal(daysBetween(UPDATED, UPDATED), 0);
});

test('checkFreshness: entry reciente -> fresh', () => {
  const s = checkFreshness(baseEntry(), '2024-01-10T00:00:00Z');
  assert.equal(s.ageDays, 9);
  assert.equal(s.expired, false);
  assert.equal(s.attested, false);
  assert.equal(s.verdict, 'fresh');
});

test('checkFreshness: entry vencido por TTL sin attestation -> stale', () => {
  const s = checkFreshness(baseEntry(), '2024-03-01T00:00:00Z');
  assert.equal(s.ageDays, 60);
  assert.equal(s.expired, true);
  assert.equal(s.attested, false);
  assert.equal(s.attestationValid, false);
  assert.equal(s.verdict, 'stale');
});

test('checkFreshness: vencido por TTL pero attestation válida -> attested (rescata)', () => {
  const e = baseEntry({ attestation: attestation({ expiresAt: '2024-12-31T00:00:00Z' }) });
  const s = checkFreshness(e, '2024-03-01T00:00:00Z');
  assert.equal(s.expired, true);
  assert.equal(s.attested, true);
  assert.equal(s.attestationValid, true);
  assert.equal(s.verdict, 'attested');
});

test('checkFreshness: attestation expirada y TTL vencido -> expired', () => {
  const e = baseEntry({ attestation: attestation({ expiresAt: '2024-02-01T00:00:00Z' }) });
  const s = checkFreshness(e, '2024-03-01T00:00:00Z');
  assert.equal(s.expired, true);
  assert.equal(s.attested, true);
  assert.equal(s.attestationValid, false);
  assert.equal(s.verdict, 'expired');
});

test('checkFreshness: attestation válida rescata incluso en el límite (now == expiresAt)', () => {
  const e = baseEntry({ attestation: attestation({ expiresAt: '2024-03-01T00:00:00Z' }) });
  const s = checkFreshness(e, '2024-03-01T00:00:00Z');
  assert.equal(s.attestationValid, true);
  assert.equal(s.verdict, 'attested');
});

test('attestationLine: vacío si no hay attestation', () => {
  assert.equal(attestationLine(undefined), '');
});

test('attestationLine: texto legible si hay attestation', () => {
  assert.equal(
    attestationLine(attestation()),
    'attested by mp until 2024-12-31T00:00:00Z',
  );
});

test('renderKnowledgeDoc: frontmatter con type:knowledge, expiresAt calculado y freshness', () => {
  const doc = renderKnowledgeDoc(baseEntry(), '2024-01-10T00:00:00Z');
  assert.ok(doc.includes('type: knowledge'));
  // updatedAt(2024-01-01) + 30 días = 2024-01-31
  assert.ok(doc.includes('expiresAt: 2024-01-31T00:00:00.000Z'));
  assert.ok(doc.includes('freshness: fresh'));
  assert.ok(doc.includes('ttlDays: 30'));
  assert.ok(doc.includes('id: kb-001'));
  assert.ok(doc.includes('# Cómo reiniciar el servicio X'));
  assert.ok(doc.includes('## Problem'));
  assert.ok(doc.includes('## Resolution'));
  assert.ok(doc.includes('## Vigencia'));
  assert.ok(doc.includes('tags: [ops, servicio-x]'));
});

test('renderKnowledgeDoc: incluye sourceRunId y attestation cuando existen', () => {
  const doc = renderKnowledgeDoc(
    baseEntry({ sourceRunId: 'run-42', attestation: attestation() }),
    '2024-03-01T00:00:00Z',
  );
  assert.ok(doc.includes('sourceRunId: run-42'));
  assert.ok(doc.includes('  by: mp'));
  assert.ok(doc.includes('  sha256: abc123'));
  assert.ok(doc.includes('freshness: attested'));
});

test('renderKnowledgeIndex: tabla con N entries y su freshness', () => {
  const entries = [
    baseEntry({ id: '001', title: 'A' }),
    baseEntry({ id: '002', title: 'B', updatedAt: '2024-03-01T00:00:00Z' }),
  ];
  const idx = renderKnowledgeIndex(entries, '2024-01-10T00:00:00Z');
  assert.ok(idx.includes('type: index'));
  assert.ok(idx.includes('title: Knowledge base'));
  assert.ok(idx.includes('# Knowledge base'));
  assert.ok(idx.includes('| Entry | Tags | Freshness | Updated |'));
  // una fila fresca (kb-001) y una stale (kb-002, updatedAt futuro -> ageDays negativo -> no expired -> fresh!)
  // NOTA: updatedAt futura => ageDays < 0 => expired=false => 'fresh'. Validamos que aparece.
  const dataRows = idx.split('\n').filter((l) => l.startsWith('| ['));
  assert.equal(dataRows.length, 2);
  assert.ok(idx.includes('/knowledge/kb-001.md'));
  assert.ok(idx.includes('/knowledge/kb-002.md'));
  assert.ok(idx.includes('fresh'));
});

test('renderKnowledgeIndex: entry vencido sin attestation aparece como stale', () => {
  const e = baseEntry({ id: 'kb-003' });
  const idx = renderKnowledgeIndex([e], '2024-03-01T00:00:00Z');
  assert.ok(idx.includes('| stale |'));
});

test('knowledgeFilePath: dir knowledge y file kb-<id>.md', () => {
  const p = knowledgeFilePath(baseEntry({ id: 'kb-99' }));
  assert.equal(p.dir, 'knowledge');
  assert.equal(p.file, 'kb-kb-99.md');
});