import type { Event, EventId, JsonObject } from "@estoc/event-store/v3";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import {
  InvalidPayload,
  VAULT_EVENT_TYPES,
  automaticMessageId,
  effectKey,
  inboundMessageId,
  isVaultEventType,
  rawCidOfBytes,
  readVaultDraft,
  readVaultEvent,
  vaultDraft,
  type Cid,
  type KeyName,
  type MessageIn,
  type MessageOut,
  type VaultData,
  type VaultEventType,
  type WireMessageId,
} from "../../src/v3/index.js";

const encoder = new TextEncoder();
const cidOf = (text: string) => rawCidOfBytes(encoder.encode(text));
const BODY = cidOf("body");
const PHOTO = cidOf("photo");
const DOC = cidOf("did document");
const ENVELOPE = cidOf("envelope");

const AUTHOR = "019b2a40-0000-7000-8000-000000000001";
const MEDIATION = "019b2a51-118f-7e46-b31b-c63cd090c92c";
const ROUTE = "019b2a58-fef5-7d59-ae1c-46e4f0a13c73";
const DID_ID = "019b2a60-c68e-75bf-b6fb-ae1a41f8d715";
const DID_ID2 = "019b6a10-12c0-7410-89ab-38e54b097c21";
const CONTACT = "019b2a63-48bf-7214-961d-4c3f97cb95da";
const CONTACT2 = "019b2a66-c794-7b41-bff1-68a4ecdd0b67";
const R = "35807a1e-3b8a-52f5-9580-29cd5265882e";
const PACKAGE = "019b2a73-4ce0-79ba-ad4a-f9fc4f45d37c";
const PACKAGE2 = "019b2a75-11bd-7ae2-8e41-279d84c2528a";
const OUT = "019b2a70-e2c8-7fb4-b63f-1aca32152062";
const IN = "369d7a43-8dce-5b86-b073-e390d457f357";
const WIRE = "019b2a70-f225-721c-835f-67175be0667e";
const RESOLVED = "019b2a71-4c18-760a-9017-b3e265aa89d0";
const RESOLVED2 = "019b4d14-18bd-77f1-b4a4-5c2a6c2694ba";
const BOUND = "019b4d11-22d3-7fd0-82fb-f33864a75dd5";
const ADDED = "019b2a64-86fa-7f28-a63a-5d70ce1d829a";
const SOURCE_IN = "019b2a84-44ef-7d16-8d04-2b9a5c2a06b1";
const SOURCE_OUT = "019b2a85-0912-7b2c-9425-4fd7fd0dd019";
const OOB = "019b2a57-a947-7502-8fee-4d80d949dbcb";
const KEY = `did/${DID_ID}/key-agreement`;
const PEER_KEY = "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis";
const JWT = "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6ZXhhbXBsZTphIn0.c2ln";
const INTENT_HASH = "hmqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA";
const PLAINTEXT_HASH = "WkPpglZREjLGtviZ1L6c-R3EX1cTHtbe0sJrmhl77LQ";
const SHORT = "did:peer:4zQmRendezvous";
const LONG = `${SHORT}:z2NpDocument`;

type Data<T extends VaultEventType> = VaultData[T];
type Loose = Record<string, unknown>;

function event(type: string, data: unknown, roots: readonly string[] = []): Event {
  return { eventId: uuidv7() as EventId, at: "2026-09-13T00:00:00.000Z", author: AUTHOR, type, roots: [...roots], data } as Event;
}

function accepts(type: string, data: unknown, roots: readonly string[] = []): void {
  const read = readVaultEvent(event(type, data, roots));
  expect(read.type).toBe(type);
  expect(read.data).toEqual(data);
}

function rejects(type: string, data: unknown, roots: readonly string[] = [], message?: RegExp): void {
  const attempt = () => readVaultEvent(event(type, data, roots));
  expect(attempt).toThrow(InvalidPayload);
  expect(attempt).toThrow(new RegExp(`^${type.replace(".", "\\.")}: `));
  if (message !== undefined) expect(attempt).toThrow(message);
}

/** Every one-member variation of `data`: a member removed, an extra one added, each member of the wrong type. */
function rejectsVariations(type: string, data: Loose, roots: readonly string[] = []): void {
  accepts(type, data, roots);
  rejects(type, { ...data, extra: 1 }, roots, /\.extra is not a member/);
  for (const member of Object.keys(data)) {
    const { [member]: _, ...without } = data;
    rejects(type, without, roots, new RegExp(`\\.${member} is missing`));
    rejects(type, { ...data, [member]: Symbol.for("wrong") }, roots, new RegExp(`\\.${member}`));
  }
}

const ALL: { [T in VaultEventType]: [Data<T>, readonly string[]] } = {
  "identity.label": [{ name: "Alice" }, []],
  "peer.resolved": [
    {
      localKeyName: KEY as KeyName,
      peerPublicKey: PEER_KEY,
      presentedDid: "did:web:bob.example",
      did: "did:web:bob.example",
      documentCid: DOC,
      authenticationMethodIds: ["did:web:bob.example#authentication-0"],
      keyAgreementMethodIds: ["did:web:bob.example#key-agreement-0"],
      service: "did:web:mediator.example",
    } as Data<"peer.resolved">,
    [DOC],
  ],
  "mediation.created": [{ mediationId: MEDIATION, mediatorDid: "did:web:mediator.example", me: { keyName: `mediation/${MEDIATION}/me`, did: SHORT } } as Data<"mediation.created">, []],
  "mediation.granted": [{ mediationId: MEDIATION, routingDid: "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc" } as Data<"mediation.granted">, []],
  "mediation.selected": [{ mediationId: MEDIATION } as Data<"mediation.selected">, []],
  "mediation.retired": [{ mediationId: MEDIATION, because: "replaced" } as Data<"mediation.retired">, []],
  "did.created": [{ didId: DID_ID, did: SHORT, longFormDid: LONG, boundRouteId: ROUTE } as Data<"did.created">, []],
  "route.configured": [{ routeId: ROUTE, kind: "mediated", mediationId: MEDIATION, endpoint: null } as Data<"route.configured">, []],
  "route.retired": [{ routeId: ROUTE, because: "replaced" } as Data<"route.retired">, []],
  "did.disclosed": [{ didId: DID_ID, as: "oob", uses: "many", oobId: OOB, goal: "Write to Alice" } as Data<"did.disclosed">, []],
  "did.retired": [{ didId: DID_ID, because: "contact-deleted" } as Data<"did.retired">, []],
  "relationship.bound": [{ relationshipId: R, localDidId: DID_ID, peerResolutionEventId: RESOLVED } as Data<"relationship.bound">, []],
  "relationship.contactAssigned": [{ relationshipId: R, contactId: CONTACT } as Data<"relationship.contactAssigned">, []],
  "relationship.peerTransitioned": [
    {
      relationshipId: R,
      localKeyName: KEY,
      peerPublicKey: PEER_KEY,
      fromDid: "did:web:bob.example",
      presentedFromDid: "did:web:bob.example",
      toDid: "did:peer:4zQmBobPairwise",
      presentedToDid: "did:peer:4zQmBobPairwise:z2BobDoc",
      fromPrior: JWT,
      priorResolutionEventId: RESOLVED,
      peerResolutionEventId: RESOLVED2,
      messageId: "3e7a2368-4a71-5560-8785-348ca4fbf548",
    } as Data<"relationship.peerTransitioned">,
    [],
  ],
  "relationship.localTransitioned": [{ relationshipId: R, fromDidId: DID_ID, toDidId: DID_ID2, fromPrior: JWT, triggerEventId: null } as Data<"relationship.localTransitioned">, []],
  "contact.created": [{ contactId: CONTACT, because: "user" } as Data<"contact.created">, []],
  "contact.petname": [{ contactId: CONTACT, name: "alice" } as Data<"contact.petname">, []],
  "contact.flag": [{ contactId: CONTACT, flag: "pinned", value: true } as Data<"contact.flag">, []],
  "contact.useDid": [{ contactId: CONTACT, didId: DID_ID, because: "relationship" } as Data<"contact.useDid">, []],
  "contact.peerDidAdded": [{ contactId: CONTACT, did: LONG, because: "oob" } as Data<"contact.peerDidAdded">, []],
  "contact.peerDidRemoved": [{ contactId: CONTACT, addEventId: ADDED } as Data<"contact.peerDidRemoved">, []],
  "contact.merged": [{ contactId: CONTACT, fromContactId: CONTACT2 } as Data<"contact.merged">, []],
  "contact.deleted": [{ contactId: CONTACT } as Data<"contact.deleted">, []],
  "profile.nameClaimed": [{ relationshipId: R, sourceEventId: SOURCE_IN, name: "Alice L." } as Data<"profile.nameClaimed">, []],
  "profile.shared": [{ relationshipId: R, sourceEventId: SOURCE_OUT } as Data<"profile.shared">, []],
  "message.out": [
    {
      messageId: OUT,
      relationshipId: R,
      birth: null,
      msgType: "https://didcomm.org/basicmessage/2.0/message",
      thid: null,
      pthid: null,
      createdTime: null,
      expiresTime: null,
      pleaseAck: [""],
      ack: [],
      headers: {},
      bodyCid: BODY,
      attachmentCids: [PHOTO],
      intentHash: INTENT_HASH,
      executionId: null,
      handlerId: null,
      effectKind: null,
      ordinal: null,
      effectKey: null,
    } as unknown as Data<"message.out">,
    [BODY, PHOTO],
  ],
  "message.prepared": [
    {
      messageId: OUT,
      packageId: PACKAGE,
      senderDidId: DID_ID,
      localKeyName: KEY,
      recipientDid: "did:web:bob.example",
      peerResolutionEventId: RESOLVED,
      fromPrior: null,
      intentHash: INTENT_HASH,
      plaintextHash: PLAINTEXT_HASH,
      envelopeCid: ENVELOPE,
    } as Data<"message.prepared">,
    [ENVELOPE],
  ],
  "message.packageRetired": [{ messageId: OUT, packageId: PACKAGE, because: "repacked", replacementPackageId: PACKAGE2 } as Data<"message.packageRetired">, []],
  "delivery.submitted": [{ messageId: OUT, packageId: PACKAGE } as Data<"delivery.submitted">, []],
  "delivery.failed": [{ messageId: OUT, scope: "message", packageId: null, code: "expired" } as Data<"delivery.failed">, []],
  "delivery.acknowledged": [
    { messageId: OUT, localKeyName: KEY, peerPublicKey: PEER_KEY, ackMessageId: "27c4471f-8937-501b-9ffb-a7eaeeebc178", ackWireMessageId: "21559fb4-1a9f-54b1-b8fa-1bf82700d365" } as Data<"delivery.acknowledged">,
    [],
  ],
  "message.in": [
    {
      messageId: IN,
      wireMessageId: WIRE,
      receiptOrdinal: "42",
      intentHash: "855qiA-zQ94SVOPYj2KnooWRNJAe1GB419LMTGLMwAs",
      plaintextHash: "dpPwT44Xre48u9xon4fUfvLOEQI6nYxQDzCCFnCJMK8",
      localKeyName: KEY,
      msgType: "https://didcomm.org/basicmessage/2.0/message",
      peerResolutionEventId: RESOLVED,
      relationshipBindingEventId: BOUND,
      peerTransitionEventId: null,
      presentedDid: "did:web:bob.example",
      did: "did:web:bob.example",
      thid: null,
      pthid: null,
      createdTime: 1788442800,
      expiresTime: null,
      pleaseAck: [""],
      ack: [],
      headers: {},
      fromPrior: null,
      bodyCid: BODY,
      attachmentCids: [PHOTO],
      bytes: 48213,
      signedBy: null,
      receivedVia: { mediationId: MEDIATION, deliveryId: "01J...opaque" },
    } as unknown as Data<"message.in">,
    [BODY, PHOTO],
  ],
  "message.erased": [{ messageId: OUT, dropCids: [BODY, PHOTO], because: "user" } as Data<"message.erased">, []],
};

const OUT_DATA = ALL["message.out"][0] as MessageOut;
const IN_DATA = ALL["message.in"][0] as MessageIn;

describe("readVaultEvent", () => {
  it("knows exactly the version-3 types", () => {
    expect([...VAULT_EVENT_TYPES].sort()).toEqual(Object.keys(ALL).sort());
    expect(VAULT_EVENT_TYPES).toHaveLength(33);
    expect(isVaultEventType("message.out")).toBe(true);
    expect(isVaultEventType("message.deleted")).toBe(false);
    expect(() => readVaultEvent(event("message.deleted", {}))).toThrow(/^message\.deleted: not a version-3 event type/);
    expect(() => readVaultEvent(event("toString", {}))).toThrow(InvalidPayload);
  });

  it("accepts the example of every type and refuses a member missing, added or of the wrong type", () => {
    for (const [type, [data, roots]] of Object.entries(ALL)) rejectsVariations(type, data as Loose, roots);
  });

  it("returns the event itself, typed", () => {
    const e = event("contact.deleted", { contactId: CONTACT });
    expect(readVaultEvent(e)).toBe(e);
  });

  it("refuses roots that are not what the type retains", () => {
    rejects("contact.deleted", { contactId: CONTACT }, [BODY], /roots must be \[\]/);
    rejects("message.erased", ALL["message.erased"][0], [BODY], /roots must be \[\]/);
    rejects("message.prepared", ALL["message.prepared"][0], [], /roots must be \[.*\]/);
    rejects("message.prepared", ALL["message.prepared"][0], [ENVELOPE, ENVELOPE]);
    rejects("peer.resolved", ALL["peer.resolved"][0], [BODY]);
    rejects("message.out", OUT_DATA, [PHOTO, BODY], /roots must be/);
    rejects("message.out", OUT_DATA, [BODY]);
    rejects("message.out", OUT_DATA, [BODY, PHOTO, PHOTO]);
    accepts("message.out", { ...OUT_DATA, attachmentCids: [] }, [BODY]);
    accepts("message.out", { ...OUT_DATA, attachmentCids: [BODY, PHOTO] }, [BODY, PHOTO]);
    rejects("message.out", { ...OUT_DATA, attachmentCids: [PHOTO, PHOTO] }, [BODY, PHOTO], /attachmentCids is distinct/);
    rejects("message.in", IN_DATA, [BODY]);
  });
});

describe("identifiers in payloads", () => {
  it("requires canonical lowercase UUIDs of the version the rule allows", () => {
    rejects("contact.deleted", { contactId: CONTACT.toUpperCase() }, [], /UUIDv5 or UUIDv7/);
    accepts("contact.deleted", { contactId: "ebbdeefb-e443-5e14-9cc9-2c468826de1c" });
    rejects("mediation.selected", { mediationId: R }, [], /UUIDv7/);
    rejects("relationship.contactAssigned", { relationshipId: MEDIATION, contactId: CONTACT }, [], /relationshipId is a canonical UUIDv5/);
    rejects("relationship.bound", { relationshipId: R, localDidId: DID_ID, peerResolutionEventId: R }, [], /peerResolutionEventId is an event ID/);
    rejects("delivery.acknowledged", { ...ALL["delivery.acknowledged"][0], ackMessageId: OUT }, [], /ackMessageId is a canonical UUIDv5/);
  });

  it("checks DIDs, DID URLs, key names, public keys, CIDs and hashes by their spelling", () => {
    const resolved = ALL["peer.resolved"][0] as Loose;
    accepts("peer.resolved", { ...resolved, presentedDid: LONG, did: SHORT }, [DOC]);
    rejects("peer.resolved", { ...resolved, did: LONG }, [DOC], /did is a canonical DID/);
    rejects("peer.resolved", { ...resolved, presentedDid: "bob.example" }, [DOC], /presentedDid is a DID/);
    rejects("peer.resolved", { ...resolved, did: "did:Web:bob" }, [DOC]);
    rejects("peer.resolved", { ...resolved, authenticationMethodIds: ["#authentication-0"] }, [DOC], /authenticationMethodIds\[0\] is a DID URL/);
    rejects("peer.resolved", { ...resolved, keyAgreementMethodIds: [resolved.keyAgreementMethodIds, resolved.keyAgreementMethodIds].flat() }, [DOC], /distinct/);
    accepts("peer.resolved", { ...resolved, authenticationMethodIds: [], service: null }, [DOC]);
    rejects("peer.resolved", { ...resolved, localKeyName: "did/x/key-agreement" }, [DOC], /localKeyName is a vault key name/);
    rejects("peer.resolved", { ...resolved, localKeyName: `did/${DID_ID}/signing` }, [DOC]);
    accepts("peer.resolved", { ...resolved, localKeyName: `mediation/${MEDIATION}/me` }, [DOC]);
    rejects("peer.resolved", { ...resolved, peerPublicKey: PEER_KEY.slice(0, -1) }, [DOC], /canonical public key/);
    rejects("peer.resolved", { ...resolved, peerPublicKey: `did:key:${PEER_KEY}` }, [DOC]);
    rejects("peer.resolved", { ...resolved, documentCid: "bafyrei" }, [DOC], /raw DASL CID/);
    rejects("message.prepared", { ...(ALL["message.prepared"][0] as Loose), intentHash: `${INTENT_HASH}=` }, [ENVELOPE], /base64url SHA-256/);
    rejects("message.prepared", { ...(ALL["message.prepared"][0] as Loose), plaintextHash: PLAINTEXT_HASH.slice(0, -1) + "B" }, [ENVELOPE]);
    rejects("message.prepared", { ...(ALL["message.prepared"][0] as Loose), fromPrior: "a.b" }, [ENVELOPE], /compact JWT/);
  });
});

describe("rules between members", () => {
  it("mediation.created names the arrangement's own key", () => {
    const data = ALL["mediation.created"][0] as Loose;
    rejects("mediation.created", { ...data, me: { keyName: KEY, did: SHORT } }, [], /me\.keyName is the arrangement's own key/);
  });

  it("did.created holds a numalgo-4 short form and its long form", () => {
    const data = ALL["did.created"][0] as Loose;
    rejects("did.created", { ...data, did: LONG }, [], /short form/);
    rejects("did.created", { ...data, did: "did:web:alice.example", longFormDid: "did:web:alice.example:z1" }, [], /short form/);
    rejects("did.created", { ...data, longFormDid: SHORT }, [], /long form/);
    rejects("did.created", { ...data, longFormDid: "did:peer:4zQmOther:z2NpDocument" }, [], /long form of did/);
  });

  it("route.configured is mediated or direct, never both", () => {
    accepts("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: "https://ingress.example/didcomm" });
    accepts("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: "wss://ingress.example/ws" });
    rejects("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: "http://ingress.example" }, [], /HTTPS or WSS/);
    rejects("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: "/didcomm" }, [], /absolute URL/);
    rejects("route.configured", { routeId: ROUTE, kind: "direct", mediationId: MEDIATION, endpoint: "https://ingress.example" }, [], /direct route/);
    rejects("route.configured", { routeId: ROUTE, kind: "direct", mediationId: null, endpoint: null }, [], /direct route/);
    rejects("route.configured", { routeId: ROUTE, kind: "mediated", mediationId: MEDIATION, endpoint: "https://x.example" }, [], /mediated route/);
    rejects("route.configured", { routeId: ROUTE, kind: "mediated", mediationId: null, endpoint: null }, [], /mediated route/);
    rejects("route.configured", { routeId: ROUTE, kind: "relay", mediationId: MEDIATION, endpoint: null }, [], /one of "mediated", "direct"/);
  });

  it("did.disclosed carries an oobId exactly for an oob disclosure", () => {
    const data = ALL["did.disclosed"][0] as Loose;
    accepts("did.disclosed", { ...data, as: "profile", uses: "many", oobId: null, goal: null });
    rejects("did.disclosed", { ...data, oobId: null }, [], /oobId/);
    rejects("did.disclosed", { ...data, as: "direct" }, [], /oobId/);
    rejects("did.disclosed", { ...data, uses: "some" });
  });

  it("a transition moves to another DID or DID entity, and a merge names two contacts", () => {
    const peer = ALL["relationship.peerTransitioned"][0] as Loose;
    rejects("relationship.peerTransitioned", { ...peer, toDid: peer.fromDid, presentedToDid: peer.fromDid }, [], /fromDid and toDid differ/);
    rejects("relationship.peerTransitioned", { ...peer, toDid: peer.presentedToDid }, [], /toDid is a canonical DID/);
    const local = ALL["relationship.localTransitioned"][0] as Loose;
    rejects("relationship.localTransitioned", { ...local, toDidId: DID_ID }, [], /differ/);
    accepts("relationship.localTransitioned", { ...local, triggerEventId: SOURCE_IN });
    rejects("contact.merged", { contactId: CONTACT, fromContactId: CONTACT }, [], /two contacts/);
    rejects("contact.created", { contactId: CONTACT, because: "policy" }, [], /one of "user", "automatic"/);
    rejects("contact.flag", { contactId: CONTACT, flag: "pinned", value: "yes" }, [], /value is a boolean/);
    rejects("contact.flag", { contactId: CONTACT, flag: "", value: true });
  });

  it("delivery.failed names a package for package scope, and the expiry and key-change codes are message-scoped", () => {
    accepts("delivery.failed", { messageId: OUT, scope: "package", packageId: PACKAGE, code: "rejected" });
    accepts("delivery.failed", { messageId: OUT, scope: "message", packageId: PACKAGE, code: "rejected" });
    accepts("delivery.failed", { messageId: OUT, scope: "message", packageId: null, code: "peer-key-changed" });
    rejects("delivery.failed", { messageId: OUT, scope: "package", packageId: null, code: "rejected" }, [], /names its package/);
    rejects("delivery.failed", { messageId: OUT, scope: "package", packageId: PACKAGE, code: "expired" }, [], /expired is message-scoped/);
    rejects("delivery.failed", { messageId: OUT, scope: "message", packageId: PACKAGE, code: "peer-key-changed" }, [], /before any package/);
    rejects("delivery.failed", { messageId: OUT, scope: "all", packageId: null, code: "x" });
  });

  it("message.erased releases at least one root, each once", () => {
    rejects("message.erased", { messageId: OUT, dropCids: [], because: "user" }, [], /non-empty/);
    rejects("message.erased", { messageId: OUT, dropCids: [BODY, BODY], because: "user" }, [], /distinct/);
  });
});

describe("message.out", () => {
  const PURE_ACK = {
    executionId: "cf135b1f-1d7a-51eb-88ae-42447d426abe",
    handlerId: "https://estoc.dev/distributed-delivery/1.0#pure-ack",
    effectKind: "pure-ack",
    ordinal: "0",
  };
  const KEY_OF_PURE_ACK = "MzoucVz8FGCDtGEE2FTwgiwSg6elFih1OQT91MzmpSU";
  const AUTOMATIC = {
    ...OUT_DATA,
    ...PURE_ACK,
    effectKey: KEY_OF_PURE_ACK,
    messageId: "7b53df5f-594d-50f4-adc3-3f7fbd0fe6c5",
    msgType: "https://didcomm.org/empty/1.0/empty",
    pleaseAck: null,
    ack: [WIRE],
    attachmentCids: [],
  };

  it("freezes timing, exact pleaseAck, exact ack, headers and birth", () => {
    accepts("message.out", { ...OUT_DATA, createdTime: 1788442800, expiresTime: 1788446400, pleaseAck: null, headers: { lang: "en" }, birth: { localDidId: DID_ID, peerDid: LONG } }, [BODY, PHOTO]);
    accepts("message.out", { ...OUT_DATA, pleaseAck: [] }, [BODY, PHOTO]);
    rejects("message.out", { ...OUT_DATA, createdTime: 10, expiresTime: 10 }, [BODY, PHOTO], /expiresTime must be later/);
    rejects("message.out", { ...OUT_DATA, createdTime: 1.5 }, [BODY, PHOTO]);
    rejects("message.out", { ...OUT_DATA, headers: { return_route: "all" } }, [BODY, PHOTO], /reserved header "return_route"/);
    rejects("message.out", { ...OUT_DATA, headers: { thid: "x" } }, [BODY, PHOTO], /reserved header/);
    rejects("message.out", { ...OUT_DATA, headers: [] }, [BODY, PHOTO]);
    rejects("message.out", { ...OUT_DATA, birth: { localDidId: DID_ID } }, [BODY, PHOTO], /birth\.peerDid is missing/);
    rejects("message.out", { ...OUT_DATA, pleaseAck: [1] }, [BODY, PHOTO]);
    rejects("message.out", { ...OUT_DATA, thid: "" }, [BODY, PHOTO]);
  });

  it("a locally initiated send mints its ID, requests nothing automatic and acknowledges nothing", () => {
    rejects("message.out", { ...OUT_DATA, ack: [WIRE] }, [BODY, PHOTO], /has ack \[\]/);
    rejects("message.out", { ...OUT_DATA, messageId: IN }, [BODY, PHOTO], /mints a UUIDv7/);
    rejects("message.out", { ...OUT_DATA, handlerId: PURE_ACK.handlerId }, [BODY, PHOTO], /all null or all present/);
  });

  it("an automatic effect stores its producing tuple, the key of that tuple and the message ID of that key", () => {
    expect(effectKey({ ...PURE_ACK } as Parameters<typeof effectKey>[0])).toBe(KEY_OF_PURE_ACK);
    expect(automaticMessageId(KEY_OF_PURE_ACK as Parameters<typeof automaticMessageId>[0])).toBe(AUTOMATIC.messageId);
    accepts("message.out", AUTOMATIC, [BODY]);
    rejects("message.out", { ...AUTOMATIC, ordinal: "1" }, [BODY], /effectKey is not the key of the producing tuple/);
    rejects("message.out", { ...AUTOMATIC, ordinal: "00" }, [BODY], /ordinal/);
    rejects("message.out", { ...AUTOMATIC, ordinal: 0 }, [BODY]);
    rejects("message.out", { ...AUTOMATIC, effectKey: KEY_OF_PURE_ACK.slice(0, -1) + "V" }, [BODY], /effectKey is not the key/);
    rejects("message.out", { ...AUTOMATIC, messageId: OUT }, [BODY], /messageId is derived from its key/);
    rejects("message.out", { ...AUTOMATIC, executionId: null }, [BODY], /all null or all present/);
    rejects("message.out", { ...AUTOMATIC, executionId: OUT }, [BODY], /executionId is a canonical UUIDv5/);
    rejects("message.out", { ...AUTOMATIC, handlerId: "" }, [BODY]);
  });
});

describe("message.in", () => {
  const anonymous = {
    ...IN_DATA,
    messageId: inboundMessageId({ localKeyName: KEY as KeyName }, WIRE as WireMessageId),
    peerResolutionEventId: null,
    relationshipBindingEventId: null,
    presentedDid: null,
    did: null,
  };

  it("takes a receipt ordinal as a positive decimal with no leading zero", () => {
    accepts("message.in", { ...IN_DATA, receiptOrdinal: "1" }, [BODY, PHOTO]);
    for (const receiptOrdinal of ["0", "042", "", "4.2", "1e3", " 1"]) rejects("message.in", { ...IN_DATA, receiptOrdinal }, [BODY, PHOTO], /receiptOrdinal/);
    rejects("message.in", { ...IN_DATA, receiptOrdinal: 42 }, [BODY, PHOTO]);
  });

  it("keeps normalized headers, the proof, the byte count and where it arrived", () => {
    accepts("message.in", { ...IN_DATA, pleaseAck: null, ack: [OUT, OUT], headers: { lang: "en" }, fromPrior: JWT, thid: "t", pthid: OOB, signedBy: "did:web:bob.example#authentication-0" }, [BODY, PHOTO]);
    accepts("message.in", { ...IN_DATA, receivedVia: { mediationId: null, deliveryId: null }, bytes: 0 }, [BODY, PHOTO]);
    accepts("message.in", { ...IN_DATA, presentedDid: LONG, did: SHORT, peerTransitionEventId: RESOLVED2 }, [BODY, PHOTO]);
    rejects("message.in", { ...IN_DATA, did: LONG, presentedDid: LONG }, [BODY, PHOTO], /did is a canonical DID/);
    rejects("message.in", { ...IN_DATA, headers: { please_ack: [] } }, [BODY, PHOTO], /reserved header/);
    rejects("message.in", { ...IN_DATA, bytes: -1 }, [BODY, PHOTO], /bytes is a non-negative integer/);
    rejects("message.in", { ...IN_DATA, receivedVia: { mediationId: MEDIATION } }, [BODY, PHOTO], /receivedVia\.deliveryId is missing/);
    rejects("message.in", { ...IN_DATA, receivedVia: { mediationId: R, deliveryId: null } }, [BODY, PHOTO]);
    rejects("message.in", { ...IN_DATA, createdTime: 5, expiresTime: 4 }, [BODY, PHOTO], /expiresTime/);
    rejects("message.in", { ...IN_DATA, wireMessageId: "" }, [BODY, PHOTO]);
    rejects("message.in", { ...IN_DATA, fromPrior: "" }, [BODY, PHOTO]);
  });

  it("an anonymous observation has no sender evidence and the ID its local key and wire ID derive", () => {
    accepts("message.in", anonymous, [BODY, PHOTO]);
    rejects("message.in", { ...anonymous, did: "did:web:bob.example" }, [BODY, PHOTO], /null together/);
    rejects("message.in", { ...IN_DATA, presentedDid: null }, [BODY, PHOTO], /null together/);
    rejects("message.in", { ...IN_DATA, peerResolutionEventId: null }, [BODY, PHOTO], /null together/);
    rejects("message.in", { ...anonymous, signedBy: "did:web:bob.example#key-1" }, [BODY, PHOTO], /signed sender has resolution evidence/);
    rejects("message.in", { ...anonymous, relationshipBindingEventId: BOUND }, [BODY, PHOTO], /no relationship evidence/);
    rejects("message.in", { ...anonymous, peerTransitionEventId: RESOLVED2 }, [BODY, PHOTO], /no relationship evidence/);
    rejects("message.in", { ...anonymous, messageId: IN }, [BODY, PHOTO], /derived from its local key and wire ID/);
    rejects("message.in", { ...anonymous, localKeyName: `did/${DID_ID2}/key-agreement` }, [BODY, PHOTO], /derived from its local key/);
  });
});

describe("drafts", () => {
  it("readVaultDraft checks a draft as its event will be checked, roots left out being none", () => {
    expect(readVaultDraft({ type: "contact.deleted", data: { contactId: CONTACT } as unknown as JsonObject })).toEqual({ type: "contact.deleted", roots: [], data: { contactId: CONTACT } });
    expect(() => readVaultDraft({ type: "message.out", data: OUT_DATA as unknown as JsonObject })).toThrow(/roots must be/);
    expect(() => readVaultDraft({ type: "nope", data: {} })).toThrow(InvalidPayload);
  });

  it("vaultDraft fills in the roots the type retains", () => {
    expect(vaultDraft("message.out", OUT_DATA).roots).toEqual([BODY, PHOTO]);
    expect(vaultDraft("message.in", IN_DATA).roots).toEqual([BODY, PHOTO]);
    expect(vaultDraft("message.prepared", ALL["message.prepared"][0]).roots).toEqual([ENVELOPE]);
    expect(vaultDraft("peer.resolved", ALL["peer.resolved"][0]).roots).toEqual([DOC]);
    expect(vaultDraft("message.erased", ALL["message.erased"][0]).roots).toEqual([]);
    expect(() => vaultDraft("contact.deleted", { contactId: "x" as Data<"contact.deleted">["contactId"] })).toThrow(InvalidPayload);
    const cids: Cid[] = vaultDraft("message.out", { ...OUT_DATA, attachmentCids: [BODY] }).roots;
    expect(cids).toEqual([BODY]);
  });
});
