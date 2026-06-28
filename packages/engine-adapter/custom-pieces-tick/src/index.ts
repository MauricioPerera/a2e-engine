import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { newTick } from './lib/triggers/new-tick';

export const tick = createPiece({
  displayName: 'Tick',
  description: 'Demo piece with a POLLING trigger returning a fixed list.',
  auth: PieceAuth.None(),
  minimumSupportedRelease: '0.30.0',
  logoUrl: 'https://cdn.activepieces.com/pieces/new-core/json-helper.svg',
  authors: ['myorg'],
  actions: [],
  triggers: [newTick],
});
