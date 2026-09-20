/**
 * The receipt: an authenticated delivery recorded in the vault as one
 * observation, or told why it may not be. What the gate authenticated
 * is recorded as it is — the sender's document the vault held, the
 * plaintext taken apart into its stored content and its headers, the
 * rotation proof as the string it came as — and nothing about the
 * peer is looked up: no contact, no invitation, no continuity. Those
 * read the observation afterwards. Everything is decided under the
 * writer lock over the fold read there: the recipient is checked
 * again, the resolution evidence is committed or reused, then the
 * observation is committed with its objects, naming that evidence by
 * the ID its commit returned and taking the next receipt ordinal. Each
 * delivery is its own observation with its own ordinal, a message
 * delivered again included; the fold groups observations of one input.
 * Whether the vault already held one of the same input is read under
 * that lock too, and told with the record: only the first observation
 * of an input may earn automatic work, whichever runtime recorded the
 * others and whatever became of it.
 */

import { v7 as uuidv7 } from "uuid";

import type { Held, VaultRuntime } from "@estoc/event-store/v3";
import {
  InvalidPayload,
  InvalidPlaintext,
  anonymousMessageId,
  inboundMessageId,
  readPlaintext,
  readVaultEvent,
  scanVault,
  vaultDraft,
  type Cid,
  type DeliveryId,
  type EventReference,
  type Keys,
  type MessageIn,
  type ReadPlaintext,
  type ReceiptOrdinal,
  type VaultEvent,
  type WireMessageId,
} from "@estoc/vault/v3";

import { commitResolution } from "../evidence.js";
import { MAX_CONTENT_BYTES } from "../prepare.js";
import { recipientWatch, type Authenticated, type Receipt, type ReceiptOutcome } from "./receiver.js";

export function receiptOf(runtime: VaultRuntime, keys: Keys): Receipt {
  return (authenticated) => recordReceipt(runtime, keys, authenticated);
}

type Observed = Omit<MessageIn, "receiptOrdinal" | "peerResolutionEventId">;

type Objects = { cid: Cid; source: Uint8Array }[];

const terminal = (reason: string): ReceiptOutcome => ({ outcome: "terminal", reason });

/**
 * Record one authenticated delivery, or say why not: terminal when the
 * vault may never record it, deferred when its recipient lacks
 * something recoverable of this runtime's. A record the vault refuses
 * for any other reason throws, and the delivery comes again.
 */
export async function recordReceipt(runtime: VaultRuntime, keys: Keys, authenticated: Authenticated): Promise<ReceiptOutcome> {
  const read = readOrRefuse(authenticated);
  if ("outcome" in read) return read;
  const observed = observationOf(authenticated, read);
  const refused = unrecordable(observed, authenticated.sender !== null);
  if (refused !== null) return terminal(refused);
  const { stored } = read;
  const objects: Objects = [{ cid: stored.bodyCid, source: stored.bytes }, ...stored.payloads.map(({ cid, bytes }) => ({ cid, source: bytes }))];
  return runtime.locked((held) => settle(held, keys, authenticated, observed, objects));
}

/**
 * The plaintext taken apart, or why it is not one the vault records: it
 * does not read as a vault plaintext, its content is past what a
 * message may carry, or it carries a rotation proof under an anonymous
 * seal, which authenticates no one the proof could be about.
 */
function readOrRefuse({ plaintext, sender }: Authenticated): ReadPlaintext | ReceiptOutcome {
  let read: ReadPlaintext;
  try {
    read = readPlaintext(plaintext);
  } catch (err) {
    if (err instanceof InvalidPlaintext) return terminal(`the plaintext does not read: ${err.message}`);
    throw err;
  }
  if (read.fromPrior !== null && sender === null) return terminal("the envelope is anonymous, but its plaintext carries a from_prior");
  const { stored } = read;
  if (stored.bytes.length > MAX_CONTENT_BYTES) return terminal(`the body is ${stored.bytes.length} bytes, past the ${MAX_CONTENT_BYTES} a message may carry`);
  const large = stored.payloads.find(({ bytes }) => bytes.length > MAX_CONTENT_BYTES);
  if (large !== undefined) return terminal(`the attachment ${large.cid} is ${large.bytes.length} bytes, past the ${MAX_CONTENT_BYTES} a message may carry`);
  return read;
}

function observationOf({ recipient, sender, delivery }: Authenticated, read: ReadPlaintext): Observed {
  const { intent, stored } = read;
  const wireMessageId = intent.id as WireMessageId;
  const { source } = delivery;
  return {
    messageId: sender === null ? anonymousMessageId(recipient.localKeyName, wireMessageId) : inboundMessageId(sender.resolution.did, recipient.did, wireMessageId),
    wireMessageId,
    intentHash: read.intentHash,
    plaintextHash: read.plaintextHash,
    localKeyName: recipient.localKeyName,
    msgType: intent.type,
    presentedDid: sender?.resolution.presentedDid ?? null,
    did: sender?.resolution.did ?? null,
    thid: intent.thid,
    pthid: intent.pthid,
    createdTime: intent.createdTime,
    expiresTime: intent.expiresTime,
    pleaseAck: intent.pleaseAck,
    ack: intent.ack,
    headers: intent.headers,
    fromPrior: read.fromPrior,
    bodyCid: stored.bodyCid,
    attachmentCids: stored.attachmentCids,
    bytes: stored.bytes.length,
    receivedVia: source.kind === "pickup" ? { mediationId: source.mediationId, deliveryId: source.deliveryId as DeliveryId } : { mediationId: null, deliveryId: null },
  };
}

/**
 * Why the vault would refuse the observation, asked before anything is
 * committed: input refused at its last commit must not leave evidence
 * behind it, and must not come again for a refusal that never changes.
 * The ordinal and the event reference are not known yet; placeholders
 * of their kind stand in, since only their shape is checked.
 */
function unrecordable(observed: Observed, authenticated: boolean): string | null {
  try {
    vaultDraft("message.in", { ...observed, receiptOrdinal: "1" as ReceiptOrdinal, peerResolutionEventId: authenticated ? (uuidv7() as EventReference<"peer.resolved">) : null });
    return null;
  } catch (err) {
    if (err instanceof InvalidPayload) return `the message does not record: ${err.message}`;
    throw err;
  }
}

async function settle(held: Held, keys: Keys, { recipient, sender }: Authenticated, observed: Observed, objects: Objects): Promise<ReceiptOutcome> {
  const fold = await scanVault(held, keys);
  switch (fold.routes.receipt(recipient.didId)) {
    case "terminal":
      return terminal(`${recipient.did} may no longer receive`);
    case "pending":
      return { outcome: "deferred", reason: `${recipient.did} may not receive yet: ${fold.routes.dids.get(recipient.didId)?.faults.join("; ")}`, watch: recipientWatch([recipient.didId]) };
  }
  const first = !fold.set.of("message.in").some((event) => event.data.messageId === observed.messageId);
  const receiptOrdinal = String(fold.channels.receipts.nextReceiptOrdinal) as ReceiptOrdinal;
  const resolved = sender === null ? null : await commitResolution(held, { resolution: sender.resolution, localKeyName: recipient.localKeyName, peerPublicKey: sender.peerPublicKey });
  const [event] = (await held.commit(objects, [vaultDraft("message.in", { ...observed, receiptOrdinal, peerResolutionEventId: (resolved?.eventId ?? null) as EventReference<"peer.resolved"> | null })])).map(readVaultEvent);
  return { outcome: "received", eventId: (event as VaultEvent<"message.in">).eventId as EventReference<"message.in">, first };
}
