/**
 * Frozen property-tests for Vault (independent oracle).
 *
 * Oraculo: los secretos esperados son literales en el test; no se derivan ni reutilizan
 * la logica del vault. Los valores esperados de round-trip se construyen literalmente.
 *
 * Inspecciona el almacen cifrado via `(vault as unknown as {...}).records` (TS `private`
 * es accesible en runtime) para afirmar que el ciphertext NO contiene el secreto en claro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from './vault.ts';

const KEY = 'master-key-0123456789'; // 21 chars >= 16

function lastAudit(v: Vault) {
  return v.audit[v.audit.length - 1];
}

test('constructor acepta masterKey >= 16 chars', () => {
  assert.doesNotThrow(() => new Vault('k'.repeat(16)));
});

test('constructor lanza si masterKey < 16 chars', () => {
  assert.throws(() => new Vault('short'), /master key/i);
});

test('constructor lanza si masterKey vacio', () => {
  assert.throws(() => new Vault(''), /master key/i);
});

test('round-trip SECRET_TEXT', () => {
  const v = new Vault(KEY);
  v.put({ externalId: 'c1', projectId: 'p1', pieceName: 'slack', displayName: 'Slack', value: { type: 'SECRET_TEXT', secret_text: 'hunter2' } });
  const got = v.obtain('p1', 'c1');
  assert.notEqual(got, null);
  assert.equal(got!.externalId, 'c1');
  assert.equal(got!.type, 'SECRET_TEXT');
  assert.equal(got!.pieceName, 'slack');
  assert.equal(got!.displayName, 'Slack');
  assert.deepEqual(got!.projectIds, ['p1']);
  assert.equal(got!.status, 'ACTIVE');
  assert.deepEqual(got!.value, { type: 'SECRET_TEXT', secret_text: 'hunter2' });
});

test('round-trip BASIC_AUTH', () => {
  const v = new Vault(KEY);
  v.put({ externalId: 'c2', projectId: 'p1', pieceName: 'http', displayName: 'HTTP', value: { type: 'BASIC_AUTH', username: 'alice', password: 'pass123' } });
  assert.deepEqual(v.obtain('p1', 'c2')!.value, { type: 'BASIC_AUTH', username: 'alice', password: 'pass123' });
});

test('round-trip CUSTOM_AUTH', () => {
  const v = new Vault(KEY);
  const props = { token: 'tok-xyz', nested: { a: [1, 2, { b: true }] } };
  v.put({ externalId: 'c3', projectId: 'p1', pieceName: 'custom', displayName: 'Custom', value: { type: 'CUSTOM_AUTH', props } });
  assert.deepEqual(v.obtain('p1', 'c3')!.value, { type: 'CUSTOM_AUTH', props: { token: 'tok-xyz', nested: { a: [1, 2, { b: true }] } } });
});

test('round-trip NO_AUTH', () => {
  const v = new Vault(KEY);
  v.put({ externalId: 'c4', projectId: 'p1', pieceName: 'none', displayName: 'None', value: { type: 'NO_AUTH' } });
  assert.deepEqual(v.obtain('p1', 'c4')!.value, { type: 'NO_AUTH' });
});

test('aislamiento por projectId: obtain de otro projectId => null', () => {
  const v = new Vault(KEY);
  v.put({ externalId: 'c1', projectId: 'p1', pieceName: 'slack', displayName: 'Slack', value: { type: 'SECRET_TEXT', secret_text: 'hunter2' } });
  assert.equal(v.obtain('p2', 'c1'), null);
});

test('obtain de inexistente => null y deja audit ok:false', () => {
  const v = new Vault(KEY);
  assert.equal(v.obtain('p1', 'missing'), null);
  const a = lastAudit(v);
  assert.equal(a.ok, false);
  assert.equal(a.externalId, 'missing');
  assert.equal(a.projectId, 'p1');
});

test('obtain existente deja audit ok:true', () => {
  const v = new Vault(KEY);
  v.put({ externalId: 'c1', projectId: 'p1', pieceName: 'slack', displayName: 'Slack', value: { type: 'SECRET_TEXT', secret_text: 'hunter2' } });
  v.obtain('p1', 'c1');
  const a = lastAudit(v);
  assert.equal(a.ok, true);
  assert.equal(a.externalId, 'c1');
  assert.equal(a.projectId, 'p1');
});

test('aislamiento: obtain de otro projectId deja audit ok:false con ese projectId', () => {
  const v = new Vault(KEY);
  v.put({ externalId: 'c1', projectId: 'p1', pieceName: 'slack', displayName: 'Slack', value: { type: 'SECRET_TEXT', secret_text: 'hunter2' } });
  v.obtain('p2', 'c1');
  const a = lastAudit(v);
  assert.equal(a.ok, false);
  assert.equal(a.projectId, 'p2');
});

test('listReferences NO expone el secreto', () => {
  const v = new Vault(KEY);
  v.put({ externalId: 'c1', projectId: 'p1', pieceName: 'slack', displayName: 'Slack', value: { type: 'SECRET_TEXT', secret_text: 'hunter2' } });
  v.put({ externalId: 'c2', projectId: 'p1', pieceName: 'http', displayName: 'HTTP', value: { type: 'BASIC_AUTH', username: 'alice', password: 'pass123' } });
  v.put({ externalId: 'c3', projectId: 'p2', pieceName: 'other', displayName: 'Other', value: { type: 'SECRET_TEXT', secret_text: 'other-secret' } });
  const refs = v.listReferences('p1');
  assert.equal(refs.length, 2);
  for (const r of refs) {
    assert.ok('externalId' in r && 'displayName' in r && 'pieceName' in r && 'type' in r);
  }
  const serialized = JSON.stringify(refs);
  assert.ok(!serialized.includes('hunter2'), 'listReferences filtra secret_text');
  assert.ok(!serialized.includes('pass123'), 'listReferences filtra password');
  assert.ok(!serialized.includes('other-secret'), 'listReferences respeta scoping por projectId');
});

test('el ciphertext almacenado NO contiene el secreto en claro', () => {
  const v = new Vault(KEY);
  v.put({ externalId: 'c1', projectId: 'p1', pieceName: 'slack', displayName: 'Slack', value: { type: 'SECRET_TEXT', secret_text: 'hunter2' } });
  v.put({ externalId: 'c2', projectId: 'p1', pieceName: 'http', displayName: 'HTTP', value: { type: 'BASIC_AUTH', username: 'alice', password: 'pass123' } });
  const records = (v as unknown as { records: Map<string, { ciphertext: string }> }).records;
  for (const rec of records.values()) {
    assert.ok(!rec.ciphertext.includes('hunter2'), 'ciphertext no contiene secret_text');
    assert.ok(!rec.ciphertext.includes('pass123'), 'ciphertext no contiene password');
    assert.ok(!rec.ciphertext.includes('alice'), 'ciphertext no contiene username');
  }
});

test('IV aleatorio: dos put del mismo value producen ciphertext distinto', () => {
  const v = new Vault(KEY);
  v.put({ externalId: 'a', projectId: 'p1', pieceName: 'x', displayName: 'X', value: { type: 'NO_AUTH' } });
  v.put({ externalId: 'b', projectId: 'p1', pieceName: 'x', displayName: 'X', value: { type: 'NO_AUTH' } });
  const records = (v as unknown as { records: Map<string, { ciphertext: string }> }).records;
  assert.notEqual(records.get('p1::a')!.ciphertext, records.get('p1::b')!.ciphertext);
});