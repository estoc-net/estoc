/**
 * Dispatching makes the one transport call of a prepared package, under
 * a live action that carries exactly one such call. The package goes
 * where the resolution it names says the peer receives: straight to an
 * HTTP endpoint, or inside a Routing 2.0 forward to the mediator a DID
 * there names, the forward carrying the package's ID so that the
 * mediator tells a retry of the package from another package. What
 * goes on the wire is the envelope stored with the package, every time.
 * Before the call: the message is prepared when it still needs a
 * package, a mediated sender the peer has not written to is made to be
 * held by its mediator so that an answer has somewhere to arrive, and
 * the fold is read again under the lock, where a message submitted or
 * terminated meanwhile, one whose expiry has come, whose sender or
 * route was retired, whose channel was blocked or whose envelope is no
 * longer here is not sent. The action's one invocation is consumed in
 * the same step that invokes the transport, once the lock is released:
 * a deadline that passed while the lock was waited for finds the
 * action live and nothing called. Acceptance is committed as
 * `delivery.submitted` and closes the message; any other answer, or
 * none, is traced and nothing else: the message stays prepared, the
 * action is spent, and only a fresh manual action calls again. No
 * network wait happens under the writer lock.
 */

import { parseStrict, type Held, type VaultRuntime } from "@estoc/event-store/v3";
import {
  objectReader,
  readVaultEvent,
  scanVault,
  vaultDraft,
  type Channel,
  type Did,
  type Keys,
  type LocalDidEntity,
  type MediationId,
  type MessageId,
  type MessageOut,
  type Package,
  type PackageId,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault/v3";

import { ENCRYPTED_MIME, PLAIN_TYP, endpointOf, packEncrypted, secretsResolverFor, type IMessage } from "../protocol/didcomm.js";
import { FORWARD } from "../protocol/spec.js";
import { recordAcceptance, recordOwedAcceptance } from "./acceptance.js";
import type { LiveAction } from "./action.js";
import { UnknownEntity } from "./errors.js";
import { didcommDocumentOf } from "./evidence.js";
import { bounded, sealData, type MediatorLink } from "./link.js";
import { reconcile, registered } from "./mediation.js";
import { closedBecause, expireUnderLock, expiryPhase, hasExpired, outboundWorkKey, prepareUnderLock, scanOptions, type PrepareOptions, type Settled } from "./prepare.js";
import { serially } from "./procedure.js";
import { knownLongForms, resolve, type ResolverOptions, type Resolved } from "./resolver.js";
import { note, noteAll, type AgentTrace, type Note } from "./trace.js";

/** How long one attempt may take by default: the mediator resolved, the forward sealed and the call answered. */
export const DISPATCH_TIMEOUT_MS = 15_000;
/** The most bytes a stored envelope may run to and still be read into memory for the wire. */
export const MAX_ENVELOPE_BYTES = 128 * 1024 * 1024;

export interface DispatchOptions extends ResolverOptions, PrepareOptions {
  /**
   * The transport a package is carried over, and a `did:web` mediator
   * resolved over: the host's, under the contract `WebResolverOptions`
   * states. An endpoint is an address the peer chose, so the host's
   * policy on addresses holds for a call as for a document.
   */
  fetch: typeof fetch;
  /** The link to each mediation arrangement of this vault, or null where there is none now: what a mediated sender's registration is confirmed over. */
  links?: (mediationId: MediationId) => MediatorLink | null;
  /** how long one attempt may take, the mediator resolved, the forward sealed and the call answered; `DISPATCH_TIMEOUT_MS` when left out */
  timeoutMs?: number;
}

export type Dispatched =
  | { outcome: "submitted"; messageId: MessageId; packageId: PackageId; submitted: VaultEvent<"delivery.submitted"> }
  /** the fold asks for no call: the message is closed, in conflict, or not the sender's to send now */
  | { outcome: "none"; messageId: MessageId; because: string }
  /** nothing was called and the action is still live: a prerequisite is missing and may still come, or the attempt's deadline passed before the call */
  | { outcome: "pending"; messageId: MessageId; because: string }
  /** the expiry passed before the call: the message is terminated */
  | { outcome: "expired"; messageId: MessageId; failed: VaultEvent<"delivery.failed"> }
  /** the endpoint answered other than acceptance: traced, the action spent, the message left prepared for a manual retry */
  | { outcome: "failed"; messageId: MessageId; packageId: PackageId; reason: string }
  /** no answer came — the line cut, the deadline passed — so whether the package arrived is unknown: traced, the action spent, the message left prepared */
  | { outcome: "uncertain"; messageId: MessageId; packageId: PackageId; reason: string }
  /** the action's one invocation was used already */
  | { outcome: "spent"; messageId: MessageId };

/** The one transport call of the message under `action`, serially with every other piece of work on that message. */
export function dispatch(runtime: VaultRuntime, keys: Keys, action: LiveAction, options: DispatchOptions): Promise<Dispatched> {
  return serially(runtime, outboundWorkKey(action.messageId), () => attempt(runtime, keys, action, options));
}

async function attempt(runtime: VaultRuntime, keys: Keys, action: LiveAction, options: DispatchOptions): Promise<Dispatched> {
  const { messageId } = action;
  const trace = options.trace ?? null;
  const owed = await recordOwedAcceptance(runtime, messageId);
  if (owed !== null) return { outcome: "submitted", messageId, packageId: owed.data.packageId, submitted: owed };
  if (action.spent) return { outcome: "spent", messageId };
  const readied = await runtime.locked((held) => ready(held, keys, messageId, options));
  await noteAll(trace, readied.notes);
  if ("outcome" in readied.result) return readied.result;
  const { fold, pkg, envelope, service, registerWith } = readied.result;
  const { packageId } = pkg.event.data;
  const pending = async (phase: string, reason: string): Promise<Dispatched> => {
    await note(trace, { stream: "diag", what: "delivery", data: { messageId, packageId, phase, reason } });
    return { outcome: "pending", messageId, because: reason };
  };
  if (registerWith !== null) {
    const unregistered = await confirmRegistration(runtime, keys, registerWith, options);
    if (unregistered !== null) return pending("register", unregistered);
  }
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DISPATCH_TIMEOUT_MS);
  const carried = await carry(fold, pkg, envelope, service, options, deadline);
  if ("because" in carried) return { outcome: "none", messageId, because: carried.because };
  if ("reason" in carried) return pending("route", carried.reason);
  const rechecked = await runtime.locked((held) => recheck(held, keys, action, packageId, options));
  await noteAll(trace, rechecked.notes);
  if (rechecked.result !== null) return rechecked.result;
  const answer = await call(options.fetch, carried, deadline, action);
  if ("uncalled" in answer) return answer.uncalled === "spent" ? { outcome: "spent", messageId } : pending("call", "the deadline passed before the call");
  await noteAttempt(trace, messageId, packageId, carried, answer);
  if ("status" in answer && answer.status >= 200 && answer.status < 300) {
    const submitted = await recordAcceptance(runtime, messageId, packageId);
    return { outcome: "submitted", messageId, packageId, submitted };
  }
  if ("status" in answer) return { outcome: "failed", messageId, packageId, reason: `the endpoint answered ${answer.status}` };
  return { outcome: "uncertain", messageId, packageId, reason: answer.error };
}

/** What the wire needs of a message the fold says is ready for its call. */
interface Ready {
  fold: VaultFold;
  pkg: Package;
  envelope: string;
  /** the DIDComm service the recipient's resolved document names */
  service: string | null;
  /** a mediated sender the peer has not written to yet, to be held by its mediator before the call */
  registerWith: { mediationId: MediationId; did: Did } | null;
}

/**
 * Under the lock: the message prepared when it still needs a package,
 * then what its one package needs for the wire read off the fold and
 * the object store. Expiry is observed first, before whatever else
 * holds the message up.
 */
async function ready(held: Held, keys: Keys, messageId: MessageId, options: DispatchOptions): Promise<Settled<Dispatched | Ready>> {
  const notes: Note[] = [];
  const done = (result: Dispatched): Settled<Dispatched | Ready> => ({ result, notes });
  let fold = await scanVault(held, keys, scanOptions(options));
  let outbound = fold.outbound.outbounds.get(messageId);
  if (outbound === undefined) throw new UnknownEntity("message", messageId);
  const closed = closedBecause(outbound);
  if (closed !== null) return done({ outcome: "none", messageId, because: closed });
  const intent = (outbound.intent as { data: MessageOut }).data;
  if (hasExpired(intent, options.now ?? Date.now)) return expireUnderLock(held, messageId, expiryPhase(outbound));
  if (outbound.work.kind === "prepare") {
    const prepared = await prepareUnderLock(held, keys, messageId, options);
    notes.push(...prepared.notes);
    const { result } = prepared;
    if (result.outcome === "none" || result.outcome === "pending" || result.outcome === "expired") return done(result);
    fold = await scanVault(held, keys, scanOptions(options));
    outbound = fold.outbound.outbounds.get(messageId)!;
  }
  const { work } = outbound;
  if (work.kind === "none") return done({ outcome: "none", messageId, because: work.because });
  if (work.kind === "prepare") return done({ outcome: "pending", messageId, because: "no package is prepared" });
  const pkg = work.package;
  const resolved = fold.set.resolve(pkg.event.data.peerResolutionEventId, "peer.resolved");
  if (resolved.status !== "present") return done({ outcome: "pending", messageId, because: "the resolution the package names is not here" });
  const bytes = await objectReader(held.objects, MAX_ENVELOPE_BYTES)(pkg.event.data.envelopeCid);
  if (bytes === null) return done({ outcome: "pending", messageId, because: `the envelope ${pkg.event.data.envelopeCid} is not here` });
  const registerWith = unconfirmedMediatedSender(fold, outbound.sender as LocalDidEntity, outbound.channel as Channel);
  return { result: { fold, pkg, envelope: new TextDecoder().decode(bytes), service: resolved.event.data.service, registerWith }, notes };
}

/**
 * A mediated sender's address is to be held by its mediator before a
 * package discloses it. Until the peer has written to the address, the
 * peer may be learning it from this package, and an answer to an
 * address the mediator does not hold is lost. A direct sender needs no
 * mediator.
 */
function unconfirmedMediatedSender(fold: VaultFold, sender: LocalDidEntity, channel: Channel): Ready["registerWith"] {
  const created = sender.created as NonNullable<LocalDidEntity["created"]>;
  const route = fold.routes.routes.get(created.boundRouteId)?.configured;
  if (route === undefined || route === null || route.kind !== "mediated") return null;
  if (fold.continuity.confirmed(channel.localDid, channel.peerDid)) return null;
  return { mediationId: route.mediationId, did: created.did };
}

/** Reconciling registers what the vault wants held; why the sender is not held after that, or null once it is. */
async function confirmRegistration(runtime: VaultRuntime, keys: Keys, { mediationId, did }: NonNullable<Ready["registerWith"]>, options: DispatchOptions): Promise<string | null> {
  const link = options.links?.(mediationId) ?? null;
  if (link === null) return `no link to the mediator of ${mediationId}, which is to hold ${did} before a package discloses it`;
  try {
    return registered(await reconcile(link, runtime, keys, mediationId), did) ? null : `the mediator of ${mediationId} does not hold ${did}`;
  } catch (err) {
    return `the mediator of ${mediationId} could not be asked to hold ${did}: ${messageOf(err)}`;
  }
}

/**
 * Under the lock again, right before the call: the message must still
 * be open with its expiry to come, the fold must still say the same
 * package is what it needs, and the action must still carry its
 * invocation. Null when the call may go ahead; the invocation is
 * consumed at the call itself, not here, so that a deadline passed
 * while this lock was waited for costs the action nothing.
 */
async function recheck(held: Held, keys: Keys, action: LiveAction, packageId: PackageId, options: DispatchOptions): Promise<Settled<Dispatched | null>> {
  const { messageId } = action;
  const outbound = (await scanVault(held, keys, scanOptions(options))).outbound.outbounds.get(messageId)!;
  const closed = closedBecause(outbound);
  if (closed !== null) return { result: { outcome: "none", messageId, because: closed }, notes: [] };
  if (hasExpired((outbound.intent as { data: MessageOut }).data, options.now ?? Date.now)) return expireUnderLock(held, messageId, expiryPhase(outbound));
  const { work } = outbound;
  if (work.kind === "none") return { result: { outcome: "none", messageId, because: work.because }, notes: [] };
  if (work.kind === "prepare") return { result: { outcome: "pending", messageId, because: "the package is no longer here" }, notes: [] };
  if (work.package.event.data.packageId !== packageId) return { result: { outcome: "none", messageId, because: `the package is now ${work.package.event.data.packageId}` }, notes: [] };
  if (action.spent) return { result: { outcome: "spent", messageId }, notes: [] };
  return { result: null, notes: [] };
}

/** What goes on the wire and where: the envelope itself, or the forward sealed around it. */
interface Carried {
  endpoint: string;
  body: string;
  forward: { packed: string; message: IMessage } | null;
}

/**
 * To a direct endpoint, the envelope itself. To a mediator, a forward
 * whose ID is the package's and whose `next` is the package's
 * recipient, carrying the envelope as JSON, sealed anonymously to the
 * mediator's key-agreement key and carried to its HTTP endpoint. The
 * mediator's document is resolved for this attempt alone: it is how
 * the package travels, not evidence about the peer.
 */
async function carry(fold: VaultFold, pkg: Package, envelope: string, service: string | null, options: DispatchOptions, deadline: AbortSignal): Promise<Carried | { because: string } | { reason: string }> {
  const hop = hopOf(service);
  if (hop === null) return { because: service === null ? "the recipient's document names no DIDComm service" : `the recipient's service ${service} is nothing this runtime carries to` };
  if (hop.kind === "direct") return { endpoint: hop.endpoint, body: envelope, forward: null };
  const { routingDid } = hop;
  let answer: Resolved;
  try {
    answer = await bounded(deadline, () => resolve(routingDid, knownLongForms(fold), options));
  } catch (err) {
    return { reason: `the mediator ${routingDid} did not resolve in time: ${messageOf(err)}` };
  }
  if (answer.outcome === "unavailable") return { reason: `the mediator ${routingDid} did not resolve now: ${answer.reason}` };
  if (answer.outcome === "definitive") return { because: `the mediator ${routingDid} does not resolve: ${answer.reason}` };
  const document = didcommDocumentOf(answer.resolution);
  const endpoint = endpointOf(document, "http");
  if (endpoint === null) return { because: `the mediator ${routingDid} names no HTTP endpoint` };
  const message = {
    id: pkg.event.data.packageId,
    typ: PLAIN_TYP,
    type: FORWARD,
    to: [routingDid],
    body: { next: pkg.event.data.recipientDid },
    attachments: [{ media_type: ENCRYPTED_MIME, data: { json: parseStrict(envelope) } }],
  } as unknown as IMessage;
  const resolver = { resolve: async (did: string) => (did === routingDid ? document : null) };
  try {
    const [packed] = await bounded(deadline, () => packEncrypted(options.didcomm, message, routingDid, null, null, resolver, secretsResolverFor([]), { forward: false }));
    return { endpoint, body: packed, forward: { packed, message } };
  } catch (err) {
    if (deadline.aborted) return { reason: `the forward to ${routingDid} was not sealed in time` };
    return { because: `the forward to ${routingDid} cannot be sealed: ${messageOf(err)}` };
  }
}

type Hop = { kind: "direct"; endpoint: string } | { kind: "forward"; routingDid: Did };

/** The service a resolution names, as a hop a call can take: an HTTP endpoint, or a DID whose mediator takes a forward; null for anything else. */
function hopOf(service: string | null): Hop | null {
  if (service === null) return null;
  if (service.startsWith("did:")) return { kind: "forward", routingDid: service as Did };
  try {
    const { protocol } = new URL(service);
    return protocol === "https:" || protocol === "http:" ? { kind: "direct", endpoint: service } : null;
  } catch {
    return null;
  }
}

type Answer = { status: number; ms: number } | { error: string; ms: number };
/** nothing was called: the deadline had passed, or the action had been spent, when the call was about to be made */
type Uncalled = { uncalled: "deadline" | "spent" };

/**
 * The body carried as an encrypted DIDComm message, following no
 * redirect and answered from no cache. The status is the answer; the
 * body is not read. The action's invocation is consumed in the same
 * synchronous step that invokes `fetch`, after the deadline is looked
 * at: a deadline passed before this point has cost nothing, and one
 * passing from here on is a call whose outcome is unknown.
 */
async function call(fetch: typeof globalThis.fetch, { endpoint, body }: Carried, deadline: AbortSignal, action: LiveAction): Promise<Answer | Uncalled> {
  if (deadline.aborted) return { uncalled: "deadline" };
  if (!action.consume()) return { uncalled: "spent" };
  const started = Date.now();
  try {
    const response = await bounded(deadline, () => fetch(endpoint, { method: "POST", headers: { "Content-Type": ENCRYPTED_MIME }, body, redirect: "manual", cache: "no-store", signal: deadline }));
    void response.body?.cancel().catch(() => undefined);
    return { status: response.status, ms: Date.now() - started };
  } catch (err) {
    return { error: messageOf(err), ms: Date.now() - started };
  }
}

/** The call as the trace keeps it: the frame out, the forward sealed inside it when there was one, and the answer or the failure hung on the frame. */
async function noteAttempt(trace: AgentTrace | null, messageId: MessageId, packageId: PackageId, carried: Carried, answer: Answer): Promise<void> {
  if (trace === null) return;
  const out = await note(trace, { stream: "wire", what: "out", data: { via: "http", endpoint: carried.endpoint, bytes: new TextEncoder().encode(carried.body).length, messageId, packageId } });
  if (trace.enabled("bytes")) await note(trace, { stream: "bytes", what: "out", data: { parent: out, body: carried.body } });
  if (carried.forward !== null) await note(trace, { stream: "envelope", what: "seal", data: { ...sealData(carried.forward.packed, carried.forward.message), parent: out, messageId, packageId } });
  await note(trace, "status" in answer ? { stream: "wire", what: "in", data: { via: "http", parent: out, status: answer.status, ms: answer.ms } } : { stream: "wire", what: "error", data: { via: "http", parent: out, ms: answer.ms, error: answer.error } });
}

export type Cancelled =
  | { outcome: "cancelled"; messageId: MessageId; failed: VaultEvent<"delivery.failed"> }
  /** nothing to cancel: the message is submitted, terminated already, or its intent is in conflict */
  | { outcome: "none"; messageId: MessageId; because: string };

/**
 * `delivery.failed` with code `cancelled` for an unsubmitted message,
 * serially with its dispatch and under the lock, so that a call in
 * flight is either recorded first or finds the message terminated. A
 * cancellation claims nothing about delivery: a call whose outcome was
 * unknown may have arrived. The content stays; the envelope is
 * released.
 */
export function cancel(runtime: VaultRuntime, keys: Keys, messageId: MessageId, options: { trace?: AgentTrace } = {}): Promise<Cancelled> {
  return serially(runtime, outboundWorkKey(messageId), async () => {
    const owed = await recordOwedAcceptance(runtime, messageId);
    if (owed !== null) return { outcome: "none", messageId, because: "submitted" };
    const result = await runtime.locked(async (held): Promise<Cancelled> => {
      const outbound = (await scanVault(held, keys)).outbound.outbounds.get(messageId);
      if (outbound === undefined) throw new UnknownEntity("message", messageId);
      const closed = closedBecause(outbound);
      if (closed !== null) return { outcome: "none", messageId, because: closed };
      const [event] = (await held.commit([], [vaultDraft("delivery.failed", { messageId, code: "cancelled" })])).map(readVaultEvent);
      return { outcome: "cancelled", messageId, failed: event as VaultEvent<"delivery.failed"> };
    });
    if (result.outcome === "cancelled") await note(options.trace ?? null, { stream: "diag", what: "delivery", data: { messageId, code: "cancelled", reason: "cancelled by the user" } });
    return result;
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
