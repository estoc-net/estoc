import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import type { Cid, Event, JsonObject } from "@estoc/event-store";
import { MemoryBlobStore } from "@estoc/event-store";

import { Malformed, fingerprint, isPeerKey, peerKeyOf, readVaultEvent, VAULT_TYPES, type VaultType } from "../src/index.js";
import { DEV_A, Line, peerKey } from "./helpers.js";

let root: Cid;
let att: Cid;

beforeAll(async () => {
  const blobs = new MemoryBlobStore();
  root = await blobs.put(new TextEncoder().encode("a body"));
  att = await blobs.put(new TextEncoder().encode("an attachment"));
});

const line = new Line();
const bob = peerKey(7);
const pair = { myKey: "did/0198a111-0000-7000-8000-000000000000", peerKey: bob.fingerprint };
const MID = "0198a111-0000-7000-8000-00000000000a";
const EXT = "0198a111-0000-7000-8000-00000000000b";
const CID_ = "0198a111-0000-7000-8000-00000000000c";

function event(type: string, data: JsonObject, blobs: Cid[] = []): Event {
  return line.next(DEV_A, type, data, blobs);
}

describe("v2 types: readVaultEvent", () => {
  it("reads a valid line of every type", () => {
    const samples: { [T in VaultType]: JsonObject } = {
      "channel.firstSeen": { ...pair, peerPublicKey: bob.multibase, kind: "authcrypt", firstDid: "did:peer:4bob" },
      "message.in": { ...pair, mid: MID, wireId: "w1", msgType: "https://didcomm.org/basicmessage/2.0/message", thid: "t", pthid: "p", did: "did:peer:4bob", bytes: 5, body: root, attachments: [att], signedBy: "did:key:z6Mk" },
      "message.out": { ...pair, mid: MID, wireId: "w2", msgType: "m", bytes: 5, body: root, attachments: [] },
      "delivery.attempted": { ...pair, mid: MID, attempt: 1, outcome: "failed", error: "offline" },
      "delivery.held": { ...pair, mid: MID, because: "imported" },
      "profile.nameClaimed": { ...pair, mid: MID, name: "Bob R." },
      "profile.shared": { ...pair, mid: MID },
      "peer.resolved": { ...pair, did: "did:peer:4bob", keys: [bob.multibase], service: null },
      "peer.rotated": { ...pair, from: "did:peer:4a", to: "did:peer:4b", fromPrior: "eyJ", mid: MID },
      "message.erased": { ...pair, mid: MID, drop: [root], because: "user" },
      "device.minted": {},
      "did.minted": { key: "did/x", did: "did:peer:4x", routingDid: "did:peer:2r", mediation: MID },
      "did.registered": { key: "did/x" },
      "did.published": { key: "did/x", as: "oob", uses: "one", oobId: "o", goal: "g" },
      "did.retired": { key: "did/x", because: "user" },
      "mediation.created": { id: MID, mediatorDid: "did:web:m", me: { key: `mediation/${MID}/me`, did: "did:peer:4me" } },
      "mediation.granted": { id: MID, routingDid: "did:peer:2r" },
      "mediation.retired": { id: MID, because: "changed" },
      "identity.label": { name: "Alice" },
      "device.label": { dev: DEV_A, name: "phone" },
      "device.retired": { dev: DEV_A, because: "lost" },
      "extension.installed": { ext: EXT, name: "onion" },
      "extension.removed": { ext: EXT },
      "extension.purged": { ext: EXT },
      "contact.created": { cid: CID_ },
      "contact.petname": { cid: CID_, name: "bob" },
      "contact.flag": { cid: CID_, pinned: true, muted: false },
      "contact.useKey": { cid: CID_, key: "did/x", because: "minted" },
      "contact.attached": { ...pair, cid: CID_, because: "invitation", oobId: "o" },
      "contact.detached": { ...pair, cid: CID_ },
      "contact.merged": { cid: CID_, from: MID },
      "contact.deleted": { cid: CID_ },
    };
    for (const type of VAULT_TYPES) {
      const read = readVaultEvent(event(type, samples[type]));
      expect(read, type).not.toBeNull();
      expect(read?.type).toBe(type);
      expect(read?.data).toEqual(samples[type]);
    }
  });

  it("is null on a type this document does not name", () => {
    expect(readVaultEvent(event("onion.peeled", { layer: 1 }))).toBeNull();
    expect(readVaultEvent(event("message.inbox", {}))).toBeNull();
  });

  it("throws Malformed, naming the event and the field", () => {
    const bad: [string, JsonObject][] = [
      ["contact.created", { cid: "not-a-uuid" }],
      ["contact.merged", { cid: MID, from: MID }],
      ["message.in", { ...pair, mid: MID, wireId: "w", msgType: "m", bytes: -1, body: root, attachments: [] }],
      ["message.in", { ...pair, mid: MID, wireId: "w", msgType: "m", bytes: 1, body: "not-a-cid", attachments: [] }],
      ["message.in", { myKey: "did/x", peerKey: null, mid: MID, wireId: "w", msgType: "m", did: "did:example:mallory", bytes: 1, body: root, attachments: [] }], // anonymous, yet a DID
      ["message.in", { ...pair, mid: MID, wireId: "w", msgType: "m", bytes: 1, body: root, attachments: [] }], // a key, yet no DID
      ["message.erased", { ...pair, mid: MID, drop: [root], because: "regret" }],
      ["delivery.attempted", { ...pair, mid: MID, attempt: 0, outcome: "sent" }],
      ["device.minted", { extra: 1 }],
      ["did.minted", { key: "did/x", did: "did:peer:4x", routingDid: null, mediation: MID }],
      ["did.published", { key: "did/x", as: "poster", uses: "one" }],
      ["device.label", { dev: "not-a-dev", name: "x" }],
      ["contact.attached", { myKey: "did/x", peerKey: "TOO-SHORT", cid: CID_, because: "manual" }],
      ["contact.flag", { cid: CID_, pinned: "yes" }],
      ["channel.firstSeen", { myKey: "did/x", peerKey: null, peerPublicKey: bob.multibase, kind: "anoncrypt" }],
      ["channel.firstSeen", { ...pair, kind: "authcrypt" }],
      ["mediation.created", { id: MID, mediatorDid: "did:web:m", me: "not-an-object" }],
    ];
    for (const [type, data] of bad) {
      expect(() => readVaultEvent(event(type, data)), `${type} ${JSON.stringify(data)}`).toThrow(Malformed);
    }
  });
});

describe("v2 peer keys", () => {
  it("fingerprints as base32lower(sha256)[0:26], per an independent hash", () => {
    const bytes = new Uint8Array(34).fill(7);
    bytes[0] = 0xec;
    bytes[1] = 0x01;
    const digest = createHash("sha256").update(bytes).digest();
    // an independent base32: BigInt arithmetic, no shared code with the implementation
    let acc = 0n;
    let bits = 0n;
    let expected = "";
    for (const byte of digest) {
      acc = (acc << 8n) | BigInt(byte);
      bits += 8n;
      while (bits >= 5n && expected.length < 26) {
        bits -= 5n;
        expected += "abcdefghijklmnopqrstuvwxyz234567"[Number((acc >> bits) & 31n)];
      }
    }
    expect(fingerprint(bytes)).toBe(expected);
    expect(fingerprint(bytes)).toMatch(/^[a-z2-7]{26}$/);
  });

  it("reads a did:key and the bare multibase alike", () => {
    expect(peerKeyOf(`did:key:${bob.multibase}`)).toBe(peerKeyOf(bob.multibase));
    expect(isPeerKey(peerKeyOf(bob.multibase))).toBe(true);
    expect(isPeerKey("not a key")).toBe(false);
    expect(() => peerKeyOf("mFA==")).toThrow(/base58btc/);
    expect(() => peerKeyOf("z0OIl")).toThrow(/base58btc/);
  });
});
