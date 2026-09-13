import { canonicalize } from "@estoc/event-store/v3";
import { describe, expect, it } from "vitest";
import { v5 as uuidv5 } from "uuid";

import {
  ANCHOR_KEY_NAME,
  InvalidIdentifier,
  NAMESPACE_PURPOSES,
  automaticMessageId,
  compareUtf8,
  contactIdOf,
  decimalOrdinal,
  didKeyName,
  earlyPrivateDidId,
  effectKey,
  estocNamespace,
  executionId,
  inboundMessageId,
  mediationKeyName,
  parseDecimalOrdinal,
  relationshipId,
  type Did,
  type DidId,
  type EffectKey,
  type ExecutionId,
  type KeyName,
  type MediationId,
  type PublicKey,
  type RelationshipId,
  type WireMessageId,
} from "../../src/v3/index.js";

const did = (s: string) => s as Did;
const wire = (s: string) => s as WireMessageId;

const PEER_KEY = "z6LScHJqLmLd8zBAmcTY7BuyNvvYBEd44A6K8nVg2DSVCcis" as PublicKey;
const PURE_ACK = { handlerId: "https://estoc.dev/distributed-delivery/1.0#pure-ack", effectKind: "pure-ack", ordinal: decimalOrdinal(0) };

/** The first published relationship fixture. */
const FIRST = {
  a: did("did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd"),
  b: did("did:web:bob.example"),
  relationshipId: "35807a1e-3b8a-52f5-9580-29cd5265882e" as RelationshipId,
  contactId: "e0d4f3cf-e4d1-5774-b273-cbe08b2d26dd",
  earlyPrivateDidIdA: "4734b126-9706-5c8f-b971-91a5afb9c1d4",
  earlyPrivateDidIdB: "30d9a3a6-0e65-52a4-a822-591a683bb1e6",
};

/** The second published fixture, whose first endpoint sorts higher. */
const SECOND = {
  a: did("did:web:zoe.example"),
  b: did("did:web:amy.example"),
  relationshipId: "249fc438-75bc-53a9-904d-99d44edd6d23" as RelationshipId,
  contactId: "cbe762f9-132c-572d-bb0e-bc88efd1fb82",
  earlyPrivateDidIdA: "6d4670d0-42a0-5978-9030-072fd06f45f0",
  earlyPrivateDidIdB: "20d9f6a9-8383-5c09-8134-a52954217b3b",
};

describe("estocNamespace", () => {
  it("derives each of the six namespaces from the URL namespace to the published value", () => {
    expect(NAMESPACE_PURPOSES).toHaveLength(6);
    expect(Object.fromEntries(NAMESPACE_PURPOSES.map((p) => [p, estocNamespace(p)]))).toEqual({
      "inbound-message": "4dc929eb-aa9c-5f2e-9d33-1fdf1848fde6",
      "message-execution": "6511fc66-4d39-589e-b2c7-7185a807b6c6",
      "automatic-mid": "8847bd57-5907-5bcd-9a71-d1e97cee3199",
      relationship: "64990b5f-ad6e-5b22-98dd-9e455bb9378d",
      "relationship-local-did": "482afd96-31e8-5986-93c2-d65f5f742f3c",
      "relationship-contact": "ebbdeefb-e443-5e14-9cc9-2c468826de1c",
    });
    expect(estocNamespace("relationship")).toBe(uuidv5("https://estoc.dev/uuid/v1/relationship", "6ba7b811-9dad-11d1-80b4-00c04fd430c8"));
  });
});

describe("relationshipId, contactIdOf, earlyPrivateDidId", () => {
  for (const [name, f] of [
    ["first fixture", FIRST],
    ["second fixture", SECOND],
  ] as const) {
    it(`${name}: both orders give the published relationship, its contact and each end's early private DID`, () => {
      expect(relationshipId(f.a, f.b)).toBe(f.relationshipId);
      expect(relationshipId(f.b, f.a)).toBe(f.relationshipId);
      expect(contactIdOf(f.relationshipId)).toBe(f.contactId);
      expect(earlyPrivateDidId(f.relationshipId, f.a)).toBe(f.earlyPrivateDidIdA);
      expect(earlyPrivateDidId(f.relationshipId, f.b)).toBe(f.earlyPrivateDidIdB);
    });
  }

  it("a different pair is a different relationship, and the early private DID of a DID outside the pair is still a value of its own", () => {
    expect(relationshipId(FIRST.a, SECOND.b)).not.toBe(FIRST.relationshipId);
    expect(earlyPrivateDidId(FIRST.relationshipId, SECOND.a)).not.toBe(FIRST.earlyPrivateDidIdA);
  });

  it("sorts the two DIDs by UTF-8 bytes, not by UTF-16 code units", () => {
    const bmp = did("did:web:\ue000");
    const astral = did("did:web:\u{10000}");
    expect(astral < bmp).toBe(true);
    expect(compareUtf8(bmp, astral)).toBeLessThan(0);
    const expected = uuidv5(canonicalize(["v1", bmp, astral]), estocNamespace("relationship"));
    expect(relationshipId(astral, bmp)).toBe(expected);
    expect(relationshipId(bmp, astral)).toBe(expected);
  });

  it("refuses an empty DID or the same DID twice", () => {
    expect(() => relationshipId(did(""), FIRST.b)).toThrow(InvalidIdentifier);
    expect(() => relationshipId(FIRST.a, FIRST.a)).toThrow(InvalidIdentifier);
    expect(() => contactIdOf("" as RelationshipId)).toThrow(InvalidIdentifier);
    expect(() => earlyPrivateDidId(FIRST.relationshipId, did(""))).toThrow(InvalidIdentifier);
  });
});

describe("inboundMessageId", () => {
  it("gives the published observation IDs for the authenticated fixture key", () => {
    expect(inboundMessageId(PEER_KEY, wire("019b2a70-f225-721c-835f-67175be0667e"))).toBe("369d7a43-8dce-5b86-b073-e390d457f357");
    expect(inboundMessageId(PEER_KEY, wire("019b1b61-3444-7190-9db5-1cc9c215eb23"))).toBe("a8b9afd5-60fe-5f49-a669-bd998e760e7e");
  });

  it("an authenticated observation has one ID at every local key, so equal deliveries at P0, P1 and P2 share it", () => {
    const w = wire("019b1b61-3444-7190-9db5-1cc9c215eb23");
    for (const p of ["019b2a60-c68e-75bf-b6fb-ae1a41f8d715", "019b6a10-12c0-7410-89ab-38e54b097c21", "019b6a20-12c0-7420-89ab-38e54b097c22"]) {
      const local = didKeyName(p as DidId, "key-agreement");
      expect(local).toBe(`did/${p}/key-agreement`);
      expect(inboundMessageId(PEER_KEY, w)).toBe("a8b9afd5-60fe-5f49-a669-bd998e760e7e");
      expect(inboundMessageId({ localKeyName: local }, w)).not.toBe("a8b9afd5-60fe-5f49-a669-bd998e760e7e");
    }
  });

  it("an anonymous observation is scoped by the local key, and never equals an authenticated one", () => {
    const w = wire("019b1b61-3444-7190-9db5-1cc9c215eb23");
    const k1 = "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement" as KeyName;
    const k2 = "did/019b6a10-12c0-7410-89ab-38e54b097c21/key-agreement" as KeyName;
    expect(inboundMessageId({ localKeyName: k1 }, w)).toBe(uuidv5(canonicalize(["v1", "anonymous", k1, w]), estocNamespace("inbound-message")));
    expect(inboundMessageId({ localKeyName: k1 }, w)).not.toBe(inboundMessageId({ localKeyName: k2 }, w));
    expect(inboundMessageId({ localKeyName: k1 }, w)).not.toBe(inboundMessageId(k1 as string as PublicKey, w));
  });

  it("refuses an empty wire ID, key or key name", () => {
    expect(() => inboundMessageId(PEER_KEY, wire(""))).toThrow(InvalidIdentifier);
    expect(() => inboundMessageId("" as PublicKey, wire("x"))).toThrow(InvalidIdentifier);
    expect(() => inboundMessageId({ localKeyName: "" as KeyName }, wire("x"))).toThrow(InvalidIdentifier);
  });
});

describe("executionId", () => {
  it("gives the published execution for the pure-ACK carrier and for the rotation-notification carrier", () => {
    expect(executionId(FIRST.relationshipId, wire("019b1b61-3444-7190-9db5-1cc9c215eb23"))).toBe("cf135b1f-1d7a-51eb-88ae-42447d426abe");
    expect(executionId(FIRST.relationshipId, wire("019b4d12-090a-7c3b-92f7-ac2c51f50db4"))).toBe("148d31a6-66d0-5687-a1f1-2c2c75ac7817");
  });

  it("hashes the literal `relationship` tag, not the scope object's `relationshipId` member", () => {
    const w = wire("019b1b61-3444-7190-9db5-1cc9c215eb23");
    const scope = { relationshipId: FIRST.relationshipId };
    expect(executionId(FIRST.relationshipId, w)).not.toBe(uuidv5(canonicalize(["v2", scope, w]), estocNamespace("message-execution")));
    expect(() => executionId("" as RelationshipId, w)).toThrow(InvalidIdentifier);
    expect(() => executionId(FIRST.relationshipId, wire(""))).toThrow(InvalidIdentifier);
  });
});

describe("effectKey and automaticMessageId", () => {
  const pureAckExecution = "cf135b1f-1d7a-51eb-88ae-42447d426abe" as ExecutionId;
  const pingExecution = "148d31a6-66d0-5687-a1f1-2c2c75ac7817" as ExecutionId;

  it("the pure ACK of the delivery fixture", () => {
    const key = effectKey({ executionId: pureAckExecution, ...PURE_ACK });
    expect(key).toBe("MzoucVz8FGCDtGEE2FTwgiwSg6elFih1OQT91MzmpSU");
    expect(automaticMessageId(key)).toBe("7b53df5f-594d-50f4-adc3-3f7fbd0fe6c5");
  });

  it("the Trust Ping notification and the Empty notification of the rotation fixture", () => {
    const ping = effectKey({ executionId: pingExecution, handlerId: "https://didcomm.org/trust-ping/2.0", effectKind: "ping-response", ordinal: decimalOrdinal(0) });
    expect(ping).toBe("VXXR0fOxbJlvgykd90BsYKbbh4K85FsNhordsPbFw7Y");
    expect(automaticMessageId(ping)).toBe("8e0d1442-50f3-57b6-a356-7939851af021");
    const empty = effectKey({ executionId: pingExecution, ...PURE_ACK });
    expect(empty).toBe("HTh08t3qCpxpGnvXXQq7ClgPUIhSNi7d6uSkk27RAWA");
    expect(automaticMessageId(empty)).toBe("7e6a39e8-57fb-5cca-9460-edfc806a2297");
  });

  it("every member of the tuple changes the key, and the key alone determines the message ID", () => {
    const base = { executionId: pureAckExecution, ...PURE_ACK };
    const keys = [
      effectKey(base),
      effectKey({ ...base, executionId: pingExecution }),
      effectKey({ ...base, handlerId: "https://didcomm.org/trust-ping/2.0" }),
      effectKey({ ...base, effectKind: "ping-response" }),
      effectKey({ ...base, ordinal: decimalOrdinal(1) }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(automaticMessageId(keys[0] as EffectKey)).toBe(automaticMessageId(effectKey(base)));
  });

  it("refuses an empty member, U+0000 in a handler ID or kind, and an ordinal that is not canonical decimal", () => {
    const base = { executionId: pureAckExecution, ...PURE_ACK };
    expect(() => effectKey({ ...base, executionId: "" as ExecutionId })).toThrow(InvalidIdentifier);
    expect(() => effectKey({ ...base, handlerId: "" })).toThrow(InvalidIdentifier);
    expect(() => effectKey({ ...base, handlerId: "a\0b" })).toThrow(InvalidIdentifier);
    expect(() => effectKey({ ...base, effectKind: "pure\0ack" })).toThrow(InvalidIdentifier);
    expect(() => effectKey({ ...base, ordinal: "01" as never })).toThrow(InvalidIdentifier);
    expect(() => automaticMessageId("" as EffectKey)).toThrow(InvalidIdentifier);
  });
});

describe("decimalOrdinal and parseDecimalOrdinal", () => {
  it("zero is `0`, otherwise digits without a leading zero", () => {
    expect(decimalOrdinal(0)).toBe("0");
    expect(decimalOrdinal(7)).toBe("7");
    expect(decimalOrdinal(1234567890123)).toBe("1234567890123");
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) expect(() => decimalOrdinal(bad)).toThrow(InvalidIdentifier);
  });

  it("parses only the stored grammar", () => {
    for (const ok of ["0", "1", "10", "98765432109876543210"]) expect(parseDecimalOrdinal(ok)).toBe(ok);
    for (const bad of ["", "00", "01", "+1", "-1", " 1", "1 ", "1.0", "1e3", "０"]) expect(() => parseDecimalOrdinal(bad)).toThrow(InvalidIdentifier);
  });
});

describe("key names", () => {
  it("names the anchor, a DID entity's two keys and a mediation's identity key", () => {
    expect(ANCHOR_KEY_NAME).toBe("anchor");
    const d = "019b2a60-c68e-75bf-b6fb-ae1a41f8d715" as DidId;
    expect(didKeyName(d, "authentication")).toBe("did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/authentication");
    expect(didKeyName(d, "key-agreement")).toBe("did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement");
    expect(mediationKeyName("019b2a60-c68e-75bf-b6fb-ae1a41f8d716" as MediationId)).toBe("mediation/019b2a60-c68e-75bf-b6fb-ae1a41f8d716/me");
    expect(() => didKeyName("" as DidId, "authentication")).toThrow(InvalidIdentifier);
    expect(() => mediationKeyName("" as MediationId)).toThrow(InvalidIdentifier);
  });
});
