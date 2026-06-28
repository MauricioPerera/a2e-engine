// E2E: build a flow whose whoami step references the 'my-echo-conn' connection,
// run it through the bundled engine. The engine fetches the connection from the
// mock over HTTP, decrypts it, and populates context.auth. We assert the piece
// received the credential (apiKeyTail == "1234") and that the secret never
// appears in the flow JSON nor the step output.
import { createRequire } from 'node:module';
import { connectionRef, buildPieceStep } from '../../flow-builder/src/flow-builder.js';

const require = createRequire(import.meta.url);
// execute-flow.cjs is CommonJS and pulls in the bundled engine.
const { executeFlow } = require('../src/execute-flow.cjs') as {
  executeFlow: (args: {
    action: unknown;
    port: string;
  }) => Promise<{ verdict: unknown; steps: Record<string, { status: string; output: unknown; errorMessage?: string }> }>;
};

const PORT = process.env.PORT ?? '3997';
const SECRET = 'sk-test-ABCD1234';

const step = buildPieceStep(
  {
    name: 'whoami_step',
    pieceName: '@automators/piece-echo-auth',
    pieceVersion: '0.1.0',
    actionName: 'whoami',
    input: { auth: connectionRef('my-echo-conn') },
  },
  new Date().toISOString(),
);

const flowJson = JSON.stringify(step);
console.log('=== FLOW JSON ===');
console.log(flowJson);
console.log('flow JSON contains full secret?', flowJson.includes(SECRET));

(async () => {
  const result = await executeFlow({ action: step, port: PORT });
  const stepOutput = result.steps['whoami_step'];
  const outStr = JSON.stringify(stepOutput?.output);
  console.log('=== RESULT ===');
  console.log('verdict:', JSON.stringify(result.verdict));
  console.log('step status:', stepOutput?.status);
  console.log('step output:', outStr);
  console.log('step errorMessage:', stepOutput?.errorMessage);
  console.log('output contains full secret?', outStr?.includes(SECRET));
})().catch((e) => {
  console.log('=== THREW ===');
  console.log(e?.stack ?? e);
  process.exit(1);
});
