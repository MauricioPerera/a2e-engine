import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  validateContractShape,
  contractToAssemblyConfig,
  slotsForAssembler,
} from './contract-config.ts';
import type { AssemblyConfig } from './contract-config.ts';

function validContract(): any {
  return {
    ccdd_version: '1.0',
    contract: {
      name: 'demo',
      budget: { model: 'gpt-x', max_tokens: 1000, reserve_output: 200 },
      slots: [
        {
          id: 'core',
          priority: 0,
          source: { type: 'static', path: 'core.md' },
          compaction: 'none',
          max_tokens: 400,
        },
        {
          id: 'tool',
          priority: 1,
          source: { type: 'dynamic', provider: 'tools' },
          compaction: 'truncate',
          max_tokens: 300,
        },
      ],
      guardrails: [
        { id: 'no-secret', type: 'regex', pattern: 'sk-[A-Za-z0-9]{20,}', on_fail: 'block', target_slot: 'tool' },
        { id: 'schema', type: 'schema', schema_path: 'schemas/x.json' },
      ],
    },
  };
}

// ---------- validateContractShape ----------
test('validateContractShape: contrato válido -> []', () => {
  assert.deepEqual(validateContractShape(validContract()), []);
});

test('validateContractShape: detecta budget faltante', () => {
  const c = validContract();
  delete c.contract.budget;
  const f = validateContractShape(c);
  assert.ok(f.some((x) => x.code === 'BUDGET_MISSING'));
  assert.equal(f.every((x) => x.level === 'error'), true);
});

test('validateContractShape: detecta max_tokens inválido (<=0)', () => {
  const c = validContract();
  c.contract.budget.max_tokens = 0;
  const f = validateContractShape(c);
  assert.ok(f.some((x) => x.code === 'BUDGET_MAX_TOKENS_INVALID'));
});

test('validateContractShape: detecta slots vacío', () => {
  const c = validContract();
  c.contract.slots = [];
  const f = validateContractShape(c);
  assert.ok(f.some((x) => x.code === 'SLOTS_EMPTY'));
});

test('validateContractShape: detecta slots no array', () => {
  const c = validContract();
  c.contract.slots = null;
  const f = validateContractShape(c);
  assert.ok(f.some((x) => x.code === 'SLOTS_EMPTY'));
});

test('validateContractShape: detecta slot sin id', () => {
  const c = validContract();
  delete c.contract.slots[0].id;
  const f = validateContractShape(c);
  assert.ok(f.some((x) => x.code === 'SLOT_MISSING_ID'));
});

test('validateContractShape: detecta slot sin priority', () => {
  const c = validContract();
  delete c.contract.slots[1].priority;
  const f = validateContractShape(c);
  assert.ok(f.some((x) => x.code === 'SLOT_MISSING_PRIORITY'));
});

test('validateContractShape: detecta slot sin compaction', () => {
  const c = validContract();
  c.contract.slots[0].compaction = 'wat';
  const f = validateContractShape(c);
  assert.ok(f.some((x) => x.code === 'SLOT_MISSING_COMPACTION'));
});

test('validateContractShape: detecta slot sin source.type', () => {
  const c = validContract();
  c.contract.slots[0].source = {};
  const f = validateContractShape(c);
  assert.ok(f.some((x) => x.code === 'SLOT_MISSING_SOURCE_TYPE'));
});

test('validateContractShape: no objeto -> CONTRACT_NOT_OBJECT', () => {
  const f = validateContractShape('nope');
  assert.ok(f.some((x) => x.code === 'CONTRACT_NOT_OBJECT'));
});

// ---------- contractToAssemblyConfig ----------
test('contractToAssemblyConfig: mapea budget y reserve_output', () => {
  const cfg = contractToAssemblyConfig(validContract());
  assert.equal(cfg.totalBudget, 1000);
  assert.equal(cfg.reserveOutput, 200);
});

test('contractToAssemblyConfig: reserve_output ausente -> 0', () => {
  const c = validContract();
  delete c.contract.budget.reserve_output;
  assert.equal(contractToAssemblyConfig(c).reserveOutput, 0);
});

test('contractToAssemblyConfig: mapea slots (max_tokens->maxTokens, source.type->sourceType, provider, path)', () => {
  const cfg = contractToAssemblyConfig(validContract());
  assert.equal(cfg.slots.length, 2);
  const core = cfg.slots[0]!;
  assert.equal(core.id, 'core');
  assert.equal(core.priority, 0);
  assert.equal(core.maxTokens, 400);
  assert.equal(core.compaction, 'none');
  assert.equal(core.sourceType, 'static');
  assert.equal(core.path, 'core.md');
  const tool = cfg.slots[1]!;
  assert.equal(tool.sourceType, 'dynamic');
  assert.equal(tool.provider, 'tools');
  assert.equal(tool.maxTokens, 300);
  assert.equal(tool.compaction, 'truncate');
});

test('contractToAssemblyConfig: mapea guardrails (on_fail->onFail, pattern, schema_path->schemaPath, target_slot->targetSlot)', () => {
  const cfg = contractToAssemblyConfig(validContract());
  assert.equal(cfg.guardrails.length, 2);
  const g0 = cfg.guardrails[0]!;
  assert.equal(g0.id, 'no-secret');
  assert.equal(g0.type, 'regex');
  assert.equal(g0.pattern, 'sk-[A-Za-z0-9]{20,}');
  assert.equal(g0.onFail, 'block');
  assert.equal(g0.targetSlot, 'tool');
  const g1 = cfg.guardrails[1]!;
  assert.equal(g1.id, 'schema');
  assert.equal(g1.schemaPath, 'schemas/x.json');
});

test('contractToAssemblyConfig: guardrails ausentes -> []', () => {
  const c = validContract();
  delete c.contract.guardrails;
  assert.deepEqual(contractToAssemblyConfig(c).guardrails, []);
});

// ---------- slotsForAssembler ----------
test('slotsForAssembler: produce SlotInput con content de contents y respeta priority/compaction/maxTokens', () => {
  const cfg: AssemblyConfig = {
    totalBudget: 1000,
    reserveOutput: 100,
    slots: [
      { id: 'a', priority: 2, maxTokens: 10, compaction: 'truncate', sourceType: 'static' },
      { id: 'b', priority: 0, compaction: 'none', sourceType: 'dynamic', provider: 'p' },
    ],
    guardrails: [],
  };
  const inputs = slotsForAssembler(cfg, { a: 'contenido A', b: 'contenido B' });
  assert.equal(inputs.length, 2);
  // mantiene el orden de cfg.slots
  assert.equal(inputs[0]!.id, 'a');
  assert.equal(inputs[0]!.content, 'contenido A');
  assert.equal(inputs[0]!.priority, 2);
  assert.equal(inputs[0]!.maxTokens, 10);
  assert.equal(inputs[0]!.compaction, 'truncate');
  assert.equal(inputs[1]!.id, 'b');
  assert.equal(inputs[1]!.content, 'contenido B');
  assert.equal(inputs[1]!.priority, 0);
  assert.equal(inputs[1]!.compaction, 'none');
  // b no tenía maxTokens -> undefined
  assert.equal(inputs[1]!.maxTokens, undefined);
});

test('slotsForAssembler: content "" si falta el slot en contents', () => {
  const cfg: AssemblyConfig = {
    totalBudget: 1000,
    reserveOutput: 0,
    slots: [{ id: 'x', priority: 0, compaction: 'none', sourceType: 'static' }],
    guardrails: [],
  };
  const inputs = slotsForAssembler(cfg, {});
  assert.equal(inputs[0]!.content, '');
});

test('slotsForAssembler: integra con assembleContext (forma SlotInput válida)', async () => {
  const { assembleContext } = await import('./context-assembler.ts');
  const cfg: AssemblyConfig = {
    totalBudget: 50,
    reserveOutput: 0,
    slots: [
      { id: 'a', priority: 0, compaction: 'none', sourceType: 'static' },
      { id: 'b', priority: 1, maxTokens: 5, compaction: 'truncate', sourceType: 'static' },
    ],
    guardrails: [],
  };
  const inputs = slotsForAssembler(cfg, { a: 'a'.repeat(40), b: 'b'.repeat(200) });
  const asm = assembleContext(inputs, { totalBudget: cfg.totalBudget, reserveOutput: cfg.reserveOutput });
  const aRes = asm.slots.find((s) => s.id === 'a')!;
  assert.equal(aRes.included, true);
  // b excede y es truncate -> incluido y truncado o dropeado según presupuesto
  assert.ok(asm.slots.some((s) => s.id === 'b'));
});