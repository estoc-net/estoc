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
 * first when it was born offline (`prepare`); that envelope posted where
 * the peer receives, directly or forwarded through its mediator, and
 * the acceptance recorded (`submit`); every message still owed work
 * tried in turn, waiting between attempts that may succeed later
 * (`outbox`); and every delivery that arrives put through the gate
 * before the vault — the recipients it names, the key it opens with,
 * the sender it proves resolved for it — terminal, held for what it
 * waits on, or handed to the receipt, which records it in the
 * relationship its address pair or its proof's issuer finds, or a new
 * one born at the pair (`receive`). The protocols themselves —
 * message types and shapes — are shared with the package root under
 * `protocol/`.
 */

export { AmbiguousTarget, EntityConflict, MediatorRefused, ReceiverClosed, ReceiverInUse, UnauthorizedKey, UnknownEntity, Unregistered, Unusable, UnverifiedReply, WrongAccount, WrongMediator } from "./errors.js";
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
export { MAX_ENVELOPE_BYTES, SUBMIT_TIMEOUT_MS, submit, type SubmitOptions, type Submitted } from "./submit.js";
export { Outbox, RETRY_POLICY, type Backoff, type OutboxOptions, type RetryPolicy, type Step, type Timers } from "./outbox.js";
export { RESOLUTION_POLICY, ResolutionSequence, type ResolutionPolicy, type Retention } from "./receive/accounting.js";
export { classifyRecipients, pairEvidence, sealingOf, senderProof, type AuthenticatedSender, type Recipients, type Sealing, type SenderProof } from "./receive/gate.js";
export {
  ENDED_KEPT,
  MAX_HELD_BYTES,
  Receiver,
  deliveryKey,
  type Authenticated,
  type Delivery,
  type Receipt,
  type ReceiptOutcome,
  type Received,
  type ReceiverOptions,
  type Source,
  type WaitKind,
  type Waiting,
} from "./receive/receiver.js";
export { receiptOf, recordReceipt, type ReceiptOptions } from "./receive/receipt.js";
