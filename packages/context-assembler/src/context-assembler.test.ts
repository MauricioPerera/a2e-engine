import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  estimateTokens,
  truncateToTokens,
  applyPerSlotBudget,
  assembleContext,
  applyRegexGuardrail,
} from './context-assembler.ts';

// ---------- estimateTokens ----------
test('estimateTokens: ceil(chars/4)', () => {
  assert.equal(estimateTokens('abcdefgh'), 2); // 8/4 = 2
  assert.equal(estimateTokens('abcde'), 2); // ceil(5/4) = 2
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('ab'), 1); // ceil(2/4) = 1
});

// ---------- truncateToTokens ----------
test('truncateToTokens: no recorta si cabe', () => {
  const r = truncateToTokens('hola', 10);
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'hola');
});

test('truncateToTokens: recorta a maxTokens*4 y añade sufijo', () => {
  const text = 'x'.repeat(100);
  const r = truncateToTokens(text, 5); // limit 20 chars
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 20 + ' …[truncated]'.length);
  assert.ok(r.text.endsWith(' …[truncated]'));
  assert.ok(r.text.length < text.length);
});

test('truncateToTokens: límite exacto no trunca', () => {
  const r = truncateToTokens('x'.repeat(20), 5); // 20 chars == limit
  assert.equal(r.truncated, false);
  assert.equal(r.text.length, 20);
});

// ---------- applyPerSlotBudget ----------
test('applyPerSlotBudget: none NO recorta aunque exceda maxTokens', () => {
  const slot = {
    id: 'crit',
    priority: 0,
    content: 'x'.repeat(100),
    maxTokens: 5,
    compaction: 'none' as const,
  };
  const r = applyPerSlotBudget(slot);
  assert.equal(r.truncated, false);
  assert.equal(r.content, slot.content);
  assert.equal(r.tokens, estimateTokens(slot.content)); // 25
});

test('applyPerSlotBudget: truncate recorta al maxTokens', () => {
  const slot = {
    id: 'soft',
    priority: 0,
    content: 'x'.repeat(100),
    maxTokens: 5,
    compaction: 'truncate' as const,
  };
  const r = applyPerSlotBudget(slot);
  assert.equal(r.truncated, true);
  assert.ok(r.content.endsWith(' …[truncated]'));
  assert.ok(r.content.length < slot.content.length);
  assert.equal(r.tokens, estimateTokens(r.content));
});

test('applyPerSlotBudget: summarize == truncate determinista en MVP', () => {
  const slot = {
    id: 'sum',
    priority: 0,
    content: 'y'.repeat(80),
    maxTokens: 4,
    compaction: 'summarize' as const,
  };
  const r = applyPerSlotBudget(slot);
  assert.equal(r.truncated, true);
  assert.ok(r.content.endsWith(' …[truncated]'));
});

test('applyPerSlotBudget: sin maxTokens no toca el content', () => {
  const slot = {
    id: 'free',
    priority: 0,
    content: 'hello world',
    compaction: 'truncate' as const,
  };
  const r = applyPerSlotBudget(slot);
  assert.equal(r.truncated, false);
  assert.equal(r.content, 'hello world');
  assert.equal(r.tokens, estimateTokens('hello world'));
});

// ---------- assembleContext ----------
test('assembleContext: incluye por prioridad y DROPa los de menor prioridad', () => {
  const slots = [
    { id: 'C', priority: 2, content: 'z'.repeat(80), compaction: 'truncate' as const },
    { id: 'A', priority: 0, content: 'a'.repeat(160), compaction: 'none' as const }, // 40 tokens
    { id: 'B', priority: 1, content: 'b'.repeat(80), compaction: 'truncate' as const }, // 20 tokens
  ];
  // budget 40: A llena exacto (40 tokens), B no cabe (remaining 0) -> drop, C drop.
  const asm = assembleContext(slots, { totalBudget: 40 });
  assert.deepEqual(asm.dropped.sort(), ['B', 'C']);
  const included = asm.slots.filter((s) => s.included).map((s) => s.id);
  assert.deepEqual(included, ['A']);
  assert.equal(asm.withinBudget, true);
  assert.equal(asm.budget, 40);
});

test('assembleContext: slot crítico none que excede -> incluido, withinBudget=false', () => {
  const slots = [
    { id: 'crit', priority: 0, content: 'x'.repeat(400), compaction: 'none' as const }, // 100 tokens
  ];
  const asm = assembleContext(slots, { totalBudget: 10 });
  const r = asm.slots[0]!;
  assert.equal(r.included, true);
  assert.equal(r.truncated, false);
  assert.equal(asm.totalTokens, 100);
  assert.equal(asm.withinBudget, false); // 100 > 10
  assert.deepEqual(asm.dropped, []);
});

test('assembleContext: respeta orden de prioridad en context con cabeceras ## <id>', () => {
  const slots = [
    { id: 'low', priority: 5, content: 'low-content', compaction: 'none' as const },
    { id: 'high', priority: 0, content: 'high-content', compaction: 'none' as const },
    { id: 'mid', priority: 3, content: 'mid-content', compaction: 'none' as const },
  ];
  const asm = assembleContext(slots, { totalBudget: 1000 });
  // orden por prioridad: high, mid, low
  const highIdx = asm.context.indexOf('## high\n');
  const midIdx = asm.context.indexOf('## mid\n');
  const lowIdx = asm.context.indexOf('## low\n');
  assert.ok(highIdx !== -1 && midIdx !== -1 && lowIdx !== -1);
  assert.ok(highIdx < midIdx);
  assert.ok(midIdx < lowIdx);
  // separados por línea en blanco
  assert.ok(asm.context.includes('high-content\n\n## mid'));
});

test('assembleContext: reserveOutput reduce el presupuesto disponible', () => {
  const slots = [
    { id: 'a', priority: 0, content: 'a'.repeat(160), compaction: 'none' as const }, // 40 tok
  ];
  const asm = assembleContext(slots, { totalBudget: 50, reserveOutput: 20 });
  assert.equal(asm.budget, 30); // 50 - 20
  assert.equal(asm.withinBudget, false); // 40 > 30
  assert.equal(asm.slots[0]!.included, true); // crítico, incluido igual
});

test('assembleContext: compaction truncate trunca al espacio restante en vez de dropear', () => {
  const slots = [
    { id: 'a', priority: 0, content: 'a'.repeat(160), compaction: 'none' as const }, // 40 tok
    { id: 'b', priority: 1, content: 'b'.repeat(160), compaction: 'truncate' as const }, // 40 tok
  ];
  const asm = assembleContext(slots, { totalBudget: 50 });
  // a (none) llena 40, remaining 10; b truncate -> trunca a 10 tokens en vez de drop.
  const bRes = asm.slots.find((s) => s.id === 'b')!;
  assert.equal(bRes.included, true);
  assert.equal(bRes.truncated, true);
  assert.deepEqual(asm.dropped, []);
  assert.ok(bRes.tokens <= 10 + 5); // ~10 + sufijo
});

// ---------- applyRegexGuardrail ----------
test('applyRegexGuardrail: detecta patrón tipo sk-[A-Za-z0-9]{20,} (matched, ok=false)', () => {
  const r = applyRegexGuardrail('mi clave es sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234', 'sk-[A-Za-z0-9]{20,}');
  assert.equal(r.matched, true);
  assert.equal(r.ok, false);
});

test('applyRegexGuardrail: texto limpio pasa (ok=true, matched=false)', () => {
  const r = applyRegexGuardrail('esto es un texto sin secretos', 'sk-[A-Za-z0-9]{20,}');
  assert.equal(r.matched, false);
  assert.equal(r.ok, true);
});