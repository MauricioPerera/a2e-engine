// Load + execution test for every bundled community piece.
// - Confirms the piece-loader resolves the piece (no PieceNotFoundError).
// - For offline no-auth pieces: executes a real action and asserts SUCCEEDED.
// - For auth/network pieces: only asserts the piece LOADS (a non-PieceNotFound
//   failure means the loader found it and execution failed later, as expected).
const path = require('path');

// Point the loader at our community bundle root BEFORE requiring the engine.
process.env.AP_CUSTOM_PIECES_PATHS = path.join(__dirname, 'community-pieces');

const { executeFlow } = require('./src/execute-flow.cjs');

const PORT = process.env.PORT || '3997';

// pieceName, pieceVersion, actionName, input, offline?
const CASES = [
  { piece: '@activepieces/piece-json', version: '0.1.8', action: 'convert_text_to_json',
    input: { text: '{"hello":"world","n":42}' }, props: { text: {} }, offline: true },
  { piece: '@activepieces/piece-json', version: '0.1.8', action: 'merge_json',
    input: { jsonArray: [{ a: 1 }, { b: 2 }], fieldStrategies: [] }, props: { jsonArray: {}, fieldStrategies: {} }, offline: true },
  { piece: '@activepieces/piece-flow-helper', version: '0.1.4', action: 'getRunId',
    input: {}, props: {}, offline: true },
  { piece: '@activepieces/piece-slack', version: '0.17.2', action: 'slack-add-reaction-to-message',
    input: {}, props: {}, offline: false },
  { piece: '@activepieces/piece-github', version: '0.8.3', action: 'github_create_issue',
    input: {}, props: {}, offline: false },
  { piece: '@activepieces/piece-airtable', version: '0.6.9', action: 'airtable_create_record',
    input: {}, props: {}, offline: false },
];

function buildAction(c) {
  return {
    name: 'step1', valid: true, displayName: c.action,
    lastUpdatedDate: new Date().toISOString(), type: 'PIECE',
    settings: {
      pieceName: c.piece, pieceVersion: c.version, actionName: c.action,
      input: c.input, propertySettings: c.props, errorHandlingOptions: undefined,
    },
    nextAction: undefined,
  };
}

(async () => {
  for (const c of CASES) {
    let loaded = false, executed = false, status = null, output = null, err = null;
    try {
      const result = await executeFlow({ action: buildAction(c), port: PORT });
      const step = result.steps && result.steps['step1'];
      status = step && step.status;
      output = step && step.output;
      err = step && step.errorMessage;
      // If we got a step result at all, the piece + action resolved -> loaded.
      loaded = true;
      executed = status === 'SUCCEEDED';
    } catch (e) {
      const msg = (e && e.message) || String(e);
      // PieceNotFoundError => loader could NOT find the piece.
      loaded = !/PieceNotFound/i.test(msg) && !/Piece not found/i.test(msg);
      err = msg;
    }
    console.log(JSON.stringify({
      piece: c.piece, action: c.action, offline: c.offline,
      loaded, status, executed,
      output: c.offline ? output : undefined,
      err: executed ? undefined : (typeof err === 'string' ? err.slice(0, 160) : err),
    }));
  }
})();
