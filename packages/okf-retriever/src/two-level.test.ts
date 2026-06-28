// Tests congelados del two-level retriever. Oráculo independiente: solo importa
// el target para los tipos, las aserciones se construyen sin reusar su lógica.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  renderPieceHint,
  retrievePieces,
  scoreAction,
  renderActionDetail,
  retrieveActions,
  type ActionDetail,
  type LevelResult,
} from './two-level.js';
import { estimateTokens, type PieceSummary } from './okf-retriever.js';

const PIECES: PieceSummary[] = [
  {
    name: 'gmail',
    displayName: 'Gmail',
    description: 'Send and read email messages',
    tags: ['email', 'google'],
    auth: 'oauth2',
    actions: [
      { name: 'send_email', description: 'Send an email' },
      { name: 'read_email', description: 'Read emails' },
    ],
  },
  {
    name: 'slack',
    displayName: 'Slack',
    description: 'Chat with your team',
    tags: ['chat', 'team'],
    actions: [{ name: 'send_message', description: 'Post a message to a channel' }],
  },
  {
    name: 'sheets',
    displayName: 'Google Sheets',
    description: 'Manage spreadsheets',
    tags: ['spreadsheet', 'google'],
    actions: [{ name: 'add_row', description: 'Append a row to a sheet' }],
  },
  {
    name: 'calendar',
    displayName: 'Google Calendar',
    description: 'Manage calendar events',
    tags: ['calendar', 'google'],
    actions: [{ name: 'create_event', description: 'Create a calendar event' }],
  },
];

const GMAIL_ACTIONS: ActionDetail[] = [
  {
    name: 'send_email',
    displayName: 'Send Email',
    description: 'Send an email message to a recipient',
    requireAuth: true,
    props: [
      { name: 'to', type: 'string', required: true, description: 'Recipient address' },
      { name: 'subject', type: 'string', required: true },
      { name: 'body', type: 'string', required: false, description: 'Email body' },
    ],
  },
  {
    name: 'read_email',
    description: 'Read emails from the inbox',
    props: [{ name: 'limit', type: 'number', required: false }],
  },
  {
    name: 'mark_read',
    description: 'Mark a message as read',
    props: [],
  },
];

test('tokenize: lowercase, split por no-alfanum, descarta vacíos y stopwords', () => {
  assert.deepEqual(tokenize('Send Email!'), ['send', 'email']);
  assert.deepEqual(tokenize('the gmail and read'), ['gmail', 'read']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize('---'), []);
});

test('renderPieceHint lista NOMBRES de actions (no props) con el formato', () => {
  const hint = renderPieceHint({
    name: 'gmail',
    displayName: 'Gmail',
    description: 'Send and read email messages',
    auth: 'oauth2',
    actions: [{ name: 'send_email' }, { name: 'read_email' }],
  });
  assert.ok(hint.startsWith('- gmail (oauth2): '), hint);
  assert.ok(hint.includes('| actions: send_email, read_email'), hint);
  // No debe incluir props ni descripciones de actions.
  assert.ok(!hint.includes('Recipient'), hint);
});

test('renderPieceHint usa no-auth y recorta descripción larga', () => {
  const hint = renderPieceHint({
    name: 'slack',
    displayName: 'Slack',
    description: 'A'.repeat(200),
    actions: [{ name: 'send_message' }],
  });
  assert.ok(hint.startsWith('- slack (no-auth): '), hint);
  assert.ok(hint.includes('| actions: send_message'), hint);
  assert.ok(hint.length < 200, 'descripción debe estar acotada');
});

test('renderPieceHint con muchas actions agrega "+N more"', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ name: `act_${i}` }));
  const hint = renderPieceHint({
    name: 'p',
    displayName: 'P',
    description: 'd',
    actions: many,
  });
  assert.ok(hint.includes('+3 more'), hint);
  assert.ok(!hint.includes('act_14'), 'no lista el nombre 15');
});

test('retrievePieces filtra por query y mete action-NAMES (no props) en el context', () => {
  const res = retrievePieces(PIECES, 'gmail', { maxTokens: 100000 });
  assert.equal(res.included.length, 1);
  assert.equal(res.included[0], 'gmail');
  assert.ok(res.context.includes('send_email'), 'context lista el nombre de la action');
  assert.ok(res.context.includes('read_email'));
  assert.ok(!res.context.includes('Recipient'), 'context NO incluye props');
  assert.equal(res.estimatedTokens, estimateTokens(res.context));
});

test('retrievePieces respeta maxTokens: budget chico => omitted > 0', () => {
  const loose = retrievePieces(PIECES, 'google', { maxTokens: 100000 });
  const tight = retrievePieces(PIECES, 'google', { maxTokens: 20 });
  assert.ok(tight.included.length < loose.included.length, 'budget bajo recorta');
  assert.ok(tight.omitted > 0, 'debe reportar omitidas');
  assert.ok(tight.estimatedTokens <= 20, 'context cabe en el budget');
  assert.equal(tight.omitted, tight.total - tight.included.length);
});

test('retrievePieces fallback con query vacía: todas ordenadas por name', () => {
  const res = retrievePieces(PIECES, '', { maxTokens: 100000 });
  assert.equal(res.total, PIECES.length);
  assert.deepEqual(res.included, ['calendar', 'gmail', 'sheets', 'slack']);
  assert.equal(res.omitted, 0);
});

test('retrievePieces query solo con stopwords => fallback por name', () => {
  const res = retrievePieces(PIECES, 'the and of', { maxTokens: 100000 });
  assert.deepEqual(res.included, ['calendar', 'gmail', 'sheets', 'slack']);
});

test('retrievePieces estimatedTokens <= maxTokens siempre', () => {
  const res = retrievePieces(PIECES, 'google', { maxTokens: 50 });
  assert.ok(res.estimatedTokens <= 50);
});

test('scoreAction da más peso a name/displayName que a description', () => {
  const nameMatch = scoreAction(GMAIL_ACTIONS[0], ['send_email']); // en name+displayName
  const descMatch = scoreAction(GMAIL_ACTIONS[0], ['recipient']); // solo en description
  assert.ok(nameMatch > descMatch, `name(${nameMatch}) > desc(${descMatch})`);
  assert.ok(nameMatch > 0);
  assert.ok(descMatch > 0);
});

test('scoreAction retorna 0 si no matchea nada o sin terms', () => {
  assert.equal(scoreAction(GMAIL_ACTIONS[0], ['nonexistentterm']), 0);
  assert.equal(scoreAction(GMAIL_ACTIONS[0], []), 0);
});

test('renderActionDetail con props arma la tabla | prop | type | required |', () => {
  const block = renderActionDetail(GMAIL_ACTIONS[0]);
  assert.ok(block.startsWith('### send_email\n'), block);
  assert.ok(block.includes('Send an email message to a recipient'));
  assert.ok(block.includes('| prop | type | required |'));
  assert.ok(block.includes('| to | string | true |'));
  assert.ok(block.includes('| body | string | false |'));
});

test('renderActionDetail sin props dice "_no props_"', () => {
  const block = renderActionDetail(GMAIL_ACTIONS[2]); // props: []
  assert.ok(block.includes('_no props_'), block);
  assert.ok(!block.includes('| prop |'));
});

test('retrieveActions con query filtra las actions de la piece y mete props', () => {
  const res = retrieveActions(GMAIL_ACTIONS, 'send', { maxTokens: 100000 });
  assert.ok(res.included.includes('send_email'), 'incluir la action que matchea "send"');
  assert.ok(!res.included.includes('read_email'), 'descartar la que no matchea');
  assert.ok(res.context.includes('| to | string | true |'), 'context mete las props');
  assert.equal(res.estimatedTokens, estimateTokens(res.context));
  assert.ok(res.estimatedTokens <= 100000);
});

test('retrieveActions con query que no matchea ninguna => total 0, included 0', () => {
  const res = retrieveActions(GMAIL_ACTIONS, 'nonexistentterm', { maxTokens: 100000 });
  assert.equal(res.total, 0);
  assert.equal(res.included.length, 0);
  assert.equal(res.context, '');
});

test('retrieveActions sin query (undefined) devuelve todas en orden original', () => {
  const res = retrieveActions(GMAIL_ACTIONS, undefined, { maxTokens: 100000 });
  assert.equal(res.total, GMAIL_ACTIONS.length);
  assert.deepEqual(res.included, ['send_email', 'read_email', 'mark_read']);
  assert.equal(res.omitted, 0);
});

test('retrieveActions con query vacía ("" ) devuelve todas en orden original', () => {
  const res = retrieveActions(GMAIL_ACTIONS, '', { maxTokens: 100000 });
  assert.deepEqual(res.included, ['send_email', 'read_email', 'mark_read']);
});

test('retrieveActions respeta maxTokens: budget chico => omitted > 0', () => {
  const loose = retrieveActions(GMAIL_ACTIONS, undefined, { maxTokens: 100000 });
  const tight = retrieveActions(GMAIL_ACTIONS, undefined, { maxTokens: 15 });
  assert.ok(tight.included.length < loose.included.length);
  assert.ok(tight.omitted > 0);
  assert.ok(tight.estimatedTokens <= 15);
  assert.equal(tight.omitted, tight.total - tight.included.length);
});

test('retrieveActions: ambos LevelResult con estimatedTokens <= maxTokens', () => {
  const a = retrieveActions(GMAIL_ACTIONS, 'send', { maxTokens: 30 });
  const b = retrieveActions(GMAIL_ACTIONS, undefined, { maxTokens: 30 });
  assert.ok(a.estimatedTokens <= 30);
  assert.ok(b.estimatedTokens <= 30);
  // included/omitted coherentes con total.
  assert.equal(a.omitted, a.total - a.included.length);
  assert.equal(b.omitted, b.total - b.included.length);
});