/**
 * Frozen property-tests for MemoryStore (independent oracle).
 *
 * Oráculo: los valores esperados se construyen literalmente en el test;
 * no se derivan ni reutilizan la lógica del store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './store.ts';

test('put+get round-trip con objeto', () => {
  const s = new MemoryStore();
  assert.deepEqual(s.put('a', { x: 1 }), { key: 'a', value: { x: 1 } });
  assert.deepEqual(s.get('a'), { key: 'a', value: { x: 1 } });
});

test('get de key inexistente devuelve null', () => {
  assert.equal(new MemoryStore().get('missing'), null);
});

test('put reemplaza el valor previo', () => {
  const s = new MemoryStore();
  s.put('a', 1);
  s.put('a', 2);
  assert.deepEqual(s.get('a'), { key: 'a', value: 2 });
});

test('delete elimina la entrada', () => {
  const s = new MemoryStore();
  s.put('a', 1);
  s.delete('a');
  assert.equal(s.get('a'), null);
});

test('delete es idempotente (no lanza si no existe)', () => {
  assert.doesNotThrow(() => new MemoryStore().delete('never'));
});

test('value admite tipos variados (objeto, array, string, number, null)', () => {
  const s = new MemoryStore();
  s.put('obj', { a: [1, 2], b: true });
  assert.deepEqual(s.get('obj'), { key: 'obj', value: { a: [1, 2], b: true } });
  s.put('arr', [1, 'x', null]);
  assert.deepEqual(s.get('arr'), { key: 'arr', value: [1, 'x', null] });
  s.put('str', 'hello');
  assert.deepEqual(s.get('str'), { key: 'str', value: 'hello' });
  s.put('num', 42);
  assert.deepEqual(s.get('num'), { key: 'num', value: 42 });
  s.put('nul', null);
  assert.deepEqual(s.get('nul'), { key: 'nul', value: null });
});