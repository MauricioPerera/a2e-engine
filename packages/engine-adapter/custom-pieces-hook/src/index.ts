import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { onEvent } from './lib/triggers/on-event';

export const hook = createPiece({
  displayName: 'Hook',
  description: 'Demo piece with a WEBHOOK trigger that emits the inbound HTTP body.',
  auth: PieceAuth.None(),
  minimumSupportedRelease: '0.30.0',
  logoUrl: 'https://cdn.activepieces.com/pieces/new-core/json-helper.svg',
  authors: ['myorg'],
  actions: [],
  triggers: [onEvent],
});