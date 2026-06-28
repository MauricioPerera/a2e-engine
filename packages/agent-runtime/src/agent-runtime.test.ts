import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson,
  parseAgentOutput,
  summarizeErrors,
  decideNext,
  buildRetryPrompt,
} from './agent-runtime.js';

// ---------- extractJson ----------
test('extractJson: extrae JSON de un bloque ```json', () => {
  const text = 'Here is the plan:\n```json\n{"steps":[{"a":1}]}\n```\n';
  const out = extractJson(text);
  assert.equal(out, '{"steps":[{"a":1}]}');
});

test('extractJson: extrae JSON embebido en prosa', () => {
  const text = 'El resultado es {"steps":[{"x":2,"y":"}"}]} y nada mas';
  const out = extractJson(text);
  assert.equal(out, '{"steps":[{"x":2,"y":"}"}]}');
});

test('extractJson: devuelve null si no hay JSON', () => {
  assert.equal(extractJson('no hay nada aqui'), null);
  assert.equal(extractJson('texto { sin cerrar'), null);
});

test('extractJson: devuelve null para llaves que no forman JSON valido', () => {
  // llaves balanceadas pero no JSON valido -> sigue buscando -> null
  assert.equal(extractJson('{ esto no es json }'), null);
});

// ---------- parseAgentOutput ----------
test('parseAgentOutput: ok con steps validos', () => {
  const r = parseAgentOutput('```json\n{"steps":[{"name":"a","x":1}]}\n```');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.request.steps.length, 1);
    assert.equal(r.request.steps[0].name, 'a');
  }
});

test('parseAgentOutput: falla con texto sin json', () => {
  const r = parseAgentOutput('solo prosa, sin nada');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'no JSON found');
});

test('parseAgentOutput: falla con json sin steps', () => {
  const r = parseAgentOutput('{"foo":1}');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'missing steps array');
});

test('parseAgentOutput: falla con steps vacio', () => {
  const r = parseAgentOutput('{"steps":[]}');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'missing steps array');
});

test('parseAgentOutput: falla si un step no es objeto', () => {
  const r = parseAgentOutput('{"steps":["no-obj"]}');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, 'steps must be objects');
});

// ---------- summarizeErrors ----------
test('summarizeErrors: formatea validation_failed', () => {
  const out = summarizeErrors({
    error: 'validation_failed',
    steps: [
      { name: 's1', errors: ['bad', 'worse'] },
      { name: 's2', errors: ['oops'] },
    ],
  });
  assert.equal(out, 'step s1: bad, worse; step s2: oops');
});

test('summarizeErrors: formatea FAILED con error', () => {
  const out = summarizeErrors({ status: 'FAILED', error: 'boom' });
  assert.equal(out, 'boom');
});

test('summarizeErrors: cadena vacia para otro status', () => {
  assert.equal(summarizeErrors({ status: 'SUCCEEDED' }), '');
  assert.equal(summarizeErrors({}), '');
});

// ---------- decideNext ----------
test('decideNext: SUCCEEDED -> done + success', () => {
  const d = decideNext({ status: 'SUCCEEDED' });
  assert.deepEqual(d, { done: true, success: true, feedback: '' });
});

test('decideNext: validation_failed -> reintento con feedback de errores', () => {
  const d = decideNext({
    error: 'validation_failed',
    steps: [{ name: 's1', errors: ['e1', 'e2'] }],
  });
  assert.equal(d.done, false);
  assert.equal(d.success, false);
  assert.equal(d.feedback, 'step s1: e1, e2');
});

test('decideNext: FAILED -> reintento con el error', () => {
  const d = decideNext({ status: 'FAILED', error: 'kaboom' });
  assert.equal(d.done, false);
  assert.equal(d.success, false);
  assert.equal(d.feedback, 'kaboom');
});

test('decideNext: desconocido -> unknown outcome', () => {
  const d = decideNext({ status: 'WEIRD' });
  assert.deepEqual(d, { done: false, success: false, feedback: 'unknown outcome' });
});

// ---------- buildRetryPrompt ----------
test('buildRetryPrompt: incluye tarea y feedback', () => {
  const p = buildRetryPrompt('Haz X', 'fallo tal');
  assert.ok(p.includes('Haz X'), 'debe incluir la tarea');
  assert.ok(p.includes('Tu intento anterior fallo: fallo tal'), 'debe incluir el feedback');
  assert.ok(p.includes('Corrige el ExecuteRequest'));
});