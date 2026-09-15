/**
 * Submitting puts a prepared package on the wire and records that the
 * wire took it. The package goes where the resolution it names says the
 * peer receives: straight to an HTTP endpoint, or inside a Routing 2.0
 * forward to the mediator a DID there names, the forward carrying the
 * package's ID so that the mediator tells a retry of the package from
 * another package. What is posted is the envelope stored with the
 * package, every time. An acceptance is committed as
 * `delivery.submitted` before the message is worked on again, and closes
 * the message; a failure that may pass is traced and nothing else, the
 * message left as it was for the next attempt. Before a package
 * discloses a mediated sender the peer has not reached yet, the sender's
 * mediator is made to hold it, so that an answer has somewhere to
 * arrive. No network wait happens under the writer lock, and the fold
 * is read again right before the post: a package retired, or a message
 * submitted or failed meanwhile, is not posted.
 */

import { DamagedObject, ObjectTooLarge, parseStrict, type VaultRuntime } from "@estoc/event-store/v3";
import {
  readVaultEvent,
  scanVault,
  vaultDraft,
  type Cid,
  type Did,
  type Keys,
  type MediationId,
  type MessageId,
  type MessageOut,
  type Outbound,
  type Package,
  type PackageId,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault/v3";

import { ENCRYPTED_MIME, PLAIN_TYP, endpointOf, packEncrypted, secretsResolverFor, type DidcommApi, type IMessage } from "../protocol/didcomm.js";
import { FORWARD } from "../protocol/spec.js";
import { recordAcceptance, recordOwedAcceptance } from "./acceptance.js";
import { UnknownEntity } from "./errors.js";
import { didcommDocumentOf } from "./evidence.js";
import { bounded, sealData, type MediatorLink } from "./link.js";
import { reconcile, registered } from "./mediation.js";
import { EXPIRED, confirmedKeyNames, hasExpired, outboundWorkKey } from "./prepare.js";
import { serially } from "./procedure.js";
import { knownLongForms, resolve, type Resolved, type ResolverOptions } from "./resolver.js";
import { note, type AgentTrace } from "./trace.js";

/** How long one attempt may take by default: the mediator resolved, the forward sealed and the post answered. */
export const SUBMIT_TIMEOUT_MS = 15_000;
/** The most bytes a stored envelope may run to and still be read into memory to be posted. */
export const MAX_ENVELOPE_BYTES = 128 * 1024 * 1024;

/** How many times the fold may change between choosing a package and posting it before the attempt is left for later. */
const MOST_CHOICES = 3;

export interface SubmitOptions extends ResolverOptions {
  didcomm: DidcommApi;
  /**
   * The transport a package is posted over, and a `did:web` mediator
   * resolved over: the host's, under the contract `WebResolverOptions`
   * states. An endpoint is an address the peer chose, so the host's
   * policy on addresses holds for a post as for a document.
   */
  fetch: typeof fetch;
  /** The line to each mediation arrangement of this vault, or null where there is none now: what a mediated sender's registration is confirmed over. */
  links?: (mediationId: MediationId) => MediatorLink | null;
  /** the clock expiry is compared with, in milliseconds since the epoch; `Date.now` when left out */
  now?: () => number;
  /** how long one attempt may take, the mediator resolved, the forward sealed and the post answered; `SUBMIT_TIMEOUT_MS` when left out */
  submitTimeoutMs?: number;
  /** told just before each post, whatever comes of it: where a retry budget is counted */
  beforePost?: () => void;
}

export type Submitted =
  | { outcome: "submitted"; messageId: MessageId; packageId: PackageId; submitted: VaultEvent<"delivery.submitted"> }
  /** nothing to post: the message is closed, has no package ready, or cannot be posted until the vault changes */
  | { outcome: "none"; messageId: MessageId; because: string }
  /** an attempt that may succeed later, traced and not recorded: the message stays as it was */
  | { outcome: "retry"; messageId: MessageId; packageId: PackageId | null; reason: string }
  /** the expiry passed before submission, and the terminal failure was recorded */
  | { outcome: "failed"; messageId: MessageId; code: string; failed: VaultEvent<"delivery.failed"> };

/**
 * Submit the package a prepared outbound is ready to send, from the fold
 * as it stands: post it and, once it is accepted, commit
 * `delivery.submitted`. Of several submittable packages, the first in
 * canonical order that can be posted is. An expiry that has passed
 * fails the message for good instead. One message is prepared or
 * submitted by one caller at a time.
 */
export function submit(runtime: VaultRuntime, keys: Keys, messageId: MessageId, options: SubmitOptions): Promise<Submitted> {
  return serially(runtime, outboundWorkKey(messageId), () => submitInTurn(runtime, keys, messageId, options));
}

type Open = { outbound: Outbound; intent: MessageOut; packageIds: readonly PackageId[] };

type Hop = { kind: "direct"; endpoint: string } | { kind: "forward"; routingDid: Did };

type Chosen = { pkg: Package; envelope: Uint8Array; hop: Hop };

/** What goes on the wire and where: the envelope itself, or the forward sealed around it. */
type Carried = { endpoint: string; body: string; forward: { packed: string; message: IMessage } | null };

type Answer = { status: number; ms: number } | { error: string; ms: number };

async function submitInTurn(runtime: VaultRuntime, keys: Keys, messageId: MessageId, options: SubmitOptions): Promise<Submitted> {
  const now = options.now ?? Date.now;
  const trace = options.trace ?? null;
  const none = (because: string): Submitted => ({ outcome: "none", messageId, because });
  const retry = async (packageId: PackageId | null, phase: string, reason: string): Promise<Submitted> => {
    await note(trace, { stream: "diag", what: "delivery", data: { messageId, packageId: packageId ?? undefined, phase, reason } });
    return { outcome: "retry", messageId, packageId, reason };
  };
  const owed = await recordOwedAcceptance(runtime, messageId);
  if (owed !== null) return { outcome: "submitted", messageId, packageId: owed.data.packageId, submitted: owed };
  for (let choice = 1; ; choice++) {
    const fold = await scanVault(runtime.vault, keys);
    const open = openPackages(fold, messageId);
    if ("because" in open) return none(open.because);
    if (hasExpired(open.intent, now)) return expire(runtime, keys, messageId, trace);
    if (choice > MOST_CHOICES) return retry(null, "post", `the message changed under each of ${MOST_CHOICES} attempts to post it`);
    const chosen = await choose(runtime, fold, open);
    if ("because" in chosen) return none(chosen.because);
    const { packageId } = chosen.pkg;
    const registration = await confirmRegistration(runtime, keys, fold, open.intent, chosen.pkg, options);
    if (registration !== null) return "because" in registration ? none(registration.because) : retry(packageId, "register", registration.reason);
    const deadline = AbortSignal.timeout(options.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS);
    const carried = await carry(fold, chosen, options, deadline);
    if ("because" in carried) return none(carried.because);
    if ("reason" in carried) return retry(packageId, "route", carried.reason);
    const again = openPackages(await scanVault(runtime.vault, keys), messageId);
    if ("because" in again || !again.packageIds.includes(packageId) || hasExpired(again.intent, now)) continue;
    options.beforePost?.();
    const answer = await post(options.fetch, carried, deadline);
    if ("status" in answer && answer.status >= 200 && answer.status < 300) {
      try {
        const submitted = await recordAcceptance(runtime, messageId, packageId);
        return { outcome: "submitted", messageId, packageId, submitted };
      } finally {
        await noteAttempt(trace, messageId, packageId, carried, answer);
      }
    }
    await noteAttempt(trace, messageId, packageId, carried, answer);
    return retry(packageId, "post", "status" in answer ? `the endpoint answered ${answer.status}` : answer.error);
  }
}

function openPackages(fold: VaultFold, messageId: MessageId): Open | { because: string } {
  const outbound = fold.outbound.outbounds.get(messageId);
  if (outbound === undefined) throw new UnknownEntity("message", messageId);
  const { work } = outbound;
  if (work.kind === "none") return { because: work.because };
  if (work.kind === "prepare") return { because: "no package is prepared" };
  if (work.kind === "repack") return { because: `package ${work.packageIds.join(", ")} awaits a repack` };
  return { outbound, intent: outbound.intent as MessageOut, packageIds: work.packageIds };
}

/** The expired failure, under the lock over the fold read again: a message submitted or failed meanwhile is left as it is. */
async function expire(runtime: VaultRuntime, keys: Keys, messageId: MessageId, trace: AgentTrace | null): Promise<Submitted> {
  const result = await runtime.locked(async (held): Promise<Submitted> => {
    const outbound = (await scanVault(held, keys)).outbound.outbounds.get(messageId) as Outbound;
    if (outbound.submitted) return { outcome: "none", messageId, because: "submitted" };
    if (outbound.failed !== null) return { outcome: "none", messageId, because: `terminal failure: ${outbound.failed}` };
    const [event] = (await held.commit([], [vaultDraft("delivery.failed", { messageId, scope: "message", packageId: null, code: EXPIRED })])).map(readVaultEvent);
    return { outcome: "failed", messageId, code: EXPIRED, failed: event as VaultEvent<"delivery.failed"> };
  });
  if (result.outcome === "failed") await note(trace, { stream: "diag", what: "delivery", data: { messageId, code: EXPIRED, reason: "the expiry passed before submission" } });
  return result;
}

/** The service a resolution names, as a hop a post can take: an HTTP endpoint, or a DID whose mediator takes a forward; null for anything else. */
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

/** The first of the submittable packages whose resolution names a hop and whose envelope is here; the reasons each was passed over, when none is. */
async function choose(runtime: VaultRuntime, fold: VaultFold, open: Open): Promise<Chosen | { because: string }> {
  const passed: string[] = [];
  for (const packageId of open.packageIds) {
    const pkg = open.outbound.packages.get(packageId) as Package;
    const named = fold.set.resolve(pkg.data.peerResolutionEventId, "peer.resolved");
    if (named.status !== "present") {
      passed.push(`package ${packageId} names the resolution ${pkg.data.peerResolutionEventId}, which is not here`);
      continue;
    }
    const { service } = named.event.data;
    const hop = hopOf(service);
    if (hop === null) {
      passed.push(service === null ? `package ${packageId} is to a document that names no DIDComm service` : `package ${packageId} is to ${service}, which nothing here posts to`);
      continue;
    }
    const envelope = await readEnvelope(runtime, pkg.data.envelopeCid);
    if (envelope === null) {
      passed.push(`the envelope ${pkg.data.envelopeCid} of package ${packageId} is not here`);
      continue;
    }
    return { pkg, envelope, hop };
  }
  return { because: passed.join("; ") };
}

/** A damaged envelope, or one too large to post, is one that is not here to post. */
async function readEnvelope(runtime: VaultRuntime, cid: Cid): Promise<Uint8Array | null> {
  try {
    return await runtime.vault.objects.read(cid, MAX_ENVELOPE_BYTES);
  } catch (err) {
    if (err instanceof DamagedObject || err instanceof ObjectTooLarge) return null;
    throw err;
  }
}

/**
 * A mediated sender's address is to be held by its mediator before a
 * package discloses it. Until input from the peer has arrived at one of
 * the sender's keys in this relationship, the peer may be learning the
 * address from this package, and an answer to an address the mediator
 * does not hold is lost. Reconciling registers what the vault wants
 * held; a sender the mediator then does not hold is not posted from
 * yet. A direct sender needs no mediator.
 */
async function confirmRegistration(runtime: VaultRuntime, keys: Keys, fold: VaultFold, intent: MessageOut, pkg: Package, options: SubmitOptions): Promise<{ because: string } | { reason: string } | null> {
  const sender = fold.routes.dids.get(pkg.data.senderDidId);
  if (sender === undefined || sender.created === null) return { because: `the sender ${pkg.data.senderDidId} of package ${pkg.packageId} is not here` };
  const route = fold.routes.routes.get(sender.created.boundRouteId)?.configured;
  if (route === undefined || route === null || route.kind !== "mediated") return null;
  const confirmed = confirmedKeyNames(fold, intent.relationshipId);
  if (confirmed.has(sender.keyNames.keyAgreement) || confirmed.has(sender.keyNames.authentication)) return null;
  const mediationId = route.mediationId as MediationId;
  const { did } = sender.created;
  const link = options.links?.(mediationId) ?? null;
  if (link === null) return { because: `no line to the mediator of ${mediationId}, which is to hold ${did} before a package discloses it` };
  try {
    return registered(await reconcile(link, runtime, keys, mediationId), did) ? null : { reason: `the mediator of ${mediationId} does not hold ${did}` };
  } catch (err) {
    return { reason: `the mediator of ${mediationId} could not be asked to hold ${did}: ${messageOf(err)}` };
  }
}

/**
 * What goes on the wire for the chosen package, and where. To a direct
 * endpoint, the envelope itself. To a mediator, a forward whose ID is
 * the package's and whose `next` is the package's recipient, carrying
 * the envelope as JSON, sealed anonymously to the mediator's
 * key-agreement keys and posted to its HTTP endpoint. The mediator's
 * document is resolved for this attempt alone: it is how the package
 * travels, not evidence about the peer.
 */
async function carry(fold: VaultFold, { pkg, envelope, hop }: Chosen, options: SubmitOptions, deadline: AbortSignal): Promise<Carried | { because: string } | { reason: string }> {
  const text = new TextDecoder().decode(envelope);
  if (hop.kind === "direct") return { endpoint: hop.endpoint, body: text, forward: null };
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
    id: pkg.packageId,
    typ: PLAIN_TYP,
    type: FORWARD,
    to: [routingDid],
    body: { next: pkg.data.recipientDid },
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

/** The body posted as an encrypted DIDComm message, following no redirect and answered from no cache. The status is the answer; the body is not read. */
async function post(fetch: typeof globalThis.fetch, { endpoint, body }: Carried, deadline: AbortSignal): Promise<Answer> {
  const started = Date.now();
  try {
    const response = await bounded(deadline, () => fetch(endpoint, { method: "POST", headers: { "Content-Type": ENCRYPTED_MIME }, body, redirect: "manual", cache: "no-store", signal: deadline }));
    void response.body?.cancel().catch(() => undefined);
    return { status: response.status, ms: Date.now() - started };
  } catch (err) {
    return { error: messageOf(err), ms: Date.now() - started };
  }
}

/** The post as the trace keeps it: the frame out, the forward sealed inside it when there was one, and the answer or the failure hung on the frame. */
async function noteAttempt(trace: AgentTrace | null, messageId: MessageId, packageId: PackageId, carried: Carried, answer: Answer): Promise<void> {
  if (trace === null) return;
  const out = await note(trace, { stream: "wire", what: "out", data: { via: "http", endpoint: carried.endpoint, bytes: new TextEncoder().encode(carried.body).length, messageId, packageId } });
  if (trace.enabled("bytes")) await note(trace, { stream: "bytes", what: "out", data: { parent: out, body: carried.body } });
  if (carried.forward !== null) await note(trace, { stream: "envelope", what: "seal", data: { ...sealData(carried.forward.packed, carried.forward.message), parent: out, messageId, packageId } });
  await note(trace, "status" in answer ? { stream: "wire", what: "in", data: { via: "http", parent: out, status: answer.status, ms: answer.ms } } : { stream: "wire", what: "error", data: { via: "http", parent: out, ms: answer.ms, error: answer.error } });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
