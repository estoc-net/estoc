/**
 * A peer's acknowledgement is an application message of its own,
 * recorded as an observation like any other. What its `ack` earns is
 * read off the fold, which already tells, for every outbound with its
 * one package, the complete witnesses in its channel or in a verified
 * role-preserving successor of it whose `ack` names the message. Each
 * such witness is repeated here as one `delivery.acknowledged`, so
 * that the peer's receipt travels with the outbound as evidence of
 * its own instead of being a projection over inbound rows: once per
 * witness's local key, peer key, message and wire ID, and never again
 * for the same. The record says the peer received the message and
 * nothing more; it neither marks the message submitted nor authorizes
 * another transport call. A witness that earns its record only later,
 * once the package or the path to its channel is here, is owed it at
 * every pass over the fold, an open's included.
 */

import type { VaultRuntime } from "@estoc/event-store";
import { vaultDraft, type Keys, type VaultData, type VaultDraft, type VaultEvent, type VaultFold } from "@estoc/vault";

import { decide } from "../procedure.js";

/** The acknowledgements the complete witnesses earn and no record repeats yet, in message order, then first-receipt order. */
export function acknowledgementDrafts(fold: VaultFold): VaultDraft<"delivery.acknowledged">[] {
  const drafts: VaultDraft<"delivery.acknowledged">[] = [];
  const outbounds = [...fold.outbound.outbounds.values()].sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
  for (const outbound of outbounds) {
    const recorded = new Set(outbound.acknowledgements.map(({ event }) => witnessKey(event.data)));
    for (const { source } of outbound.ackWitnesses) {
      const data: VaultData["delivery.acknowledged"] = {
        messageId: outbound.messageId,
        localKeyName: source.event.data.localKeyName,
        peerPublicKey: source.resolution!.data.peerPublicKey,
        ackMessageId: source.event.data.messageId,
        ackWireMessageId: source.event.data.wireMessageId,
      };
      const key = witnessKey(data);
      if (recorded.has(key)) continue;
      recorded.add(key);
      drafts.push(vaultDraft("delivery.acknowledged", data));
    }
  }
  return drafts;
}

/** Record the acknowledgements the fold's witnesses earn, in one commit under the lock; none when every one is recorded already. */
export async function recordAcks(runtime: VaultRuntime, keys: Keys): Promise<VaultEvent<"delivery.acknowledged">[]> {
  const { events } = await decide(runtime, keys, acknowledgementDrafts);
  return events as VaultEvent<"delivery.acknowledged">[];
}

function witnessKey({ localKeyName, peerPublicKey, ackMessageId, ackWireMessageId }: VaultData["delivery.acknowledged"]): string {
  return JSON.stringify([localKeyName, peerPublicKey, ackMessageId, ackWireMessageId]);
}
