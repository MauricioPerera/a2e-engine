import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { redactValue } from './run-logger.js';

test('undefined', () => assert.equal(redactValue(undefined), 'undefined'));
test('string', () => assert.equal(redactValue('hola'), 'hola'));
test('object', () => assert.equal(redactValue({ a: 1 }), '{"a":1}'));
test('truncate', () => {
  const o = redactValue('x'.repeat(5000), 100);
  assert.match(o, /\.\.\. \[truncated \d+ chars\]/);
  assert.ok(o.length < 5000);
});
test('circular', () => {
  const o: any = { n: 'c' };
  o.self = o;
  const r = redactValue(o);
  assert.equal(typeof r, 'string');
  assert.match(r, /unserializable|circular/i);
});