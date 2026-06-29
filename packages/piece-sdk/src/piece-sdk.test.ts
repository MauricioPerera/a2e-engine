import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMetadata,
  extractCodeFacts,
  reconcileCapabilities,
  validatePiece,
} from './piece-sdk.ts';
import type { PieceMetaLike, CapabilityManifest } from './piece-sdk.ts';

const cleanMeta: PieceMetaLike = {
  name: 'send-grid',
  displayName: 'SendGrid',
  description: 'Send transactional email via SendGrid',
  actions: [{ name: 'send_email', displayName: 'Send Email', description: 'Sends an email' }],
};

function codesAt(level: 'error' | 'warn', findings: { level: string; code: string }[]): string[] {
  return findings.filter((f) => f.level === level).map((f) => f.code);
}

test('validateMetadata: missing displayName', () => {
  const meta: PieceMetaLike = { ...cleanMeta, displayName: undefined };
  assert.ok(codesAt('error', validateMetadata(meta)).includes('missing-displayName'));
});

test('validateMetadata: short description', () => {
  const meta: PieceMetaLike = { ...cleanMeta, description: 'short' };
  assert.ok(codesAt('warn', validateMetadata(meta)).includes('short-description'));
  const meta2: PieceMetaLike = { ...cleanMeta, description: undefined };
  assert.ok(codesAt('warn', validateMetadata(meta2)).includes('short-description'));
});

test('validateMetadata: invalid piece name', () => {
  const meta: PieceMetaLike = { ...cleanMeta, name: 'Bad Name!' };
  assert.ok(codesAt('error', validateMetadata(meta)).includes('invalid-piece-name'));
});

test('validateMetadata: no actions', () => {
  const meta: PieceMetaLike = { ...cleanMeta, actions: [] };
  assert.ok(codesAt('error', validateMetadata(meta)).includes('no-actions'));
});

test('validateMetadata: action missing description -> warn when displayName present', () => {
  const meta: PieceMetaLike = {
    ...cleanMeta,
    actions: [{ name: 'do_thing', displayName: 'Do Thing' }],
  };
  const f = validateMetadata(meta);
  assert.ok(codesAt('warn', f).includes('action-missing-description'));
  assert.ok(!codesAt('error', f).includes('action-missing-description'));
});

test('validateMetadata: action missing description AND displayName -> warn', () => {
  const meta: PieceMetaLike = {
    ...cleanMeta,
    actions: [{ name: 'do_thing' }],
  };
  const f = validateMetadata(meta);
  assert.ok(codesAt('warn', f).includes('action-missing-description'));
});

test('validateMetadata: invalid action name', () => {
  const meta: PieceMetaLike = {
    ...cleanMeta,
    actions: [{ name: 'bad name!', displayName: 'X', description: 'A description here' }],
  };
  assert.ok(codesAt('error', validateMetadata(meta)).includes('invalid-action-name'));
});
test('validateMetadata: action name with hyphen is valid', () => {
  const meta: PieceMetaLike = {
    ...cleanMeta,
    actions: [{ name: 'find-user-by-id', displayName: 'Find User', description: 'Find a user by id' }],
  };
  assert.deepEqual(validateMetadata(meta), []);
});

test('validateMetadata: clean piece returns []', () => {
  assert.deepEqual(validateMetadata(cleanMeta), []);
});

test('extractCodeFacts: extracts http(s) hosts, dedupes, ignores localhost', () => {
  const src = `
    await fetch('https://api.sendgrid.com/v3/mail/send');
    await fetch('https://api.sendgrid.com/other');
    await fetch('http://example.com/path');
    await fetch('https://localhost:8080/x');
    await fetch('https://127.0.0.1/y');
  `;
  const facts = extractCodeFacts(src);
  assert.deepEqual(facts.egressDomains.sort(), ['api.sendgrid.com', 'example.com']);
});

test('extractCodeFacts: detects process.env', () => {
  assert.equal(extractCodeFacts('const k = process.env.KEY;').readsEnv, true);
  assert.equal(extractCodeFacts('const k = process_env;').readsEnv, false);
});

test('extractCodeFacts: detects fs usage', () => {
  assert.equal(extractCodeFacts("import fs from 'fs'; fs.readFileSync('x');").readsFiles, true);
  assert.equal(extractCodeFacts('await readFile("x");').readsFiles, true);
  assert.equal(extractCodeFacts('await writeFile("x", "y");').readsFiles, true);
  assert.equal(extractCodeFacts('const x = 1;').readsFiles, false);
});

test('extractCodeFacts: detects code execution', () => {
  assert.equal(extractCodeFacts('eval("1+1");').executesCode, true);
  assert.equal(extractCodeFacts('new Function("x", "return x");').executesCode, true);
  assert.equal(extractCodeFacts('import { execSync } from "child_process";').executesCode, true);
  assert.equal(extractCodeFacts('spawn("ls");').executesCode, true);
  assert.equal(extractCodeFacts('const x = 1;').executesCode, false);
});

test('extractCodeFacts: clean code -> all false, no hosts', () => {
  const facts = extractCodeFacts('const x = 1;\nreturn x + 2;');
  assert.deepEqual(facts, { egressDomains: [], readsEnv: false, readsFiles: false, executesCode: false });
});

test('reconcileCapabilities: no manifest -> warn no-manifest', () => {
  const facts = extractCodeFacts('const x = 1;');
  const f = reconcileCapabilities(undefined, facts);
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'no-manifest');
  assert.equal(f[0].level, 'warn');
});

test('reconcileCapabilities: undeclared egress -> finding per host', () => {
  const facts = extractCodeFacts("fetch('https://api.sendgrid.com/x'); fetch('https://evil.com/y');");
  const manifest: CapabilityManifest = { network: { egress: ['api.sendgrid.com'] } };
  const f = reconcileCapabilities(manifest, facts);
  const egress = f.filter((x) => x.code === 'undeclared-egress');
  assert.equal(egress.length, 1);
  assert.equal(egress[0].message, 'code egresses to undeclared host: evil.com');
});

test('reconcileCapabilities: declared egress -> no finding', () => {
  const facts = extractCodeFacts("fetch('https://api.sendgrid.com/x');");
  const manifest: CapabilityManifest = { network: { egress: ['api.sendgrid.com'] } };
  const f = reconcileCapabilities(manifest, facts);
  assert.equal(f.filter((x) => x.code === 'undeclared-egress').length, 0);
});

test('reconcileCapabilities: undeclared env read -> warn', () => {
  const facts = extractCodeFacts('process.env.X;');
  const manifest: CapabilityManifest = { readsEnv: false };
  assert.ok(reconcileCapabilities(manifest, facts).some((x) => x.code === 'undeclared-env-read' && x.level === 'warn'));
});

test('reconcileCapabilities: declared env read -> no finding', () => {
  const facts = extractCodeFacts('process.env.X;');
  const manifest: CapabilityManifest = { readsEnv: true };
  assert.equal(reconcileCapabilities(manifest, facts).length, 0);
});

test('reconcileCapabilities: undeclared file read -> warn', () => {
  const facts = extractCodeFacts('readFile("x");');
  const manifest: CapabilityManifest = { readsFiles: false };
  assert.ok(reconcileCapabilities(manifest, facts).some((x) => x.code === 'undeclared-file-read' && x.level === 'warn'));
});

test('reconcileCapabilities: executesCode DECLARED -> warn (not error), ok not blocked', () => {
  const facts = extractCodeFacts('eval("x");');
  const declared: CapabilityManifest = { executesCode: true, network: { egress: [] } };
  const f = reconcileCapabilities(declared, facts);
  const exec = f.find((x) => x.code === 'executes-code');
  assert.ok(exec);
  assert.equal(exec!.level, 'warn');
  assert.equal(f.some((x) => x.level === 'error'), false);
});

test('reconcileCapabilities: executesCode WITHOUT manifest -> error undeclared-executes-code', () => {
  const facts = extractCodeFacts('eval("x");');
  const f = reconcileCapabilities(undefined, facts);
  // no-manifest warn + undeclared-executes-code error
  assert.ok(f.some((x) => x.code === 'no-manifest' && x.level === 'warn'));
  assert.ok(f.some((x) => x.code === 'undeclared-executes-code' && x.level === 'error'));
});

test('validatePiece: child_process + declares executes-code -> ok=true with warn executes-code', () => {
  const src = 'const { execFile } = require("node:child_process");';
  const manifest: CapabilityManifest = { executesCode: true, network: { egress: [] } };
  const r = validatePiece(cleanMeta, src, manifest);
  assert.equal(r.ok, true);
  assert.ok(r.findings.some((x) => x.code === 'executes-code' && x.level === 'warn'));
  assert.equal(r.findings.some((x) => x.level === 'error'), false);
  assert.equal(r.facts!.executesCode, true);
});

test('validatePiece: child_process WITHOUT declaring -> ok=false with error undeclared-executes-code', () => {
  const src = 'const { execFile } = require("node:child_process");';
  const r = validatePiece(cleanMeta, src);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((x) => x.code === 'undeclared-executes-code' && x.level === 'error'));
  assert.equal(r.facts!.executesCode, true);
});

test('validatePiece: clean piece with correct manifest -> ok=true', () => {
  const src = "await fetch('https://api.sendgrid.com/v3/mail/send');";
  const manifest: CapabilityManifest = { network: { egress: ['api.sendgrid.com'] }, auth: 'SECRET_TEXT' };
  const r = validatePiece(cleanMeta, src, manifest);
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 0);
});

test('validatePiece: metadata-only (no source) still validates metadata', () => {
  const bad: PieceMetaLike = { ...cleanMeta, displayName: undefined };
  const r = validatePiece(bad);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((x) => x.code === 'missing-displayName'));
  assert.equal(r.facts, undefined);
});
test('validatePiece: piece only missing description -> ok=true with warn short-description', () => {
  const meta: PieceMetaLike = { ...cleanMeta, description: undefined };
  const r = validatePiece(meta);
  assert.equal(r.ok, true);
  assert.ok(r.findings.some((x) => x.code === 'short-description' && x.level === 'warn'));
  assert.equal(r.findings.some((x) => x.level === 'error'), false);
});
