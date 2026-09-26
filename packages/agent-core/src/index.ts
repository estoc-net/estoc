/**
 * `@estoc/agent-core` — the DIDComm v2 agent over the vault. A
 * message is decided over the fold read under the vault's writer lock
 * and committed as an intent, then as a package, before its one
 * transport call, which goes under a live action once the lock is
 * released. The protocols themselves — message types and shapes — are
 * under `protocol/`; `unpack` opens an
 * inbound envelope there with its rotation proof left for the vault
 * to judge.
 */

export * from "./protocol/spec.js";
export * from "./protocol/mediation.js";
export { BASIC_MESSAGE } from "./protocol/basicmessage.js";
export { PROFILE, REQUEST_PROFILE, announcedName } from "./protocol/user-profile.js";
export {
  ENCRYPTED_MIME,
  EnvelopeRefused,
  PLAIN_TYP,
  endpointOf,
  plainMessage,
  secretsResolverFor,
  serviceUris,
  unpack,
  type DidcommApi,
  type IMessage,
  type Unpacked,
} from "./protocol/didcomm.js";
export { GOAL_CONNECT, invitationUrl, parseInvitation, type Invitation } from "./protocol/oob.js";
export { didHost, resolveMediatorInput } from "./protocol/mediator-input.js";

export { AmbiguousTarget, EntityConflict, MediatorRefused, NoTarget, NotificationConflict, ReceiverClosed, ReceiverInUse, UnauthorizedKey, UnknownEntity, Unregistered, Unusable, UnverifiedReply, WrongAccount, WrongMediator } from "./errors.js";
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
  type OpenVaultOptions,
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
export { createMediation, establish, mediationOf, reconcile, reconcileNow, registered, selectMediation, watchUnknownRegistrations, type EstablishStep, type Established, type Reconciled } from "./mediation.js";
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
export { automaticDraft, manualNotificationDraft, send, type AutomaticDraft, type Content, type Effect, type EffectContent, type SendOptions, type Sent, type Target } from "./send.js";
export { MAX_CONTENT_BYTES, hasExpired, outboundWorkKey, prepare, prepareAll, type PrepareOptions, type Prepared } from "./prepare.js";
export { LiveAction, LiveInput, type ActionKind } from "./action.js";
export { DISPATCH_TIMEOUT_MS, MAX_ENVELOPE_BYTES, cancel, dispatch, type Cancelled, type DispatchOptions, type Dispatched } from "./dispatch.js";
export { Dispatcher, GLOBAL_TIMERS, LONGEST_TIMER_MS, RETRY_POLICY, type DispatcherOptions, type PendingOutbound, type RetryPolicy, type Timers, type Waiting } from "./dispatcher.js";
export { classifyRecipients, sealingOf, senderEvidence, senderProof, type AuthenticatedSender, type Recipients, type Sealing, type SenderProof } from "./receive/gate.js";
export {
  DISCARDED_KEPT,
  ENDED_KEPT,
  MAX_HELD_BYTES,
  MAX_WAITING,
  REASON_KEPT,
  Receiver,
  deliveryKey,
  recipientWatch,
  type Authenticated,
  type Delivery,
  type Discarded,
  type Ingress,
  type Receipt,
  type ReceiptOutcome,
  type Received,
  type ReceiverOptions,
  type Source,
  type WaitingDelivery,
  type Watch,
} from "./receive/receiver.js";
export { receiptOf, recordReceipt } from "./receive/receipt.js";
export { acknowledgementDrafts, recordAcks } from "./receive/acks.js";
export { afterReceipt, recordOwed, recordOwedUnderLock, type AfterReceipt, type AfterReceiptOptions, type Owed } from "./receive/after.js";
export { callEffects, completeResponse, decideEffects, reactTo, type Called, type DecidedEffects, type EffectOptions, type EffectOutcome, type Reacted } from "./effects.js";
export { callRotation, completeNotification, decideRotation, rotate, type RotateOptions, type Rotated, type RotationDecided, type RotationTarget } from "./rotate.js";
export { callPrivateAddress, decidePrivateAddress, privacyPolicy, privateAddress, type PrivacyPolicy, type PrivateAddress, type PrivateAddressDecided } from "./privacy.js";
export { BUILT_IN_HANDLERS, basicMessage, claimedName, effectTypesOf, empty, handlerFor, handlersOf, reportProblem, reportedProblem, trustPing, userProfile, type Handler, type Input, type Response } from "./handlers/index.js";
export {
  recorder,
  type BodyRecord,
  type ChannelRecord,
  type ConflictingNotification,
  type ContactChannelRecord,
  type ContactRecord,
  type Diagnostic,
  type DiagnosticKind,
  type InvitationRecord,
  type ManualEntry,
  type MessageHeaders,
  type MessageRecord,
  type OwedNotification,
  type OwedResponse,
  type OpenOutbound,
  type WaitingProof,
  type PendingWork,
  type Recorder,
  type DispositionRecord,
  type ObservationRecord,
  type Unplaced,
  type UnplacedOutput,
  type ViewOptions,
} from "./records.js";
export { manualProcedures, readRecords, type Manual, type ManualOptions } from "./views.js";
export { Agent, UNKNOWN_REGISTRATIONS_KEPT, type AgentOptions, type Connection, type Inbound, type Submitted } from "./agent.js";
