// Tests congelados del okf-retriever. Oráculo independiente: solo importa el
// target para los tipos, las aserciones se construyen sin reusar su lógica.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  scorePiece,
  selectPieces,
  renderPieceLine,
  renderPieceDetail,
  renderCatalog,
  retrieve,
  type PieceSummary,
} from './okf-retriever.js';

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

test('estimateTokens ~ chars/4 (ceil)', () => {
  assert.equal(estimateTokens('abcd'), 1); // 4 chars -> 1
  assert.equal(estimateTokens('abcde'), 2); // 5 chars -> ceil(5/4)=2
  assert.equal(estimateTokens('hello world'), 3); // 11 chars -> ceil(11/4)=3
  assert.equal(estimateTokens(''), 0);
});

test('scorePiece da más peso a match en name que en description', () => {
  const nameMatch = scorePiece(PIECES[0], ['gmail']); // 'gmail' en name+displayName
  const descMatch = scorePiece(PIECES[0], ['messages']); // 'messages' solo en description
  assert.ok(nameMatch > descMatch, `name(${nameMatch}) debe ser > desc(${descMatch})`);
  assert.ok(nameMatch > 0);
  assert.ok(descMatch > 0);
});

test('scorePiece retorna 0 si no matchea nada', () => {
  assert.equal(scorePiece(PIECES[1], ['nonexistentterm']), 0);
  assert.equal(scorePiece(PIECES[1], []), 0); // sin terms -> 0
});

test('selectPieces filtra por query y descarta los no-matches', () => {
  const r = selectPieces(PIECES, 'gmail', { maxTokens: 10000 });
  assert.equal(r.length, 1);
  assert.equal(r[0].name, 'gmail');
});

test('selectPieces ordena por score desc (estable) y por name en empate', () => {
  // 'google' aparece en displayName+tags de sheets y calendar (mismo score),
  // y solo en tags de gmail (menor). Empate sheets/calendar -> orden por name.
  const r = selectPieces(PIECES, 'google', { maxTokens: 10000 });
  assert.equal(r.length, 3);
  assert.ok(r[0].name === 'sheets' || r[0].name === 'calendar'); // top score
  assert.ok(r[2].name === 'gmail'); // menor score al final
});

test('selectPieces respeta el budget: maxTokens bajo => menos pieces', () => {
  const full = selectPieces(PIECES, 'google', { maxTokens: 10000 });
  const trimmed = selectPieces(PIECES, 'google', { maxTokens: 30, mode: 'index' });
  assert.ok(trimmed.length < full.length, 'budget bajo debe recortar');
  assert.ok(trimmed.length >= 1, 'cabe al menos una piece si el header lo permite');
  // El resultado renderizado realmente cabe en el budget.
  assert.ok(estimateTokens(renderCatalog(trimmed, 'index')) <= 30);
});

test('selectPieces query vacía => fallback ordenado por name', () => {
  const r = selectPieces(PIECES, '', { maxTokens: 100000 });
  assert.equal(r.length, PIECES.length);
  assert.deepEqual(
    r.map((p) => p.name),
    ['calendar', 'gmail', 'sheets', 'slack'],
  );
});

test('selectPieces query solo con stopwords => fallback por name', () => {
  const r = selectPieces(PIECES, 'the and of', { maxTokens: 100000 });
  assert.deepEqual(
    r.map((p) => p.name),
    ['calendar', 'gmail', 'sheets', 'slack'],
  );
});

test('renderCatalog index vs detail difieren; detail incluye actions', () => {
  const idx = renderCatalog([PIECES[0]], 'index');
  const det = renderCatalog([PIECES[0]], 'detail');
  assert.notEqual(idx, det);
  assert.ok(det.includes('send_email'), 'detail debe listar actions');
  assert.ok(!idx.includes('send_email'), 'index no debe listar actions');
  assert.ok(idx.includes('[2 actions]'), 'index lleva conteo de actions');
});

test('renderPieceLine formato compacto', () => {
  const line = renderPieceLine(PIECES[0]);
  assert.ok(line.startsWith('- gmail (oauth2): '), line);
  assert.ok(line.endsWith(' [2 actions]'), line);
});

test('renderPieceDetail incluye name, auth, descripción y actions', () => {
  const det = renderPieceDetail(PIECES[0]);
  assert.ok(det.includes('## gmail (oauth2)'), det);
  assert.ok(det.includes('Send and read email messages'), det);
  assert.ok(det.includes('send_email — Send an email'), det);
});

test('retrieve reporta included/estimatedTokens/omitted coherentes (budget holgado)', () => {
  const res = retrieve(PIECES, 'google', { maxTokens: 100000, mode: 'index' });
  assert.equal(res.total, 3); // gmail, sheets, calendar matchean
  assert.equal(res.included.length, 3);
  assert.equal(res.omitted, 0);
  assert.equal(res.estimatedTokens, estimateTokens(res.context));
  assert.deepEqual(res.included.sort(), ['calendar', 'gmail', 'sheets']);
});

test('retrieve reporta omitted>0 con budget bajo', () => {
  const res = retrieve(PIECES, 'google', { maxTokens: 30, mode: 'index' });
  assert.equal(res.total, 3);
  assert.ok(res.included.length < res.total, 'no entran todas');
  assert.ok(res.omitted > 0, 'debe reportar omitidas');
  assert.equal(res.omitted, res.total - res.included.length);
  assert.ok(res.estimatedTokens <= 30);
});

test('retrieve query vacía => total = todas, included ordenado por name', () => {
  const res = retrieve(PIECES, '', { maxTokens: 100000 });
  assert.equal(res.total, PIECES.length);
  assert.deepEqual(res.included, ['calendar', 'gmail', 'sheets', 'slack']);
});

test('retrieve mode detail respeta budget y reporta tokens del contexto detail', () => {
  const res = retrieve(PIECES, 'gmail', { maxTokens: 100000, mode: 'detail' });
  assert.equal(res.included.length, 1);
  assert.ok(res.context.includes('send_email'));
  assert.equal(res.estimatedTokens, estimateTokens(res.context));
});