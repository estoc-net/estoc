/**
 * `@estoc/agent-core/v3` — the agent over the version-3 vault, bottom
 * up: the vault opened, created and inspected with the seed's keys
 * (`identity`); the keys in hand for didcomm (`keyring`); the trace of
 * what this runtime observed (`trace`); the line to a mediator and the
 * pickup of what it holds (`link`, `pickup`); the mediation rituals and
 * the reconciliation of recipients (`mediation`); routes, communication
 * DIDs, disclosure and retirement (`dids`); a peer's DID resolved to
 * the exact evidence the vault retains and the failures that leave
 * work retryable told from the ones that close it (`resolver`); that
 * evidence committed, read back and handed to didcomm under the
 * spelling it asks for (`evidence`); a message's content and control
 * headers frozen as one intent in the relationship its target
 * selects, without a byte on the wire (`send`); that intent turned into
 * the one exact envelope its submission will carry, the pair bound
 * first when it was born offline (`prepare`). The protocols themselves —
 * message types and shapes — are shared with the package root under
 * `protocol/`.
 */

export { AmbiguousTarget, EntityConflict, MediatorRefused, UnauthorizedKey, UnknownEntity, Unregistered, Unusable, UnverifiedReply, WrongAccount, WrongMediator } from "./errors.js";
export {
  createVault,
  inspectRuntime,
  inspectSnapshot,
  openVault,
  type CreateVaultOptions,
  type InspectSnapshotOptions,
  type InspectedRuntime,
  type InspectedSnapshot,
  type OpenedVault,
  type Unlock,
  type VaultOptions,
} from "./identity.js";
export { Keyring } from "./keyring.js";
export {
  AgentTrace,
  TRACE_LEVELS,
  TRACE_NORMAL,
  TRACE_OFF,
  TRACE_OPTION,
  TRACE_STREAMS,
  TRACE_VERBOSE,
  isTraceLevel,
  isTraceStream,
  streamOf,
  tracePolicy,
  type AgentTraceOptions,
  type TraceData,
  type TraceFilter,
  type TraceLevel,
  type TracePolicy,
  type TraceStream,
} from "./trace.js";
export { MediatorLink, bounded, ritual, sealData, sealerOf, senderOf, type LinkOptions, type Opened, type Sealed } from "./link.js";
export { Pickup, type Drained, type Fate, type Handle, type PickupOptions } from "./pickup.js";
export { decide, serially, type Decided } from "./procedure.js";
export { canonicalDid, sameDid } from "./same-did.js";
export { createMediation, establish, mediationOf, reconcile, reconcileNow, registered, selectMediation, type EstablishStep, type Established, type Reconciled } from "./mediation.js";
export {
  configureRoute,
  createDid,
  didOf,
  disclose,
  ensureRoute,
  invitationOf,
  mediatedRouteOf,
  retireDid,
  routeOf,
  routeTargetOf,
  type CreatedDid,
  type Disclosed,
  type Disclosure,
  type RouteSpec,
} from "./dids.js";
export { DEFINITIVE_TRANSPORT_CODES, MAX_DOCUMENT_BYTES, knownLongForms, resolve, webDidUrl, type KnownLongForms, type Resolution, type Resolved, type ResolverOptions, type WebResolverOptions } from "./resolver.js";
export {
  authorizedKeys,
  commitResolution,
  didcommDocumentOf,
  pinnedResolution,
  pinnedResolver,
  readResolution,
  resolutionData,
  type CommitResolutionOptions,
  type PinnedResolverOptions,
  type ResolutionEvidence,
} from "./evidence.js";
export { selectTarget, send, type Content, type Selection, type SendOptions, type Sender, type Sent, type Target } from "./send.js";
export { EXPIRED, MAX_CONTENT_BYTES, PEER_KEY_CHANGED, outboundWorkKey, prepare, prepareAll, type PrepareOptions, type Prepared } from "./prepare.js";
