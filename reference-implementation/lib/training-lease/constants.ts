/**
 * Constants for the AI-training lease prototype (draft AI Training Profile).
 * PROTOTYPE: not a Core surface, off by default.
 */
export const AI_TRAINING_PERMISSION = "https://pdpp.dev/processing/ai_training";

/** JWS `typ` for a processing lease. */
export const LEASE_JWS_TYP = "pdpp-processing-lease+jwt";

/** L2: `exp` is at most one hour after `iat`. */
export const MAX_LEASE_LIFETIME_MS = 60 * 60 * 1000;

/** L2: an AS issues leases of at least 30 minutes unless training expiry is sooner. */
export const MIN_LEASE_LIFETIME_MS = 30 * 60 * 1000;
