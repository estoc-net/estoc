import { canonicalize } from "@estoc/event-store/v3";
import { describe, expect, it } from "vitest";
import { v5 as uuidv5 } from "uuid";

import {
  ANCHOR_KEY_NAME,
  InvalidIdentifier,
  NAMESPACE_PURPOSES,
  anonymousMessageId,
  automaticMessageId,
  channelKey,
  channelOf,
  compareChannels,
  compareUtf8,
  didKeyName,
  effectKey,
  estocNamespace,
  executionId,
  inboundMessageId,
  mediationKeyName,
  sameChannel,
  type Did,
  type DidId,
  type EffectKey,
  type ExecutionId,
  type KeyName,
  type MediationId,
  type WireMessageId,
} from "../../src/v3/index.js";

const did = (s: string) => s as Did;
const wire = (s: string) => s as WireMessageId;

/** The published delivery fixture: our DID receiving, the peer's sending. */
const LOCAL = did("did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd");
const PEER = did("did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP");
const FIRST_WIRE = wire("019b2a70-f225-721c-835f-67175be0667e");
const ACK_WIRE = wire("019b1b61-3444-7190-9db5-1cc9c215eb23");
const ACK_EXECUTION = "ccee59f0-8c79-5011-8822-dbb14de9cf7d" as ExecutionId;
const PURE_ACK = "https://estoc.dev/distributed-delivery/1.0#pure-ack";
const PING_RESPONSE = "https://didcomm.org/trust-ping/2.0/ping-response";

describe("estocNamespace", () => {
  it("derives each of the three namespaces from the URL namespace to the published value", () => {
    expect(NAMESPACE_PURPOSES).toHaveLength(3);
    expect(Object.fromEntries(NAMESPACE_PURPOSES.map((p) => [p, estocNamespace(p)]))).toEqual({
      "inbound-message": "4dc929eb-aa9c-5f2e-9d33-1fdf1848fde6",
      "message-execution": "6511fc66-4d39-589e-b2c7-7185a807b6c6",
      "automatic-mid": "8847bd57-5907-5bcd-9a71-d1e97cee3199",
    });
    expect(estocNamespace("inbound-message")).toBe(uuidv5("https://estoc.dev/uuid/v1/inbound-message", "6ba7b811-9dad-11d1-80b4-00c04fd430c8"));
  });
});

describe("channels", () => {
  it("is an ordered pair of distinct DIDs: the reverse pair is another channel", () => {
    const channel = channelOf(LOCAL, PEER);
    expect(channel).toEqual({ localDid: LOCAL, peerDid: PEER });
    expect(sameChannel(channel, channelOf(LOCAL, PEER))).toBe(true);
    expect(sameChannel(channel, channelOf(PEER, LOCAL))).toBe(false);
    expect(() => channelOf(LOCAL, LOCAL)).toThrow(InvalidIdentifier);
    expect(() => channelOf(did(""), PEER)).toThrow(InvalidIdentifier);
    expect(() => channelOf(LOCAL, did(""))).toThrow(InvalidIdentifier);
  });

  it("keys a channel by the canonical text of its pair and orders a set by the UTF-8 bytes of the keys, not the two ends within a pair", () => {
    expect(channelKey(channelOf(LOCAL, PEER))).toBe(`["${LOCAL}","${PEER}"]`);
    const bmp = did("did:peer:4z");
    const astral = did("did:peer:4z\u{10000}");
    expect(astral < bmp).toBe(true);
    expect(compareUtf8(bmp, astral)).toBeLessThan(0);
    expect(compareChannels(channelOf(bmp, LOCAL), channelOf(astral, LOCAL))).toBeLessThan(0);
    expect(compareChannels(channelOf(LOCAL, bmp), channelOf(LOCAL, astral))).toBeLessThan(0);
    expect(compareChannels(channelOf(LOCAL, PEER), channelOf(LOCAL, PEER))).toBe(0);
    expect(compareChannels(channelOf(PEER, LOCAL), channelOf(LOCAL, PEER))).toBeLessThan(0);
    const sorted = [channelOf(LOCAL, bmp), channelOf(LOCAL, PEER), channelOf(PEER, LOCAL)].sort(compareChannels);
    expect(sorted.map(channelKey)).toEqual([channelKey(channelOf(PEER, LOCAL)), channelKey(channelOf(LOCAL, PEER)), channelKey(channelOf(LOCAL, bmp))]);
  });
});

describe("inboundMessageId and executionId", () => {
  it("give the published observation and execution IDs of the delivery fixture", () => {
    expect(inboundMessageId(PEER, LOCAL, FIRST_WIRE)).toBe("d2192dcf-cc5c-5f7d-b4f1-46972b7b04de");
    expect(executionId(PEER, LOCAL, FIRST_WIRE)).toBe("a03249b8-5e3e-5d10-a2e7-46844b38f5ae");
    expect(inboundMessageId(PEER, LOCAL, ACK_WIRE)).toBe("9cfaed56-2cb3-5a84-bc56-f8e882784ac8");
    expect(executionId(PEER, LOCAL, ACK_WIRE)).toBe(ACK_EXECUTION);
  });

  it("scope both IDs to the channel: the reverse direction under the same wire ID and another peer are other values", () => {
    const other = did("did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Be");
    expect(inboundMessageId(LOCAL, PEER, FIRST_WIRE)).not.toBe(inboundMessageId(PEER, LOCAL, FIRST_WIRE));
    expect(inboundMessageId(other, LOCAL, FIRST_WIRE)).not.toBe(inboundMessageId(PEER, LOCAL, FIRST_WIRE));
    expect(executionId(LOCAL, PEER, FIRST_WIRE)).not.toBe(executionId(PEER, LOCAL, FIRST_WIRE));
    expect(executionId(PEER, other, FIRST_WIRE)).not.toBe(executionId(PEER, LOCAL, FIRST_WIRE));
  });

  it("hash the literal `sender` and `recipient` tags in the execution transcript, whatever the payload calls them", () => {
    expect(executionId(PEER, LOCAL, ACK_WIRE)).toBe(uuidv5(canonicalize(["v4", { recipient: LOCAL, sender: PEER }, ACK_WIRE]), estocNamespace("message-execution")));
    expect(executionId(PEER, LOCAL, ACK_WIRE)).not.toBe(uuidv5(canonicalize(["v4", { did: PEER, localDid: LOCAL }, ACK_WIRE]), estocNamespace("message-execution")));
  });

  it("an anonymous observation is scoped by the local key, and never equals an authenticated one", () => {
    const k1 = "did/019b2a60-c68e-75bf-b6fb-ae1a41f8d715/key-agreement" as KeyName;
    const k2 = "did/019b6a10-12c0-7410-89ab-38e54b097c21/key-agreement" as KeyName;
    expect(anonymousMessageId(k1, ACK_WIRE)).toBe(uuidv5(canonicalize(["v1", "anonymous", k1, ACK_WIRE]), estocNamespace("inbound-message")));
    expect(anonymousMessageId(k1, ACK_WIRE)).not.toBe(anonymousMessageId(k2, ACK_WIRE));
    expect(anonymousMessageId(k1, ACK_WIRE)).not.toBe(inboundMessageId(PEER, LOCAL, ACK_WIRE));
  });

  it("refuse an empty wire ID, DID or key name", () => {
    expect(() => inboundMessageId(PEER, LOCAL, wire(""))).toThrow(InvalidIdentifier);
    expect(() => inboundMessageId(did(""), LOCAL, ACK_WIRE)).toThrow(InvalidIdentifier);
    expect(() => inboundMessageId(PEER, did(""), ACK_WIRE)).toThrow(InvalidIdentifier);
    expect(() => anonymousMessageId("" as KeyName, ACK_WIRE)).toThrow(InvalidIdentifier);
    expect(() => anonymousMessageId("did/x/key-agreement" as KeyName, wire(""))).toThrow(InvalidIdentifier);
    expect(() => executionId(did(""), LOCAL, ACK_WIRE)).toThrow(InvalidIdentifier);
    expect(() => executionId(PEER, LOCAL, wire(""))).toThrow(InvalidIdentifier);
  });
});

describe("effectKey and automaticMessageId", () => {
  it("the pure ACK of the delivery fixture", () => {
    const key = effectKey(ACK_EXECUTION, PURE_ACK);
    expect(key).toBe("Vyjgpd9idT4bb9ejAEdwT5J8dX-kL6FfSniCkFZDB20");
    expect(automaticMessageId(key)).toBe("3543ac01-4ac6-5c14-b160-4f8f4e2e6811");
  });

  it("both members of the tuple change the key, and the key alone determines the message ID", () => {
    const keys = [effectKey(ACK_EXECUTION, PURE_ACK), effectKey("a03249b8-5e3e-5d10-a2e7-46844b38f5ae" as ExecutionId, PURE_ACK), effectKey(ACK_EXECUTION, PING_RESPONSE)];
    expect(new Set(keys).size).toBe(keys.length);
    expect(automaticMessageId(keys[0] as EffectKey)).toBe(automaticMessageId(effectKey(ACK_EXECUTION, PURE_ACK)));
  });

  it("takes the effect type as spelled, never normalized: another spelling of the same URI is another key", () => {
    expect(effectKey(ACK_EXECUTION, PURE_ACK)).not.toBe(effectKey(ACK_EXECUTION, "HTTPS://estoc.dev/distributed-delivery/1.0#pure-ack"));
    expect(effectKey(ACK_EXECUTION, PURE_ACK)).not.toBe(effectKey(ACK_EXECUTION, `${PURE_ACK}/`));
  });

  it("refuses an empty execution, an effect type without a scheme, with U+0000, an unpaired surrogate or a noncharacter", () => {
    expect(() => effectKey("" as ExecutionId, PURE_ACK)).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "pure-ack")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "urn:a\0b")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "urn:effect-\ud800")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "urn:effect-\udfff")).toThrow(InvalidIdentifier);
    expect(() => effectKey(ACK_EXECUTION, "urn:effect-￿")).toThrow(InvalidIdentifier);
    expect(effectKey(ACK_EXECUTION, "urn:effect-�")).not.toBe(effectKey(ACK_EXECUTION, "urn:effect-\u{10000}"));
    expect(() => automaticMessageId("" as EffectKey)).toThrow(InvalidIdentifier);
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
    expect(() => didKeyName("019b0000-0000-5000-8000-00000000000c" as DidId, "authentication")).toThrow(InvalidIdentifier);
    expect(() => mediationKeyName("" as MediationId)).toThrow(InvalidIdentifier);
  });
});
