// End-to-end: build a PieceAction (json piece, convert_text_to_json) and run it
// in-process through the bundled engine. Reports verdict + step output.
const path = require('path');
const { executeFlow } = require('./src/execute-flow.cjs');

// PieceAction node — same shape as flow-builder buildPieceStep.
const action = {
  name: 'parse',
  valid: true,
  displayName: 'Parse JSON',
  lastUpdatedDate: new Date().toISOString(),
  type: 'PIECE',
  settings: {
    pieceName: '@activepieces/piece-json',
    pieceVersion: '0.1.8',
    actionName: 'convert_text_to_json',
    input: { text: '{"hello":"world","n":42}' },
    propertySettings: { text: {} },
    errorHandlingOptions: undefined,
  },
  nextAction: undefined,
};

(async () => {
  const port = process.env.PORT || '3997';
  try {
    const result = await executeFlow({ action, port });
    const stepOutput = result.steps && result.steps['parse'];
    console.log('=== RESULT ===');
    console.log('verdict:', JSON.stringify(result.verdict));
    console.log('step status:', stepOutput && stepOutput.status);
    console.log('step output:', JSON.stringify(stepOutput && stepOutput.output));
    console.log('step errorMessage:', stepOutput && stepOutput.errorMessage);
  } catch (e) {
    console.log('=== THREW ===');
    console.log(e && e.stack ? e.stack : e);
  }
})();
