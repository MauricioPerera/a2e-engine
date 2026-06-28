import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateOkfCatalog } from './okf-generator.js';
import type { PieceMetadataInput } from './types.js';

function action(
  name: string,
  displayName: string,
  audience?: 'human' | 'ai' | 'both',
): PieceMetadataInput['actions'][string] {
  return {
    name,
    displayName,
    description: `${displayName} description`,
    props: {},
    requireAuth: false,
    audience,
  };
}

function trigger(
  name: string,
  displayName: string,
  audience?: 'human' | 'ai' | 'both',
): PieceMetadataInput['triggers'][string] {
  return {
    name,
    displayName,
    description: `${displayName} trigger description`,
    props: {},
    requireAuth: false,
    strategy: 'POLLING',
    audience,
  };
}

function samplePiece(): PieceMetadataInput {
  return {
    name: 'json',
    displayName: 'JSON',
    description: 'JSON helper piece',
    version: '0.1.0',
    actions: {
      humanAction: action('humanAction', 'Human Action', 'human'),
      bothAction: action('bothAction', 'Both Action', 'both'),
    },
    triggers: {
      humanTrigger: trigger('humanTrigger', 'Human Trigger', 'human'),
    },
  };
}

test('emits actions with audience human and both', () => {
  const files = generateOkfCatalog([samplePiece()]);
  const paths = files.map((f) => f.path);

  assert.ok(
    paths.includes('json/actions/humanAction.md'),
    'human audience action must be emitted',
  );
  assert.ok(
    paths.includes('json/actions/bothAction.md'),
    'both audience action must be emitted',
  );
});

test('root index.md counts both actions', () => {
  const files = generateOkfCatalog([samplePiece()]);
  const root = files.find((f) => f.path === 'index.md');
  assert.ok(root, 'root index.md must exist');

  // Row for the json piece: | [JSON](/json/index.md) | <nA> | <nT> | ...
  const row = root!.content
    .split('\n')
    .find((l) => l.includes('](/json/index.md)'));
  assert.ok(row, 'json row must be in root index');
  // nA column must be 2 (both actions, including the human one)
  const match = row!.match(/\]\(([^)]*)\)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/);
  assert.ok(match, 'row must have counts columns');
  assert.equal(match![2], '2', 'action count must be 2 (human + both)');
});

test('trigger with audience human is emitted', () => {
  const files = generateOkfCatalog([samplePiece()]);
  const paths = files.map((f) => f.path);

  assert.ok(
    paths.includes('json/triggers/humanTrigger.md'),
    'human audience trigger must be emitted',
  );
});

test('still generates root index and per-piece index', () => {
  const files = generateOkfCatalog([samplePiece()]);
  const paths = files.map((f) => f.path);

  assert.ok(paths.includes('index.md'), 'root index.md must exist');
  assert.ok(paths.includes('json/index.md'), 'piece index.md must exist');
});