/**
 * Minimal, decoupled mirror of the Activepieces `PieceMetadata` shape
 * (verified against packages/pieces/framework/src/lib/piece-metadata.ts).
 *
 * We intentionally do NOT import @activepieces/pieces-framework here: the OKF
 * emitter is a pure function over JSON-serializable metadata, runnable without
 * building the Activepieces monorepo. When you wire real piece-loading later,
 * the object returned by `piece.metadata()` is structurally compatible with
 * `PieceMetadataInput` below.
 */

export type Audience = 'human' | 'ai' | 'both';

/** One input property of an action/trigger (a member of PiecePropertyMap). */
export interface PieceProperty {
  /** e.g. SHORT_TEXT, LONG_TEXT, NUMBER, CHECKBOX, DROPDOWN, OAUTH2, ... */
  type: string;
  displayName: string;
  description?: string;
  required: boolean;
  /** present on dropdown-like props; left opaque on purpose */
  options?: unknown;
}

export type PiecePropertyMap = Record<string, PieceProperty>;

export interface AiMetadata {
  description?: string;
  idempotent?: boolean;
}

export interface ActionOrTrigger {
  name: string;
  displayName: string;
  description: string;
  props: PiecePropertyMap;
  requireAuth?: boolean;
  /** triggers only: POLLING | WEBHOOK | APP_WEBHOOK */
  strategy?: string;
  /** who this is meant for; we surface 'ai' | 'both' to the agent catalog */
  audience?: Audience;
  aiMetadata?: AiMetadata;
}

export interface PieceAuthSummary {
  /** AppConnectionType-ish: SECRET_TEXT | CUSTOM_AUTH | OAUTH2 | BASIC_AUTH | NONE */
  type: string;
  displayName?: string;
  description?: string;
  required?: boolean;
}

/** Structurally compatible with the output of `piece.metadata()`. */
export interface PieceMetadataInput {
  name: string;
  displayName: string;
  description: string;
  version: string;
  logoUrl?: string;
  categories?: string[];
  authors?: string[];
  auth?: PieceAuthSummary;
  actions: Record<string, ActionOrTrigger>;
  triggers: Record<string, ActionOrTrigger>;
}

/** A virtual file the emitter produces: relative path -> markdown content. */
export interface OkfFile {
  /** path relative to the catalog root, POSIX separators */
  path: string;
  content: string;
}
