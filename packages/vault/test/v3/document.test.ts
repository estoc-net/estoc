import { canonicalize, parseStrict } from "@estoc/event-store/v3";
import { base64url, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import { InvalidPlaintext, messageRoots, rawCidOfBytes, readStoredDocument, storeMessage, wireAttachment, type StoredAttachment } from "../../src/v3/index.js";

const encoder = new TextEncoder();
const PHOTO = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const PHOTO_CID = rawCidOfBytes(PHOTO);
const BODY = { text: "hello" };

const photo = (extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  id: "a1",
  filename: "photo.png",
  media_type: "image/png",
  ...extra,
  data: { base64: base64urlnopad.encode(PHOTO), ...data },
});

describe("storeMessage", () => {
  it("stores the body and every descriptor with all eight members, absent ones null", () => {
    const stored = storeMessage(BODY, [photo()]);
    expect(stored.document).toEqual({
      body: BODY,
      attachments: [
        {
          id: "a1",
          description: null,
          filename: "photo.png",
          media_type: "image/png",
          format: null,
          lastmod_time: null,
          byte_count: PHOTO.length,
          data: { kind: "base64", root: PHOTO_CID, hash: null, jws: null },
        },
      ],
    });
    expect(stored.bodyCid).toBe(rawCidOfBytes(canonicalize(stored.document)));
    expect(stored.bytes).toEqual(canonicalize(stored.document));
    expect(stored.attachmentCids).toEqual([PHOTO_CID]);
    expect(stored.roots).toEqual([stored.bodyCid, PHOTO_CID]);
    expect(stored.payloads).toEqual([{ cid: PHOTO_CID, bytes: PHOTO }]);
  });

  it("takes no attachments as none", () => {
    const stored = storeMessage(BODY, undefined);
    expect(stored.document.attachments).toEqual([]);
    expect(stored.roots).toEqual([stored.bodyCid]);
    expect(stored.payloads).toEqual([]);
  });

  it("decodes base64url padded or not and refuses the standard alphabet", () => {
    const padded = storeMessage(BODY, [photo({}, { base64: base64url.encode(PHOTO) })]);
    expect(padded.document).toEqual(storeMessage(BODY, [photo()]).document);
    expect(() => storeMessage(BODY, [photo({}, { base64: "+/8=" })])).toThrow(/not base64url/);
    expect(storeMessage(BODY, [photo({}, { base64: "-_8=" })]).payloads[0]?.bytes).toEqual(Uint8Array.from([0xfb, 0xff]));
    expect(() => storeMessage(BODY, [photo({}, { base64: 5 })])).toThrow(InvalidPlaintext);
  });

  it("canonicalizes inline JSON, so member order does not change the root or the byte count", () => {
    const a = storeMessage(BODY, [{ id: "j", data: { json: { b: [1, 2], a: "x" } } }]);
    const b = storeMessage(BODY, [{ id: "j", data: { json: { a: "x", b: [1, 2] } } }]);
    expect(a.document).toEqual(b.document);
    const bytes = canonicalize({ a: "x", b: [1, 2] });
    expect(a.attachmentCids).toEqual([rawCidOfBytes(bytes)]);
    expect(a.document.attachments[0]?.byte_count).toBe(bytes.length);
    expect(a.document.attachments[0]?.data).toEqual({ kind: "json", root: rawCidOfBytes(bytes), hash: null, jws: null });
    const nul = storeMessage(BODY, [{ data: { json: null } }]);
    expect(nul.document.attachments[0]?.data).toMatchObject({ kind: "json", root: rawCidOfBytes(encoder.encode("null")) });
  });

  it("keeps a wire byte_count that agrees with the inline content and refuses one that does not", () => {
    expect(storeMessage(BODY, [photo({ byte_count: PHOTO.length })]).document.attachments[0]?.byte_count).toBe(PHOTO.length);
    expect(() => storeMessage(BODY, [photo({ byte_count: PHOTO.length + 1 })])).toThrow(/byte_count says/);
    expect(() => storeMessage(BODY, [photo({ byte_count: -1 })])).toThrow(InvalidPlaintext);
    expect(() => storeMessage(BODY, [photo({ byte_count: 1.5 })])).toThrow(InvalidPlaintext);
  });

  it("keeps a links descriptor as its ordered links with the required hash and no payload root", () => {
    const links = ["https://b.example/2", "https://a.example/1"];
    const stored = storeMessage(BODY, [{ id: "l", data: { links, hash: "uEiA...", jws: { sig: 1 } }, byte_count: 77 }]);
    expect(stored.document.attachments[0]).toEqual({
      id: "l",
      description: null,
      filename: null,
      media_type: null,
      format: null,
      lastmod_time: null,
      byte_count: 77,
      data: { kind: "links", links, hash: "uEiA...", jws: { sig: 1 } },
    });
    expect(stored.attachmentCids).toEqual([]);
    expect(stored.roots).toEqual([stored.bodyCid]);
    expect(() => storeMessage(BODY, [{ data: { links } }])).toThrow(/hash is required/);
    expect(() => storeMessage(BODY, [{ data: { links: [], hash: "h" } }])).toThrow(InvalidPlaintext);
    expect(() => storeMessage(BODY, [{ data: { links: ["", "x"], hash: "h" } }])).toThrow(InvalidPlaintext);
  });

  it("accepts exactly one carrier", () => {
    expect(() => storeMessage(BODY, [{ data: {} }])).toThrow(/exactly one of base64, json and links, not none/);
    expect(() => storeMessage(BODY, [{ data: { base64: "aGk", json: {} } }])).toThrow(/not base64 and json/);
    expect(() => storeMessage(BODY, [{ data: { base64: "aGk", links: ["x"], hash: "h" } }])).toThrow(InvalidPlaintext);
  });

  it("drops descriptor and data members this version does not store", () => {
    const stored = storeMessage(BODY, [photo({ "@context": "x", presentation: { width: 3 } }, { diagnostics: "y" })]);
    expect(Object.keys(stored.document.attachments[0] as object).sort()).toEqual(["byte_count", "data", "description", "filename", "format", "id", "lastmod_time", "media_type"]);
    expect(Object.keys(stored.document.attachments[0]?.data as object).sort()).toEqual(["hash", "jws", "kind", "root"]);
  });

  it("restricts a present id to URI unreserved characters, independently of the filename", () => {
    expect(storeMessage(BODY, [photo({ id: "A-z0.9_~" })]).document.attachments[0]?.id).toBe("A-z0.9_~");
    expect(storeMessage(BODY, [photo({ id: null, filename: "my photo (1).png" })]).document.attachments[0]?.id).toBeNull();
    for (const id of ["", "urn:uuid:1", "a b", "a/b", "é"]) {
      expect(() => storeMessage(BODY, [photo({ id })])).toThrow(/unreserved/);
    }
  });

  it("keeps a present empty string and refuses the wrong type", () => {
    expect(storeMessage(BODY, [photo({ description: "" })]).document.attachments[0]?.description).toBe("");
    expect(() => storeMessage(BODY, [photo({ description: 1 })])).toThrow(InvalidPlaintext);
    expect(storeMessage(BODY, [photo({ lastmod_time: 1788442800 })]).document.attachments[0]?.lastmod_time).toBe(1788442800);
    expect(() => storeMessage(BODY, [photo({ lastmod_time: "2026" })])).toThrow(InvalidPlaintext);
    expect(() => storeMessage(BODY, [photo({ lastmod_time: 1.5 })])).toThrow(InvalidPlaintext);
  });

  it("keeps the hash and the jws exactly", () => {
    const jws = { protected: "eyJ", signature: "c2ln" };
    const stored = storeMessage(BODY, [photo({}, { hash: "uEiB", jws })]);
    expect(stored.document.attachments[0]?.data).toEqual({ kind: "base64", root: PHOTO_CID, hash: "uEiB", jws });
    expect(() => storeMessage(BODY, [photo({}, { hash: "" })])).toThrow(InvalidPlaintext);
  });

  it("names each payload root once, in attachment order, after the body", () => {
    const other = encoder.encode("other");
    const stored = storeMessage(BODY, [photo({ id: "one" }), { id: "two", data: { base64: base64urlnopad.encode(other) } }, photo({ id: "three" })]);
    expect(stored.attachmentCids).toEqual([PHOTO_CID, rawCidOfBytes(other)]);
    expect(stored.payloads.map((p) => p.cid)).toEqual(stored.attachmentCids);
    expect(messageRoots(stored.bodyCid, [stored.bodyCid, PHOTO_CID, PHOTO_CID])).toEqual([stored.bodyCid, PHOTO_CID]);
  });

  it("requires a body object and an attachments array", () => {
    expect(() => storeMessage("hello", [])).toThrow(/body must be a JSON object/);
    expect(() => storeMessage(null, [])).toThrow(InvalidPlaintext);
    expect(() => storeMessage(BODY, {})).toThrow(/attachments must be an array/);
    expect(() => storeMessage(BODY, [null])).toThrow(InvalidPlaintext);
    expect(() => storeMessage({ bad: "\ud800" }, [])).toThrow(/not I-JSON/);
  });
});

describe("readStoredDocument", () => {
  it("reads back exactly what storeMessage wrote", () => {
    const stored = storeMessage(BODY, [photo({}, { hash: "uEiB" }), { data: { links: ["x"], hash: "h" } }, { data: { json: [1] } }]);
    expect(readStoredDocument(parseStrict(stored.bytes))).toEqual(stored.document);
  });

  it("refuses any other shape", () => {
    const stored = storeMessage(BODY, [photo()]);
    const document = parseStrict(stored.bytes) as { body: object; attachments: Record<string, unknown>[] };
    const descriptor = document.attachments[0] as Record<string, unknown>;
    const data = descriptor.data as Record<string, unknown>;
    expect(() => readStoredDocument({ ...document, extra: 1 })).toThrow(/exactly body and attachments/);
    expect(() => readStoredDocument({ body: document.body })).toThrow(InvalidPlaintext);
    expect(() => readStoredDocument({ body: [], attachments: [] })).toThrow(InvalidPlaintext);
    const { format: _format, ...missing } = descriptor;
    expect(() => readStoredDocument({ ...document, attachments: [missing] })).toThrow(/exactly the stored descriptor members/);
    expect(() => readStoredDocument({ ...document, attachments: [{ ...descriptor, id: "urn:x" }] })).toThrow(/unreserved/);
    expect(() => readStoredDocument({ ...document, attachments: [{ ...descriptor, data: { ...data, kind: "inline" } }] })).toThrow(/kind must be base64, json or links/);
    expect(() => readStoredDocument({ ...document, attachments: [{ ...descriptor, data: { ...data, root: "bafy" } }] })).toThrow(/raw DASL CID/);
    expect(() => readStoredDocument({ ...document, attachments: [{ ...descriptor, data: { ...data, links: ["x"] } }] })).toThrow(/exactly the stored base64 members/);
    expect(() => readStoredDocument({ ...document, attachments: [{ ...descriptor, data: { kind: "links", links: ["x"], hash: null, jws: null } }] })).toThrow(/multihash/);
    expect(() => readStoredDocument({ ...document, attachments: [{ ...descriptor, byte_count: -2 }] })).toThrow(InvalidPlaintext);
  });

  it("requires the byte count of inline content, which only a links descriptor may leave unknown", () => {
    const stored = storeMessage(BODY, [photo(), { data: { json: [1] } }, { data: { links: ["x"], hash: "h" } }]);
    const document = parseStrict(stored.bytes) as { body: object; attachments: Record<string, unknown>[] };
    const [base64, json, links] = document.attachments as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(links.byte_count).toBeNull();
    expect(readStoredDocument(document)).toEqual(stored.document);
    expect(() => readStoredDocument({ ...document, attachments: [{ ...base64, byte_count: null }] })).toThrow(/byte_count must be the length of the inline base64 payload/);
    expect(() => readStoredDocument({ ...document, attachments: [{ ...json, byte_count: null }] })).toThrow(/byte_count must be the length of the inline json payload/);
  });
});

describe("wireAttachment", () => {
  it("puts a stored descriptor back on the wire and storing it again yields the same document", () => {
    const wire = [
      photo({ description: "", lastmod_time: 7 }, { hash: "uEiB", jws: { s: 1 } }),
      { data: { json: { z: 1, a: [true] } } },
      { id: "l", data: { links: ["u"], hash: "h" }, byte_count: 3 },
    ];
    const stored = storeMessage(BODY, wire);
    const bytesOf = new Map(stored.payloads.map((p) => [p.cid, p.bytes]));
    const again = stored.document.attachments.map((a) => wireAttachment(a, a.data.kind === "links" ? null : (bytesOf.get(a.data.root) as Uint8Array)));
    expect(again[0]).toEqual({
      id: "a1",
      description: "",
      filename: "photo.png",
      media_type: "image/png",
      lastmod_time: 7,
      byte_count: PHOTO.length,
      data: { base64: base64urlnopad.encode(PHOTO), hash: "uEiB", jws: { s: 1 } },
    });
    expect(again[1]).toEqual({ byte_count: canonicalize({ a: [true], z: 1 }).length, data: { json: { a: [true], z: 1 } } });
    expect(again[2]).toEqual({ id: "l", byte_count: 3, data: { links: ["u"], hash: "h" } });
    const restored = storeMessage(BODY, again);
    expect(restored.document).toEqual(stored.document);
    expect(restored.bodyCid).toBe(stored.bodyCid);
  });

  it("refuses bytes that are not the named payload", () => {
    const descriptor = storeMessage(BODY, [photo()]).document.attachments[0] as StoredAttachment;
    expect(() => wireAttachment(descriptor, encoder.encode("not the photo"))).toThrow(/not the object/);
    expect(() => wireAttachment(descriptor, null)).toThrow(/needs its payload/);
  });

  it("refuses a payload the descriptor's byte count or canonical form disagrees with, instead of emitting what a receiver would store differently", () => {
    const stored = storeMessage(BODY, [{ data: { json: { z: 1, a: 2 } } }]);
    const json = stored.document.attachments[0] as StoredAttachment;
    const payload = (stored.payloads[0] as { bytes: Uint8Array }).bytes;
    expect(() => wireAttachment({ ...json, byte_count: payload.length + 1 }, payload)).toThrow(/not the stored byte_count/);
    const uncanonical = encoder.encode('{"z":1,"a":2}');
    const renamed = { ...json, data: { ...json.data, root: rawCidOfBytes(uncanonical) } } as StoredAttachment;
    expect(() => wireAttachment(renamed, uncanonical)).toThrow(/not in canonical form/);
    expect(storeMessage(BODY, [wireAttachment(json, payload)]).document).toEqual(stored.document);
  });
});
