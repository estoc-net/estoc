import bs58 from "bs58";
import { v7 as uuidv7 } from "uuid";

import type { Cid, Event, JsonObject } from "@estoc/event-store";
import { MemoryBlobStore } from "@estoc/event-store";

import { peerKeyOf, type VaultFold } from "../../src/v2/index.js";

export const DEV_A = "aaaaaa";
export const DEV_B = "bbbbbb";
export const DEV_C = "cccccc";

/** Events one second apart, eids minted for their instants: canonical order is build order. */
export class Line {
  private t: number;

  constructor(start = "2026-08-30T00:00:00.000Z") {
    this.t = new Date(start).getTime();
  }

  next(author: string, type: string, data: JsonObject, blobs: Cid[] = []): Event {
    this.t += 1000;
    return { eid: uuidv7({ msecs: this.t }), at: new Date(this.t).toISOString(), author, type, blobs, data };
  }

  /** a fresh uuidv7 at the current instant, for mids and ids */
  id(): string {
    return uuidv7({ msecs: this.t });
  }
}

/** A peer's public key as a document lists it, and its fingerprint. */
export function peerKey(seedByte: number): { multibase: string; fingerprint: string } {
  const bytes = new Uint8Array(34).fill(seedByte);
  bytes[0] = 0xec;
  bytes[1] = 0x01;
  const multibase = `z${bs58.encode(bytes)}`;
  return { multibase, fingerprint: peerKeyOf(multibase) };
}

/** A deterministic shuffle: the same seed, the same order, whatever the runner. */
export function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Every projection of the fold as plain JSON: what order-independence is measured on. */
export function dump(fold: VaultFold): unknown {
  return JSON.parse(
    JSON.stringify({
      channels: fold.channels(),
      contacts: fold.contacts(),
      deleted: fold.deletedContacts(),
      keys: fold.myKeys(),
      devices: fold.devices(),
      label: fold.label(),
      extensions: fold.extensions(),
      invitations: fold.invitations(),
      messages: fold.messages(),
      held: fold.held(),
      malformed: fold.malformed.map((m) => m.message).sort(),
    })
  );
}

export interface Scene {
  events: Event[];
  /** blob roots by name */
  roots: Record<string, Cid>;
  bob: ReturnType<typeof peerKey>;
  bob2: ReturnType<typeof peerKey>;
  carol: ReturnType<typeof peerKey>;
  keys: { k1: string; k2: string; k3: string; me: string };
  cids: { c1: string; c2: string };
  mediation: string;
  mids: { in1: string; in2: string; out1: string; out2: string };
  exts: { e1: string; e2: string };
  pairs: { ch1: ChannelPair; ch2: ChannelPair; ch3: ChannelPair; med: ChannelPair };
}

type ChannelPair = { myKey: string | null; peerKey: string | null };

/**
 * A vault two devices wrote (vault-events.md, most types at least once):
 * an invitation taken by bob, his rotation to a second DID, a second
 * contact merged in, one erase, mediation, extensions, a foreign-type
 * line and a malformed one.
 */
export async function buildScene(): Promise<Scene> {
  const line = new Line();
  const blobs = new MemoryBlobStore();
  const enc = new TextEncoder();
  const roots: Record<string, Cid> = {
    in1: await blobs.put(enc.encode("hi from bob")),
    att1: await blobs.put(enc.encode("a picture")),
    in2: await blobs.put(enc.encode("hi again")),
    out1: await blobs.put(enc.encode("hello bob")),
    out2: await blobs.put(enc.encode("and again")),
    foreign: await blobs.put(enc.encode("an extension's business")),
  };
  const bob = peerKey(7);
  const bob2 = peerKey(9);
  const carol = peerKey(11);

  const events: Event[] = [];
  const push = (author: string, type: string, data: JsonObject, blobRoots: Cid[] = []): Event => {
    const event = line.next(author, type, data, blobRoots);
    events.push(event);
    return event;
  };

  push(DEV_A, "device.minted", {});
  push(DEV_B, "device.minted", {});
  push(DEV_A, "identity.label", { name: "Alice" });
  push(DEV_B, "identity.label", { name: "Alicia" }); // later: wins

  const mediation = line.id();
  const me = `mediation/${mediation}/me`;
  push(DEV_A, "mediation.created", { id: mediation, mediatorDid: "did:web:mediator.example", me: { key: me, did: "did:peer:4me" } });
  push(DEV_A, "mediation.granted", { id: mediation, routingDid: "did:peer:2route" });
  push(DEV_A, "channel.firstSeen", { myKey: me, peerKey: carol.fingerprint, peerPublicKey: carol.multibase, kind: "authcrypt" });
  push(DEV_A, "peer.resolved", { myKey: me, peerKey: carol.fingerprint, did: "did:web:mediator.example", keys: [carol.multibase], service: null });

  const k1 = `did/${line.id()}`;
  push(DEV_A, "did.minted", { key: k1, did: "did:peer:4k1", routingDid: "did:peer:2route", mediation });
  push(DEV_A, "did.registered", { key: k1 });
  push(DEV_A, "did.published", { key: k1, as: "oob", uses: "one", oobId: "oob-1", goal: "Write to Alice" });

  const ch1: ChannelPair = { myKey: k1, peerKey: bob.fingerprint };
  push(DEV_A, "channel.firstSeen", { ...ch1, peerPublicKey: bob.multibase, kind: "authcrypt", firstDid: "did:peer:4bob" });
  push(DEV_A, "peer.resolved", { ...ch1, did: "did:peer:4bob", keys: [bob.multibase], service: "did:peer:2bobroute" });
  const in1 = line.id();
  push(DEV_A, "message.in", { ...ch1, mid: in1, wireId: "w-in1", msgType: "https://didcomm.org/basicmessage/2.0/message", did: "did:peer:4bob", bytes: 11, body: roots["in1"] as Cid, attachments: [roots["att1"] as Cid] }, [roots["in1"] as Cid, roots["att1"] as Cid]);
  push(DEV_A, "profile.nameClaimed", { ...ch1, mid: in1, name: "Bob R." });

  const c1 = line.id();
  push(DEV_A, "contact.created", { cid: c1 });
  push(DEV_A, "contact.attached", { ...ch1, cid: c1, because: "invitation", oobId: "oob-1" });
  push(DEV_A, "contact.petname", { cid: c1, name: "bob" });
  push(DEV_A, "contact.flag", { cid: c1, pinned: true });

  const out1 = line.id();
  push(DEV_B, "message.out", { ...ch1, mid: out1, wireId: "w-out1", msgType: "https://didcomm.org/basicmessage/2.0/message", thid: "t1", bytes: 9, body: roots["out1"] as Cid, attachments: [] }, [roots["out1"] as Cid]);
  push(DEV_B, "delivery.attempted", { ...ch1, mid: out1, attempt: 1, outcome: "failed", error: "offline" });
  push(DEV_B, "profile.shared", { ...ch1, mid: out1 });

  // bob rotates: a fresh key of ours toward him, his new DID, the from_prior edge
  const k2 = `did/${line.id()}`;
  push(DEV_A, "did.minted", { key: k2, did: "did:peer:4k2", routingDid: "did:peer:2route", mediation });
  push(DEV_A, "contact.useKey", { cid: c1, key: k2, because: "minted" });
  const ch2: ChannelPair = { myKey: k2, peerKey: bob2.fingerprint };
  push(DEV_A, "channel.firstSeen", { ...ch2, peerPublicKey: bob2.multibase, kind: "authcrypt", firstDid: "did:peer:4bob2" });
  push(DEV_A, "peer.resolved", { ...ch2, did: "did:peer:4bob2", keys: [bob2.multibase], service: "did:peer:2bobroute" });
  const in2 = line.id();
  push(DEV_A, "peer.rotated", { ...ch2, from: "did:peer:4bob", to: "did:peer:4bob2", fromPrior: "eyJhbGciOi…", mid: in2 });
  push(DEV_A, "message.in", { ...ch2, mid: in2, wireId: "w-in2", msgType: "https://didcomm.org/basicmessage/2.0/message", did: "did:peer:4bob2", bytes: 8, body: roots["in2"] as Cid, attachments: [] }, [roots["in2"] as Cid]);

  const out2 = line.id();
  push(DEV_A, "message.out", { ...ch2, mid: out2, wireId: "w-out2", msgType: "https://didcomm.org/basicmessage/2.0/message", bytes: 9, body: roots["out2"] as Cid, attachments: [] }, [roots["out2"] as Cid]);
  push(DEV_A, "delivery.attempted", { ...ch2, mid: out2, attempt: 1, outcome: "sent" });

  // a second contact, met by hand on device B, merged into the first
  const c2 = line.id();
  const ch3: ChannelPair = { myKey: null, peerKey: carol.fingerprint };
  push(DEV_B, "contact.created", { cid: c2 });
  push(DEV_B, "contact.attached", { ...ch3, cid: c2, because: "manual" });
  push(DEV_A, "contact.merged", { cid: c1, from: c2 });

  // the person erases the picture, keeps the words
  push(DEV_A, "message.erased", { ...ch1, mid: in1, drop: [roots["att1"] as Cid], because: "user" });

  // extensions, one removed, one purged
  const e1 = line.id();
  const e2 = line.id();
  push(DEV_A, "extension.installed", { ext: e1, name: "onion" });
  push(DEV_A, "extension.removed", { ext: e1 });
  push(DEV_B, "extension.installed", { ext: e2, name: "lens" });
  push(DEV_B, "extension.purged", { ext: e2 });

  // an open invitation, untaken
  const k3 = `did/${line.id()}`;
  push(DEV_A, "did.minted", { key: k3, did: "did:peer:4k3", routingDid: "did:peer:2route", mediation });
  push(DEV_A, "did.published", { key: k3, as: "oob", uses: "one", oobId: "oob-2", goal: "Write to Alice too" });

  // devices named; one retired that never wrote
  push(DEV_B, "device.label", { dev: DEV_B, name: "phone" });
  push(DEV_A, "device.retired", { dev: DEV_C, because: "lost" });

  // a type this document does not name: its roots held for the vault's life
  push(DEV_A, "onion.peeled", { layer: 1 }, [roots["foreign"] as Cid]);
  // a line that only claims to be a vault type
  push(DEV_B, "contact.created", { cid: "not-a-uuid" });

  return {
    events,
    roots,
    bob,
    bob2,
    carol,
    keys: { k1, k2, k3, me },
    cids: { c1, c2 },
    mediation,
    mids: { in1, in2, out1, out2 },
    exts: { e1, e2 },
    pairs: { ch1, ch2, ch3, med: { myKey: me, peerKey: carol.fingerprint } },
  };
}
