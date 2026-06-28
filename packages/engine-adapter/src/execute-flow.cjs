// Adapter: runs a PieceAction in-process through the bundled Activepieces engine.
const { flowExecutor, EngineConstants, FlowExecutorContext } = require('../dist/engine.cjs');

const DEFAULT_RETRY = { maxAttempts: 1, retryExponential: 2, retryInterval: 1 };

// StreamStepProgress.NONE — string enum in shared. Use literal to avoid re-importing shared.
const STREAM_NONE = 'NONE';

// Walk the flow action graph and collect every step name. The engine's
// props-resolver only loads a referenced step's output into expression scope if
// the step name is present in EngineConstants.stepNames — so for {{stepX.output...}}
// expressions to resolve, ALL step names must be listed here.
function collectStepNames(action, acc = []) {
  if (!action || typeof action !== 'object') return acc;
  if (action.name) acc.push(action.name);
  if (action.firstLoopAction) collectStepNames(action.firstLoopAction, acc);
  if (Array.isArray(action.children)) {
    for (const c of action.children) collectStepNames(c, acc);
  }
  if (action.nextAction) collectStepNames(action.nextAction, acc);
  return acc;
}

function buildConstants({ port, engineToken = 'dev-engine-token', projectId = 'demo-project', platformId = 'demo-platform', stepNames = [] }) {
  const internalApiUrl = `http://localhost:${port}/`;
  const publicApiUrl = `http://localhost:${port}/api/`;
  return new EngineConstants({
    flowId: 'demo-flow',
    flowVersionId: 'demo-flow-version',
    flowVersionState: 'DRAFT',
    triggerPieceName: '@activepieces/piece-json',
    flowRunId: 'demo-run',
    publicApiUrl,
    internalApiUrl,
    retryConstants: DEFAULT_RETRY,
    engineToken,
    projectId,
    streamStepProgress: STREAM_NONE,
    workerHandlerId: null,
    httpRequestId: null,
    resumePayload: undefined,
    runEnvironment: undefined,
    stepNameToTest: undefined,
    logsFileId: undefined,
    timeoutInSeconds: 60,
    platformId,
    stepNames,
  });
}

async function executeFlow({ action, port, engineToken, projectId, platformId, stepNames }) {
  const resolvedStepNames = stepNames ?? collectStepNames(action);
  const constants = buildConstants({ port, engineToken, projectId, platformId, stepNames: resolvedStepNames });
  const executionState = FlowExecutorContext.empty({
    engineApi: {
      engineToken: constants.engineToken,
      internalApiUrl: constants.internalApiUrl,
    },
  });
  const result = await flowExecutor.execute({ action, executionState, constants });
  // Mirror flow.operation: promote a still-RUNNING verdict to SUCCEEDED.
  return result.finishExecution();
}

module.exports = { executeFlow, buildConstants, collectStepNames };
