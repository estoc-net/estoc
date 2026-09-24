/**
 * @estoc/continuity — continuity between oriented DID pairs, derived
 * from normalized facts. This entry point is the pure model: fact
 * validation and canonical equality, the union merge of snapshots, and
 * synchronous deterministic queries over a snapshot. It parses no JWT
 * and does no cryptography; that is `@estoc/continuity/from-prior`.
 */

export type { AddressObservation, Change, Channel, ContinuityFact, Did, EvidenceRef, FactId, FactSnapshot, LocalDecision, PeerTransition } from "./types.js";
export { PROFILE_VERSION } from "./types.js";
export { IncompatibleSnapshot, InvalidFact } from "./errors.js";
export { canonicalFact, channelOf, compareChannels, compareUtf8, sameChannel, successorChannel, validateFact } from "./facts.js";
export { emptySnapshot, mergeFacts, normalizeSnapshot, sameFacts } from "./merge.js";
export { deriveContinuity } from "./model.js";
export type { ChangeRecord, Confirmation, ConfirmationResult, Conflict, Continuity, EndingRecord, FactStatus, HeadResult, History, PathResult, PositiveLink, Side } from "./model.js";
