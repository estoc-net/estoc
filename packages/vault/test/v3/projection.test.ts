import { canonicalize } from "@estoc/event-store/v3";
import { sha256 } from "@noble/hashes/sha2";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  InvalidPlaintext,
  PLAINTEXT_TYP,
  RESERVED_HEADERS,
  checkHeaders,
  expandPleaseAck,
  intentHash,
  intentOfOutbound,
  intentProjection,
  plaintextHash,
  rawCidOfBytes,
  readPlaintext,
  requestsAck,
  semanticProjection,
  storeMessage,
  wirePlaintext,
  type Did,
  type Intent,
  type MessageOut,
} from "../../src/v3/index.js";

const hashOf = (value: unknown) => base64urlnopad.encode(sha256(canonicalize(value)));
const without = <T extends object>(value: T, ...members: (keyof T)[]): Partial<T> => Object.fromEntries(Object.entries(value).filter(([k]) => !members.includes(k as keyof T))) as Partial<T>;
const PHOTO = Uint8Array.from([1, 2, 3, 4]);
const ALICE = "did:peer:4zQmAlice" as Did;
const BOB = "did:web:bob.example" as Did;
const JWT = "eyJhbGciOiJFZERTQSJ9.eyJpc3MiOiJkaWQ6ZXhhbXBsZTphIn0.c2ln";

const PLAINTEXT = {
  typ: PLAINTEXT_TYP,
  id: "019b2a70-f225-721c-835f-67175be0667e",
  type: "https://didcomm.org/basicmessage/2.0/message",
  from: BOB,
  to: [ALICE],
  thid: "t1",
  created_time: 1788442800,
  expires_time: 1788446400,
  please_ack: ["", "older", ""],
  ack: ["x", "x", "y"],
  from_prior: JWT,
  lang: "en",
  body: { content: "hello" },
  attachments: [{ id: "a1", media_type: "image/png", data: { base64: base64urlnopad.encode(PHOTO) } }],
};

describe("readPlaintext", () => {
  it("takes a plaintext apart into intent, stored content and addressing", () => {
    const read = readPlaintext(PLAINTEXT);
    const stored = storeMessage(PLAINTEXT.body, PLAINTEXT.attachments);
    expect(read.intent).toEqual({
      id: PLAINTEXT.id,
      type: PLAINTEXT.type,
      thid: "t1",
      pthid: null,
      document: stored.document,
      createdTime: 1788442800,
      expiresTime: 1788446400,
      pleaseAck: ["", "older", ""],
      ack: ["x", "x", "y"],
      headers: { lang: "en" },
    });
    expect(read.stored.bodyCid).toBe(stored.bodyCid);
    expect(read.stored.attachmentCids).toEqual([rawCidOfBytes(PHOTO)]);
    expect(read.typ).toBe(PLAINTEXT_TYP);
    expect(read.from).toBe(BOB);
    expect(read.to).toEqual([ALICE]);
    expect(read.fromPrior).toBe(JWT);
    expect(read.plaintext).toBe(PLAINTEXT);
  });

  it("hashes the exact plaintext and the intent projection as unpadded base64url SHA-256 of their canonical JSON", () => {
    const read = readPlaintext(PLAINTEXT);
    expect(read.plaintextHash).toBe(hashOf(PLAINTEXT));
    expect(plaintextHash(PLAINTEXT)).toBe(read.plaintextHash);
    const projection = {
      semantic: {
        id: PLAINTEXT.id,
        type: PLAINTEXT.type,
        thid: "t1",
        pthid: null,
        body: { content: "hello" },
        attachments: read.stored.document.attachments,
      },
      created_time: 1788442800,
      expires_time: 1788446400,
      please_ack: ["", "older", ""],
      ack: ["x", "x", "y"],
      headers: { lang: "en" },
    };
    expect(intentProjection(read.intent)).toEqual(projection);
    expect(semanticProjection(read.intent)).toEqual(projection.semantic);
    expect(read.intentHash).toBe(hashOf(projection));
    expect(intentHash(read.intent)).toBe(read.intentHash);
  });

  it("reads absent and null optional headers alike, as null, [] or {}", () => {
    const bare = readPlaintext({ id: "m", type: "t", body: {} });
    expect(bare.intent).toEqual({
      id: "m",
      type: "t",
      thid: null,
      pthid: null,
      document: { body: {}, attachments: [] },
      createdTime: null,
      expiresTime: null,
      pleaseAck: null,
      ack: [],
      headers: {},
    });
    expect([bare.typ, bare.from, bare.to, bare.fromPrior]).toEqual([null, null, null, null]);
    const nulls = readPlaintext({ id: "m", type: "t", body: {}, thid: null, pthid: null, created_time: null, expires_time: null, please_ack: null, ack: null, from: null, to: null, from_prior: null, typ: null });
    expect(nulls.intent).toEqual(bare.intent);
    expect(nulls.intentHash).toBe(bare.intentHash);
    expect(nulls.plaintextHash).not.toBe(bare.plaintextHash);
  });

  it("refuses return_route and a present member of the wrong shape", () => {
    const base = { id: "m", type: "t", body: {} };
    expect(() => readPlaintext({ ...base, return_route: "all" })).toThrow(/return_route/);
    expect(() => readPlaintext({ ...base, return_route: null })).toThrow(/return_route/);
    expect(() => readPlaintext({ ...base, id: "" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, type: 3 })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, typ: "application/json" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, from: "bob" })).toThrow(/from is a DID/);
    expect(() => readPlaintext({ ...base, to: BOB })).toThrow(/to is an array/);
    expect(() => readPlaintext({ ...base, to: ["nope"] })).toThrow(/to\[0\] is a DID/);
    expect(() => readPlaintext({ ...base, thid: "" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, created_time: "1788442800" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, created_time: 10, expires_time: 10 })).toThrow(/expires_time is later/);
    expect(() => readPlaintext({ ...base, please_ack: "" })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, ack: [1] })).toThrow(InvalidPlaintext);
    expect(() => readPlaintext({ ...base, from_prior: "not.a-jwt" })).toThrow(/compact JWT/);
    expect(() => readPlaintext({ ...base, body: [] })).toThrow(/body is a JSON object/);
    expect(() => readPlaintext("{}")).toThrow(InvalidPlaintext);
  });
});

describe("the intent hash", () => {
  const read = readPlaintext(PLAINTEXT);

  it("does not change with addressing, proof or typ, which the plaintext hash covers", () => {
    for (const variant of [
      { ...PLAINTEXT, from: ALICE },
      { ...PLAINTEXT, to: [BOB, ALICE] },
      { ...PLAINTEXT, from_prior: JWT + "x" },
      without(PLAINTEXT, "typ"),
    ]) {
      const other = readPlaintext(variant);
      expect(other.intentHash).toBe(read.intentHash);
      expect(other.plaintextHash).not.toBe(read.plaintextHash);
    }
  });

  it("changes with body, type, thread, attachments, timing, ACK policy and every additional header", () => {
    for (const variant of [
      { ...PLAINTEXT, body: { content: "hello!" } },
      { ...PLAINTEXT, type: "https://didcomm.org/basicmessage/2.0/other" },
      { ...PLAINTEXT, thid: "t2" },
      { ...PLAINTEXT, pthid: "p" },
      { ...PLAINTEXT, attachments: [{ ...PLAINTEXT.attachments[0], media_type: "image/jpeg" }] },
      { ...PLAINTEXT, attachments: [] },
      { ...PLAINTEXT, created_time: 1788442801 },
      without(PLAINTEXT, "expires_time"),
      { ...PLAINTEXT, please_ack: [""] },
      without(PLAINTEXT, "please_ack"),
      { ...PLAINTEXT, ack: ["x", "y"] },
      { ...PLAINTEXT, lang: "fr" },
      { ...PLAINTEXT, custom: 1 },
    ]) {
      expect(readPlaintext(variant).intentHash).not.toBe(read.intentHash);
    }
  });

  it("is the same for every wire spelling of one closed stored attachment", () => {
    const a = PLAINTEXT.attachments[0] as (typeof PLAINTEXT.attachments)[number];
    for (const variant of [
      [{ ...a, data: { base64: base64urlnopad.encode(PHOTO) + "=".repeat((4 - (base64urlnopad.encode(PHOTO).length % 4)) % 4) } }],
      [{ ...a, description: null, filename: null, format: null, lastmod_time: null, byte_count: null }],
      [{ ...a, byte_count: PHOTO.length }],
      [{ ...a, data: { ...a.data, hash: null, jws: null } }],
      [{ ...a, presentation: { width: 10 }, data: { ...a.data, diagnostic: "x" } }],
    ]) {
      expect(readPlaintext({ ...PLAINTEXT, attachments: variant }).intentHash).toBe(read.intentHash);
    }
    const json = { id: "j", data: { json: { b: 1, a: 2 } } };
    expect(readPlaintext({ ...PLAINTEXT, attachments: [json] }).intentHash).toBe(readPlaintext({ ...PLAINTEXT, attachments: [{ id: "j", data: { json: { a: 2, b: 1 } } }] }).intentHash);
  });

  it("distinguishes null please_ack from [] and [] from a request for the current message", () => {
    const hashes = [without(PLAINTEXT, "please_ack"), ...[[], [""], [PLAINTEXT.id], ["older"]].map((please_ack) => ({ ...PLAINTEXT, please_ack }))].map((p) => readPlaintext(p).intentHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("please_ack processing", () => {
  it("expands the empty sentinel to the current wire ID and keeps the first of each target, in order", () => {
    expect(expandPleaseAck("cur", ["", "older", "", "cur", "older", "z"])).toEqual(["cur", "older", "z"]);
    expect(expandPleaseAck("cur", [])).toEqual([]);
  });

  it("requests the current message's receipt only through the sentinel or its own ID", () => {
    expect(requestsAck("cur", null)).toBe(false);
    expect(requestsAck("cur", [])).toBe(false);
    expect(requestsAck("cur", ["older"])).toBe(false);
    expect(requestsAck("cur", [""])).toBe(true);
    expect(requestsAck("cur", ["older", "cur"])).toBe(true);
  });

  it("leaves the stored array as it was", () => {
    const read = readPlaintext(PLAINTEXT);
    expandPleaseAck(PLAINTEXT.id, read.intent.pleaseAck as string[]);
    expect(read.intent.pleaseAck).toEqual(["", "older", ""]);
  });
});

describe("checkHeaders", () => {
  it("refuses every reserved name and anything but an object", () => {
    expect(checkHeaders({ lang: "en", "custom-x": [1] })).toEqual({ lang: "en", "custom-x": [1] });
    for (const name of RESERVED_HEADERS) {
      expect(() => checkHeaders({ [name]: 1 })).toThrow(new RegExp(`reserved header "${name}"`));
    }
    expect(() => checkHeaders([])).toThrow(InvalidPlaintext);
    expect(() => checkHeaders(null)).toThrow(InvalidPlaintext);
  });
});

describe("wirePlaintext", () => {
  const stored = storeMessage({ content: "hi" }, [{ id: "a1", data: { base64: base64urlnopad.encode(PHOTO) } }]);
  const payloadOf = (cid: string) => {
    const payload = stored.payloads.find((p) => p.cid === cid);
    if (payload === undefined) throw new Error(`no payload ${cid}`);
    return payload.bytes;
  };
  const intent: Intent = {
    id: "019b2a70-e2c8-7fb4-b63f-1aca32152062",
    type: "https://didcomm.org/basicmessage/2.0/message",
    thid: null,
    pthid: "p1",
    document: stored.document,
    createdTime: 1788442800,
    expiresTime: null,
    pleaseAck: [],
    ack: [],
    headers: { lang: "en" },
  };
  const addressing = { from: ALICE, to: [BOB], fromPrior: null };

  it("emits the fixed members always, optional ones only when set, and additional headers at the top level", () => {
    expect(wirePlaintext(intent, addressing, payloadOf)).toEqual({
      typ: PLAINTEXT_TYP,
      id: intent.id,
      type: intent.type,
      from: ALICE,
      to: [BOB],
      created_time: 1788442800,
      pthid: "p1",
      please_ack: [],
      lang: "en",
      body: { content: "hi" },
      attachments: [{ id: "a1", byte_count: PHOTO.length, data: { base64: base64urlnopad.encode(PHOTO) } }],
    });
    const bare = wirePlaintext({ ...intent, document: { body: {}, attachments: [] }, createdTime: null, pthid: null, pleaseAck: null, headers: {} }, { ...addressing, fromPrior: JWT }, payloadOf);
    expect(Object.keys(bare).sort()).toEqual(["body", "from", "from_prior", "id", "to", "typ", "type"]);
    expect(wirePlaintext({ ...intent, ack: ["x"], expiresTime: 1788446400 }, addressing, payloadOf)).toMatchObject({ ack: ["x"], expires_time: 1788446400 });
    expect(() => wirePlaintext({ ...intent, headers: { return_route: "all" } }, addressing, payloadOf)).toThrow(/reserved header/);
  });

  it("reads back to the same intent and intent hash, and two preparations agree", () => {
    const one = readPlaintext(wirePlaintext(intent, addressing, payloadOf));
    const two = readPlaintext(wirePlaintext(intent, { from: BOB, to: [ALICE], fromPrior: JWT }, payloadOf));
    expect(one.intent).toEqual(intent);
    expect(one.intentHash).toBe(intentHash(intent));
    expect(two.intentHash).toBe(one.intentHash);
    expect(two.plaintextHash).not.toBe(one.plaintextHash);
    expect(one.stored.bodyCid).toBe(stored.bodyCid);
  });

  it("projects a committed message.out the same as the plaintext it produces", () => {
    const out: MessageOut = {
      messageId: intent.id as MessageOut["messageId"],
      relationshipId: "35807a1e-3b8a-52f5-9580-29cd5265882e" as MessageOut["relationshipId"],
      birth: null,
      msgType: intent.type,
      thid: null,
      pthid: "p1",
      createdTime: 1788442800,
      expiresTime: null,
      pleaseAck: [],
      ack: [],
      headers: { lang: "en" },
      bodyCid: stored.bodyCid,
      attachmentCids: stored.attachmentCids,
      intentHash: intentHash(intent),
      executionId: null,
      handlerId: null,
      effectKind: null,
      ordinal: null,
      effectKey: null,
    };
    const fromEvent = intentOfOutbound(out, stored.document);
    expect(fromEvent).toEqual(intent);
    expect(intentHash(fromEvent)).toBe(readPlaintext(wirePlaintext(fromEvent, addressing, payloadOf)).intentHash);
  });
});
