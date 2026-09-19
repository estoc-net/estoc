/**
 * `@estoc/agent-core/v3` — the agent over the version-3 vault, bottom
 * up: the vault opened, created and inspected with the seed's keys
 * (`identity`); the keys in hand for didcomm (`keyring`); the trace of
 * what this runtime observed (`trace`); the line to a mediator and the
 * pickup of what it holds (`link`, `pickup`); the mediation rituals and
 * the reconciliation of recipients (`mediation`); routes, communication
 * DIDs, disclosure and retirement (`dids`); a peer's DID resolved to
 * the exact evidence the vault retains and the failures that leave
 * work retryable told from the ones that close it (`resolver`); and that
 * evidence committed, read back and handed to didcomm under the
 * spelling it asks for (`evidence`); and a message decided and
 * committed as an intent in its fixed channel before any network work,
 * as a user's send or an operation's automatic effect (`send`); and
 * that intent's one package made from local evidence alone and
 * committed with its envelope (`prepare`); and that package's one
 * transport call under a live action, its acceptance recorded, its
 * cancellation, and the dispatcher that waits out a prerequisite for
 * as long as the action lives (`action`, `dispatch`, `dispatcher`).
 * The protocols themselves —
 * message types and shapes — are shared with the package root under
 * `protocol/`; `unpack` opens an inbound envelope there with its
 * rotation proof left for the vault to judge.
 */

export { EnvelopeRefused, unpack, type Unpacked } from "../protocol/didcomm.js";

export { AmbiguousTarget, EntityConflict, MediatorRefused, NoTarget, UnauthorizedKey, UnknownEntity, Unregistered, Unusable, UnverifiedReply, WrongAccount, WrongMediator } from "./errors.js";
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
export { Pickup, type Delivered, type Drained, type Fate, type Handle, type PickupOptions } from "./pickup.js";
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
  pinnedResolver,
  readResolution,
  resolutionData,
  type CommitResolutionOptions,
  type PinnedResolverOptions,
  type ResolutionEvidence,
} from "./evidence.js";
export { automaticDraft, send, type AutomaticDraft, type Content, type Effect, type EffectContent, type SendOptions, type Sent, type Target } from "./send.js";
export { MAX_CONTENT_BYTES, hasExpired, outboundWorkKey, prepare, prepareAll, type PrepareOptions, type Prepared } from "./prepare.js";
export { LiveAction, type ActionKind } from "./action.js";
export { DISPATCH_TIMEOUT_MS, MAX_ENVELOPE_BYTES, cancel, dispatch, type Cancelled, type DispatchOptions, type Dispatched } from "./dispatch.js";
export { Dispatcher, GLOBAL_TIMERS, LONGEST_TIMER_MS, RETRY_POLICY, type DispatcherOptions, type PendingOutbound, type RetryPolicy, type Timers, type Waiting } from "./dispatcher.js";
