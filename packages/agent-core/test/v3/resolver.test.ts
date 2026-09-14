import { describe, expect, it } from "vitest";

import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { MemoryVault, canonicalize, type JsonObject } from "@estoc/event-store/v3";
import { canonicalPublicKey, didKeyName, peerResolution, rawCidOfBytes, scanVault, type DidId, type Did } from "@estoc/vault/v3";

import bs58 from "bs58";
import { bases } from "multiformats/basics";

import { secretsResolverFor } from "../../src/index.js";
import { AgentTrace, DEFINITIVE_TRANSPORT_CODES, MAX_DOCUMENT_BYTES, authorizedKeys, commitResolution, didcommDocumentOf, knownLongForms, resolve, webDidUrl, type KnownLongForms, type Resolution, type ResolverOptions } from "../../src/v3/index.js";
import { MEDIATOR_HTTP } from "../fake-mediator.js";
import { didcomm, freshVault, json, newMediator, party, webFetch, webIdentity } from "./helpers.js";

const none = () => null;
const BOB = "did:web:bob.example";
const BOB_URL = "https://bob.example/.well-known/did.json";
const LOCAL_KEY = didKeyName("019b0000-0000-7000-8000-00000000000b" as DidId, "key-agreement");

async function resolved(presented: string, known: KnownLongForms, options?: ResolverOptions): Promise<Resolution> {
  const outcome = await resolve(presented, known, options);
  if (outcome.outcome !== "resolved") throw new Error(`${presented}: ${outcome.outcome}: ${outcome.reason}`);
  return outcome.resolution;
}

const ZERO_COORDINATE = Buffer.alloc(32).toString("base64url");
const answering = (respond: () => Response | Promise<Response>) => webFetch({ [BOB_URL]: respond }).fetch;
const failing = (err: unknown) => answering(() => Promise.reject(err));
const coded = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("did:peer:4", () => {
  it("a long form resolves from itself, to exactly what the vault retains", async () => {
    const mediator = await newMediator();
    const resolution = await resolved(mediator.did, none);
    const retained = peerResolution(mediator.did);
    expect(resolution).toMatchObject({ presentedDid: mediator.did, did: longToShort(mediator.did), cid: retained.cid, document: retained.document });
    expect(resolution.bytes).toEqual(retained.bytes);
    expect(resolution.authenticationMethodIds).toEqual([`${mediator.did}#key-1`]);
    expect(resolution.keyAgreementMethodIds).toEqual([`${mediator.did}#key-2`]);
    expect(resolution.service).toBe(MEDIATOR_HTTP);
    expect([...authorizedKeys(resolution, "keyAgreement").keys()]).toEqual([`${mediator.did}#key-2`]);
  });

  it("a short form resolves only through a long form in evidence, to the same document and CID under the short spelling", async () => {
    const mediator = await newMediator();
    const shortForm = longToShort(mediator.did);
    expect(await resolve(shortForm, none)).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("no long form") });

    const p = await party(mediator);
    const known = knownLongForms(await scanVault(p.runtime.vault, p.keys));
    expect(known(shortForm as Did)).toBe(mediator.did);
    expect(known(longToShort(p.created.data.me.did) as Did)).toBe(p.created.data.me.did);
    const resolution = await resolved(shortForm, known);
    expect(resolution).toMatchObject({ presentedDid: shortForm, did: shortForm, cid: peerResolution(mediator.did).cid });
    expect(resolution.document["id"]).toBe(mediator.did);
    await p.runtime.close();
  });

  it("a long form whose document is not one, and every other did:peer, is definitive", async () => {
    const mediator = await newMediator();
    const tampered = mediator.did.slice(0, -1) + (mediator.did.endsWith("a") ? "b" : "a");
    expect(await resolve(tampered, none)).toMatchObject({ outcome: "definitive" });
    const dangling = encodeLongForm({ authentication: ["#nowhere"] });
    expect(await resolve(dangling, none)).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("references no verification method") });
    expect(await resolve("did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc", none)).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("numalgo 4") });
  });

  it("an invalid long form in evidence, however early it sorts, never stands in for the valid one beside it", async () => {
    const { runtime, keys } = await freshVault();
    const mediator = await newMediator(201);
    const good = mediator.did;
    const bad = good.slice(0, -1) + (good.endsWith("a") ? "b" : "a");
    const shortForm = longToShort(good) as Did;
    const resolution = await resolved(good, none);
    const [peerPublicKey] = authorizedKeys(resolution, "keyAgreement").values();
    const event = await commitResolution(runtime, { resolution, localKeyName: LOCAL_KEY, peerPublicKey: peerPublicKey as never });
    const poisoned = { ...event, author: "019b0000-0000-7000-8000-00000000000e", eventId: "019b0000-0000-7000-8000-00000000000d", at: "2025-01-01T00:00:00.000Z", data: { ...event.data, presentedDid: bad } };
    await runtime.ingest([poisoned]);
    const fold = await scanVault(runtime.vault, keys);
    expect(fold.checks.resolutionChecks.get(poisoned.eventId as never)).toBe("invalid");
    expect(fold.checks.resolutionChecks.get(event.eventId)).toBe("verified");
    expect(fold.set.of("peer.resolved").map((e) => e.eventId)).toEqual([poisoned.eventId, event.eventId]);
    expect(knownLongForms(fold)(shortForm)).toBe(good);
    expect((await resolved(shortForm, knownLongForms(fold))).cid).toBe(resolution.cid);

    const onlyInvalid = new MemoryVault({ metadata: runtime.metadata });
    await onlyInvalid.ingest([poisoned]);
    const alone = await scanVault(onlyInvalid.vault, keys);
    expect(knownLongForms(alone)(shortForm)).toBeNull();
    expect(await resolve(shortForm, knownLongForms(alone))).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("no long form") });
    await runtime.close();
  });
});

describe("other methods", () => {
  it("are definitive without a network", async () => {
    expect(await resolve("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", none, { fetch: () => Promise.reject(new Error("no")) })).toMatchObject({ outcome: "definitive", reason: "unsupported DID method key" });
    expect(await resolve("not a did", none)).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("not a DID") });
  });
});

describe("did:web URL", () => {
  it("is derived the one standard way", () => {
    const urlOf = (did: string, insecureLoopback = false) => {
      const derived = webDidUrl(did, insecureLoopback);
      return "url" in derived ? derived.url.href : `refused: ${derived.refused}`;
    };
    expect(urlOf("did:web:bob.example")).toBe(BOB_URL);
    expect(urlOf("did:web:bob.example:user:alice")).toBe("https://bob.example/user/alice/did.json");
    expect(urlOf("did:web:bob.example%3A8443:dids")).toBe("https://bob.example:8443/dids/did.json");
    expect(urlOf("did:web:Bob.Example")).toBe(BOB_URL);
    expect(urlOf("did:web:localhost%3A8080", true)).toBe("http://localhost:8080/.well-known/did.json");
  });

  it("refuses what an agent's fetch must never reach", () => {
    const refused = (did: string, insecureLoopback = false) => {
      const derived = webDidUrl(did, insecureLoopback);
      return "refused" in derived ? derived.refused : `url: ${derived.url.href}`;
    };
    expect(refused("did:web:localhost%3A8080")).toBe("a loopback authority");
    expect(refused("did:web:localhost.")).toBe("a loopback authority");
    expect(refused("did:web:127.0.0.1")).toBe("a loopback authority");
    expect(refused("did:web:10.0.0.1")).toBe("an IP-literal authority");
    expect(refused("did:web:%5B2001%3Adb8%3A%3A1%5D")).toBe("an IP-literal authority");
    expect(refused("did:web:0x7f000001")).toBe("a loopback authority");
    expect(refused("did:web:printer.local")).toContain("a reserved name");
    expect(refused("did:web:printer.local.")).toContain("a reserved name");
    expect(refused("did:web:vault.internal")).toContain("a reserved name");
    expect(refused("did:web:1.0.0.10.in-addr.arpa")).toContain("a reserved name");
    expect(refused("did:web:alice%40bob.example")).toContain("nothing else");
    expect(refused("did:web:bob.example%2Fadmin")).toContain("nothing else");
    expect(refused("did:web:bob.example:..:secret")).toContain("path segment");
    expect(refused("did:web:bob.example:a%2Fb")).toContain("path segment");
    expect(refused("did:web:bob.example:did.json%3Fx")).toContain("path segment");
    expect(refused("did:web:bob.example:")).toContain("path segment");
    expect(refused("did:web:%ZZ")).toContain("percent-encoded");
    expect(refused("did:web:")).toContain("nothing else");
  });
});

describe("did:web resolution", () => {
  it("fetches the derived URL over the transport, uncached, without following redirects, and retains the document as the vault does", async () => {
    const bob = await webIdentity(BOB);
    const { fetch, calls } = webFetch({ [BOB_URL]: (init) => (init?.redirect === "manual" && init.cache === "no-store" && init.signal instanceof AbortSignal ? json(bob.document) : new Response("", { status: 500 })) });
    const resolution = await resolved(BOB, none, { fetch });
    const bytes = canonicalize(bob.document);
    expect(resolution).toMatchObject({ presentedDid: BOB, did: BOB, document: bob.document, cid: rawCidOfBytes(bytes), service: "https://bob.example/didcomm" });
    expect(resolution.bytes).toEqual(bytes);
    expect(resolution.authenticationMethodIds).toEqual([`${BOB}#auth`]);
    expect(resolution.keyAgreementMethodIds).toEqual([`${BOB}#agree`]);
    expect(authorizedKeys(resolution, "keyAgreement").get(`${BOB}#agree` as never)).toBe(canonicalPublicKey(bob.secrets[1]?.privateKeyJwk as never));
    expect(calls).toEqual([BOB_URL]);
    expect(await resolve(BOB, none)).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("no transport") });
  });

  it("the document must call itself by the presented string, byte for byte: host case never folds two DIDs into one", async () => {
    const bob = await webIdentity(BOB);
    const Bob = await webIdentity("did:web:Bob.Example");
    const { fetch } = webFetch({ [BOB_URL]: () => json(bob.document) });
    expect(await resolve("did:web:Bob.Example", none, { fetch })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining(`"${BOB}"'s, not did:web:Bob.Example's`) });
    const upper = webFetch({ [BOB_URL]: () => json(Bob.document) });
    const resolution = await resolved("did:web:Bob.Example", none, { fetch: upper.fetch });
    expect(resolution.did).toBe("did:web:Bob.Example");
    expect(resolution.cid).not.toBe((await resolved(BOB, none, { fetch })).cid);
    expect(await resolve(BOB, none, { fetch: upper.fetch })).toMatchObject({ outcome: "definitive" });
  });

  it("tells no answer now from an answer that closes the attempt", async () => {
    const bob = await webIdentity(BOB);
    for (const status of [408, 429, 500, 502, 503]) {
      expect(await resolve(BOB, none, { fetch: answering(() => new Response("", { status })) })).toEqual({ outcome: "unavailable", reason: `HTTP ${status}` });
    }
    for (const status of [404, 410]) {
      expect(await resolve(BOB, none, { fetch: answering(() => new Response("", { status })) })).toMatchObject({ outcome: "definitive", reason: `HTTP ${status}: not found or deactivated` });
    }
    expect(await resolve(BOB, none, { fetch: answering(() => new Response("", { status: 401 })) })).toEqual({ outcome: "definitive", reason: "HTTP 401" });
    expect(await resolve(BOB, none, { fetch: answering(() => Response.redirect("https://elsewhere.example/did.json", 302)) })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("redirect") });
    expect(await resolve(BOB, none, { fetch: answering(() => new Response("{", { status: 200 })) })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("strict JSON") });
    expect(await resolve(BOB, none, { fetch: answering(() => json([bob.document])) })).toMatchObject({ outcome: "definitive", reason: "the document is not a JSON object" });
    expect(await resolve(BOB, none, { fetch: answering(() => json({ ...bob.document, keyAgreement: [`${BOB}#nowhere`] })) })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("references no verification method") });
    expect(await resolve(BOB, none, { fetch: answering(() => json(bob.document)), maxBytes: 100 })).toMatchObject({ outcome: "definitive", reason: "the document is larger than 100 bytes" });
    const padded = { ...bob.document, note: "x".repeat(MAX_DOCUMENT_BYTES) };
    expect(await resolve(BOB, none, { fetch: answering(() => json(padded)) })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("larger than") });
  });

  it("a transport failure is final only by the transport's own code, found down the cause chain; the reason keeps the cause", async () => {
    const refusal = "bob.example resolves to 10.0.0.7, not a public address";
    expect(await resolve(BOB, none, { fetch: failing(new TypeError("fetch failed", { cause: coded(DEFINITIVE_TRANSPORT_CODES.refused, refusal) })) })).toEqual({ outcome: "definitive", reason: `the transport refused the connection: fetch failed: ${refusal}` });
    expect(await resolve(BOB, none, { fetch: failing(coded("EBLOCKED", refusal)) })).toEqual({ outcome: "definitive", reason: `the transport refused the connection: ${refusal}` });
    expect(await resolve(BOB, none, { fetch: failing(new TypeError("fetch failed", { cause: coded(DEFINITIVE_TRANSPORT_CODES.noAddress, "no such name: bob.example") })) })).toEqual({ outcome: "definitive", reason: "the authority has no address: fetch failed: no such name: bob.example" });
    for (const code of ["ENOTFOUND", "ENODATA", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
      expect(await resolve(BOB, none, { fetch: failing(new TypeError("fetch failed", { cause: coded(code) })) })).toEqual({ outcome: "unavailable", reason: `the fetch failed: fetch failed: ${code}` });
      expect(await resolve(BOB, none, { fetch: failing(coded(code)) })).toEqual({ outcome: "unavailable", reason: `the fetch failed: ${code}` });
    }
    expect(await resolve(BOB, none, { fetch: failing(new TypeError("fetch failed")) })).toEqual({ outcome: "unavailable", reason: "the fetch failed: fetch failed" });
    expect(await resolve(BOB, none, { fetch: failing("no") })).toEqual({ outcome: "unavailable", reason: "the fetch failed: no" });

    const generic = (cause: unknown) => Object.assign(new Error("network operation failed", { cause }), { code: "ERR_NETWORK" });
    expect(await resolve(BOB, none, { fetch: failing(generic(coded("EBLOCKED", refusal))) })).toEqual({ outcome: "definitive", reason: `the transport refused the connection: network operation failed: ${refusal}` });
    expect(await resolve(BOB, none, { fetch: failing(generic(coded("ENXDOMAIN", "no such name"))) })).toEqual({ outcome: "definitive", reason: "the authority has no address: network operation failed: no such name" });
    expect(await resolve(BOB, none, { fetch: failing(generic(coded("ENOTFOUND"))) })).toEqual({ outcome: "unavailable", reason: "the fetch failed: network operation failed: ENOTFOUND" });
    expect(await resolve(BOB, none, { fetch: failing({ code: "EBLOCKED", message: refusal }) })).toEqual({ outcome: "definitive", reason: `the transport refused the connection: ${refusal}` });
    expect(await resolve(BOB, none, { fetch: failing({ code: "ECONNRESET", message: "reset" }) })).toEqual({ outcome: "unavailable", reason: "the fetch failed: reset" });

    const bodyFailing = (err: unknown) => answering(() => new Response(new ReadableStream({ start: (controller) => controller.error(err) }), { status: 200 }));
    expect(await resolve(BOB, none, { fetch: bodyFailing(coded("EBLOCKED", refusal)) })).toEqual({ outcome: "definitive", reason: `the transport refused the connection: ${refusal}` });
    expect(await resolve(BOB, none, { fetch: bodyFailing(generic(coded("ENXDOMAIN", "no such name"))) })).toEqual({ outcome: "definitive", reason: "the authority has no address: network operation failed: no such name" });
    expect(await resolve(BOB, none, { fetch: bodyFailing(coded("ECONNRESET")) })).toEqual({ outcome: "unavailable", reason: "the body did not arrive whole: ECONNRESET" });
  });

  it("a body past the bound is definitive once it is past, whatever letting the stream go comes to", async () => {
    const never = () => new Promise<never>(() => undefined);
    for (const cancel of [() => undefined, () => Promise.reject(new Error("cancel failed")), never]) {
      const oversize = answering(() => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array(65)), cancel }), { status: 200 }));
      expect(await resolve(BOB, none, { fetch: oversize, maxBytes: 64, timeoutMs: 20 })).toEqual({ outcome: "definitive", reason: "the document is larger than 64 bytes" });
    }
  });

  it("one deadline covers the whole resolution, and the diagnostic neither holds the outcome nor overturns it", async () => {
    const bob = await webIdentity(BOB);
    const never = () => new Promise<never>(() => undefined);
    const timedOut = { outcome: "unavailable", reason: "timed out: not resolved within 20 ms" };
    const cooperative: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)));
    expect(await resolve(BOB, none, { fetch: cooperative, timeoutMs: 20 })).toEqual(timedOut);
    expect(await resolve(BOB, none, { fetch: never, timeoutMs: 20 })).toEqual(timedOut);
    const stalled = answering(() => new Response(new ReadableStream({ pull: never }), { status: 200 }));
    expect(await resolve(BOB, none, { fetch: stalled, timeoutMs: 20 })).toEqual(timedOut);
    const { fetch } = webFetch({ [BOB_URL]: () => json(bob.document) });
    const full = { append: () => Promise.reject(new Error("trace full")) } as unknown as AgentTrace;
    expect((await resolve(BOB, none, { fetch, trace: full })).outcome).toBe("resolved");
    const stuck = { append: never } as unknown as AgentTrace;
    expect((await resolve(BOB, none, { fetch, trace: stuck, timeoutMs: 20 })).outcome).toBe("resolved");
  });

  it("a document that is not one is definitive, whatever a converter would make of it; a method of an unknown type is kept for where its key is used", async () => {
    const bob = await webIdentity(BOB);
    const method = (d: JsonObject, i: number) => (d["verificationMethod"] as JsonObject[])[i] as JsonObject;
    const service = (d: JsonObject) => (d["service"] as JsonObject[])[0] as JsonObject;
    const broken: [string, (d: JsonObject) => void, string][] = [
      ["a relationship that is not an array", (d) => (d["authentication"] = "#auth"), "authentication is an array"],
      ["a method without a type", (d) => delete method(d, 1)["type"], "verificationMethod[1] has a string type"],
      ["a controller that is not a DID", (d) => (method(d, 1)["controller"] = 3), "verificationMethod[1] has a DID controller"],
      ["a method without a controller: nothing is filled in for a published document", (d) => delete method(d, 1)["controller"], "verificationMethod[1] has a DID controller"],
      [
        "an embedded method without a controller",
        (d) => {
          const embedded = { ...method(d, 1) };
          delete embedded["controller"];
          d["keyAgreement"] = [embedded];
        },
        "keyAgreement[0] has a DID controller",
      ],
      ["a method with two keys", (d) => (method(d, 1)["publicKeyMultibase"] = "z6Mk"), "carries publicKeyMultibase or publicKeyJwk, not both"],
      ["a JsonWebKey2020 without its JWK", (d) => delete method(d, 1)["publicKeyJwk"], "verificationMethod[1] of type JsonWebKey2020 carries publicKeyJwk"],
      ["an extra known method with no material", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "JsonWebKey2020", controller: BOB }), "verificationMethod[2] of type JsonWebKey2020 carries publicKeyJwk"],
      ["a 2020 suite with another suite's material", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "Ed25519VerificationKey2020", controller: BOB, publicKeyBase58: "z6Mk" }), "of type Ed25519VerificationKey2020 carries publicKeyMultibase"],
      ["an unknown suite with no material at all", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "UnknownSuite", controller: BOB }), "of type UnknownSuite carries its verification material"],
      ["a JWK with a private member", (d) => ((method(d, 1)["publicKeyJwk"] as JsonObject)["d"] = "secret"), "without the private member d"],
      ["a JWK with nothing in it", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "JsonWebKey2020", controller: BOB, publicKeyJwk: {} }), "has a publicKeyJwk that is a JWK with a string kty"],
      ["an OKP JWK without its coordinate", (d) => delete (method(d, 1)["publicKeyJwk"] as JsonObject)["x"], "has a publicKeyJwk that is a OKP JWK with a string x"],
      ["a multibase value of no bytes", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "Multikey", controller: BOB, publicKeyMultibase: "z" }), "has a publicKeyMultibase that is a multibase-encoded value"],
      ["a multibase value under no known prefix", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "Multikey", controller: BOB, publicKeyMultibase: "!6Mk" }), "has a publicKeyMultibase that is a multibase-encoded value"],
      ["a base58 value outside the alphabet", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "Ed25519VerificationKey2018", controller: BOB, publicKeyBase58: "0OIl" }), "has a publicKeyBase58 that is a base58btc-encoded value"],
      ["a hex value that is null", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "EcdsaSecp256k1VerificationKey2019", controller: BOB, publicKeyHex: null }), "has a publicKeyHex that is hex-encoded bytes"],
      ["a hex value of half a byte", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "EcdsaSecp256k1VerificationKey2019", controller: BOB, publicKeyHex: "abc" }), "has a publicKeyHex that is hex-encoded bytes"],
      ["a hex value that is no point on the curve", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "EcdsaSecp256k1VerificationKey2019", controller: BOB, publicKeyHex: `04${"00".repeat(64)}` }), "has a publicKeyHex that is a point on secp256k1"],
      ["an account ID that is not a string", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "EcdsaSecp256k1RecoveryMethod2020", controller: BOB, blockchainAccountId: [] }), "has a blockchainAccountId that is a CAIP-10 account ID"],
      ["an X25519 JWK with an empty coordinate", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "JsonWebKey2020", controller: BOB, publicKeyJwk: { kty: "OKP", crv: "X25519", x: "" } }), "has a publicKeyJwk that is a X25519 key: X25519 JWK member x is not 32 bytes of base64url"],
      ["an X25519 JWK outside the base64url alphabet", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "JsonWebKey2020", controller: BOB, publicKeyJwk: { kty: "OKP", crv: "X25519", x: "!".repeat(43) } }), "has a publicKeyJwk that is a X25519 key"],
      ["an X25519 JWK of one byte", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "JsonWebKey2020", controller: BOB, publicKeyJwk: { kty: "OKP", crv: "X25519", x: "AA" } }), "has a publicKeyJwk that is a X25519 key"],
      ["a P-256 JWK off the curve", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "JsonWebKey2020", controller: BOB, publicKeyJwk: { kty: "EC", crv: "P-256", x: ZERO_COORDINATE, y: ZERO_COORDINATE } }), "has a publicKeyJwk that is a P-256 key: not a point on P-256"],
      ["a secp256k1 JWK off the curve", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "EcdsaSecp256k1VerificationKey2019", controller: BOB, publicKeyJwk: { kty: "EC", crv: "secp256k1", x: ZERO_COORDINATE, y: ZERO_COORDINATE } }), "has a publicKeyJwk that is a secp256k1 key: not a point on secp256k1"],
      ["a secp256k1 suite with an Ed25519 JWK", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "EcdsaSecp256k1VerificationKey2019", controller: BOB, publicKeyJwk: method(d, 0)["publicKeyJwk"] as JsonObject }), "of type EcdsaSecp256k1VerificationKey2019 carries a secp256k1 key, not Ed25519"],
      ["a base58 X25519 key of one byte", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "X25519KeyAgreementKey2019", controller: BOB, publicKeyBase58: "1" }), "of type X25519KeyAgreementKey2019 carries a X25519 key of 32 bytes"],
      ["a multibase X25519 key of one byte", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "X25519KeyAgreementKey2020", controller: BOB, publicKeyMultibase: bases.base58btc.encode(Uint8Array.of(0xec, 1, 0)) }), "has a publicKeyMultibase that is the key its code says: X25519 key is not 32 bytes"],
      ["an Ed25519 suite with a multibase X25519 key", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "Ed25519VerificationKey2020", controller: BOB, publicKeyMultibase: canonicalPublicKey(method(d, 1)["publicKeyJwk"] as JsonObject) }), "of type Ed25519VerificationKey2020 carries a Ed25519 key, not X25519"],
      ["a Multikey under a code the vault reads with a point off the curve", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "Multikey", controller: BOB, publicKeyMultibase: bases.base58btc.encode(Uint8Array.of(0x80, 0x24, 0x04, ...new Uint8Array(64))) }), "has a publicKeyMultibase that is the key its code says: not a point on P-256"],
      ["an account ID without its chain", (d) => (d["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "EcdsaSecp256k1RecoveryMethod2020", controller: BOB, blockchainAccountId: "0xab16a96d359ec26a11e2c2b3d8f8b8942d5bfcdb" }), "has a blockchainAccountId that is a CAIP-10 account ID"],
      ["a service without an ID", (d) => delete service(d)["id"], "service[0] has a string id"],
      ["a service without a type", (d) => delete service(d)["type"], "service[0] has a type"],
      ["an endpoint that is not a URI", (d) => ((service(d)["serviceEndpoint"] as JsonObject)["uri"] = "not a URI"), "whose uri is a URI"],
      ["a string endpoint that is not a URI", (d) => (service(d)["serviceEndpoint"] = "not a URI"), "serviceEndpoint that is a URI"],
      ["an endpoint whose authority never closes", (d) => ((service(d)["serviceEndpoint"] as JsonObject)["uri"] = "https://["), "whose uri is a URI"],
      ["an endpoint with a bad percent escape", (d) => ((service(d)["serviceEndpoint"] as JsonObject)["uri"] = "https://bob.example/%GG"), "whose uri is a URI"],
      ["two services under one ID", (d) => (d["service"] as JsonObject[]).push({ ...service(d) }), `two services are ${BOB}#didcomm`],
      ["a service ID with a space", (d) => (service(d)["id"] = "did:bad key"), "service[0].id is a URI or a reference into the document"],
      ["a service ID that is a bare word", (d) => (service(d)["id"] = "didcomm"), "service[0].id is a URI or a reference into the document"],
      ["alsoKnownAs that is not strings", (d) => (d["alsoKnownAs"] = [1]), "alsoKnownAs[0] is a string"],
    ];
    for (const [what, damage, reason] of broken) {
      const document = structuredClone(bob.document);
      damage(document);
      expect(await resolve(BOB, none, { fetch: answering(() => json(document)) }), what).toMatchObject({ outcome: "definitive", reason: expect.stringContaining(reason) });
    }
    const unknown = structuredClone(bob.document);
    method(unknown, 1)["type"] = "UnknownSuite";
    const resolution = await resolved(BOB, none, { fetch: answering(() => json(unknown)) });
    expect([...authorizedKeys(resolution, "keyAgreement").keys()]).toEqual([`${BOB}#agree`]);
    expect(didcommDocumentOf(resolution).verificationMethod.map((m) => m.id)).toEqual([`${BOB}#auth`, `${BOB}#agree`]);
  });

  it("an encoded key is bounded before it is decoded: a document within the byte bound is still answered at once", async () => {
    const bob = await webIdentity(BOB);
    const long = "2".repeat(200_000);
    const short = "2".repeat(1023);
    const withMaterial = (material: JsonObject) => {
      const document = structuredClone(bob.document);
      (document["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type: "UnknownSuite", controller: BOB, ...material });
      return document;
    };
    for (const [material, reason] of [
      [{ publicKeyBase58: long }, "has a publicKeyBase58 that is a base58btc-encoded value within 1024 characters"],
      [{ publicKeyMultibase: `z${long}` }, "has a publicKeyMultibase that is a multibase-encoded value within 1024 characters"],
      [{ publicKeyHex: "ab".repeat(100_000) }, "has a publicKeyHex that is hex-encoded bytes within 1024 characters"],
    ] as const) {
      const document = withMaterial(material);
      expect(canonicalize(document).length).toBeLessThan(MAX_DOCUMENT_BYTES);
      const started = performance.now();
      expect(await resolve(BOB, none, { fetch: answering(() => json(document)) }), reason).toMatchObject({ outcome: "definitive", reason: expect.stringContaining(reason) });
      expect(performance.now() - started, reason).toBeLessThan(500);
    }
    for (const material of [{ publicKeyBase58: `1${short}` }, { publicKeyMultibase: `z${short}` }] as JsonObject[]) {
      expect((await resolve(BOB, none, { fetch: answering(() => json(withMaterial(material))) })).outcome).toBe("resolved");
    }
  });

  it("a key the vault reads must be one, in any encoding; a key of another kind is kept unread, and a multibase prefix is matched whole", async () => {
    const bob = await webIdentity(BOB);
    const agree = (structuredClone(bob.document)["verificationMethod"] as JsonObject[])[1] as JsonObject;
    const x25519 = canonicalPublicKey(agree["publicKeyJwk"] as JsonObject);
    const raw = bases.base58btc.decode(x25519);
    const kept: [string, JsonObject][] = [
      ["an Ed448 JWK", { type: "JsonWebKey2020", publicKeyJwk: { kty: "OKP", crv: "Ed448", x: "AA" } }],
      ["an RSA JWK", { type: "JsonWebKey2020", publicKeyJwk: { kty: "RSA", n: "AQAB", e: "AQAB" } }],
      ["a Multikey under a code the vault does not read", { type: "Multikey", publicKeyMultibase: bases.base58btc.encode(Uint8Array.of(0xea, 0x01, 0x00)) }],
      ["a multibase key under the base256emoji prefix", { type: "UnknownSuite", publicKeyMultibase: bases.base256emoji.encode(raw) }],
      ["a multibase key under the base64url prefix", { type: "UnknownSuite", publicKeyMultibase: bases.base64url.encode(raw) }],
    ];
    for (const [what, material] of kept) {
      for (const referenced of [false, true]) {
        const document = structuredClone(bob.document);
        (document["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, controller: BOB, ...material });
        if (referenced) (document["keyAgreement"] as string[]).push(`${BOB}#extra`);
        const resolution = await resolved(BOB, none, { fetch: answering(() => json(document)) });
        expect(resolution.document, what).toEqual(document);
        expect([...authorizedKeys(resolution, "keyAgreement").keys()], what).toEqual([`${BOB}#agree`]);
      }
    }
    const document = structuredClone(bob.document);
    (document["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#multikey`, type: "X25519KeyAgreementKey2020", controller: BOB, publicKeyMultibase: x25519 }, { id: `${BOB}#base58`, type: "X25519KeyAgreementKey2019", controller: BOB, publicKeyBase58: bs58.encode(raw.subarray(2)) });
    (document["keyAgreement"] as string[]).push(`${BOB}#multikey`, `${BOB}#base58`);
    const resolution = await resolved(BOB, none, { fetch: answering(() => json(document)) });
    expect([...authorizedKeys(resolution, "keyAgreement").entries()]).toEqual([[`${BOB}#agree`, x25519], [`${BOB}#multikey`, x25519]]);
  });

  it("a type is looked up as a suite name and nothing else, whatever name it happens to share", async () => {
    const bob = await webIdentity(BOB);
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty", "get", "size"]) {
      const document = structuredClone(bob.document);
      const auth = (document["verificationMethod"] as JsonObject[])[0] as JsonObject;
      (document["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type, controller: BOB, publicKeyJwk: auth["publicKeyJwk"] as JsonObject });
      (document["authentication"] as string[]).push(`${BOB}#extra`);
      const resolution = await resolved(BOB, none, { fetch: answering(() => json(document)) });
      expect([...authorizedKeys(resolution, "authentication").keys()], type).toEqual([`${BOB}#auth`, `${BOB}#extra`]);
      const bare = structuredClone(bob.document);
      (bare["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#extra`, type, controller: BOB });
      expect(await resolve(BOB, none, { fetch: answering(() => json(bare)) }), type).toMatchObject({ outcome: "definitive", reason: expect.stringContaining(`of type ${type} carries its verification material`) });
    }
  });

  it("a method left out of the projection takes every reference to it along, by identity, whatever form its ID takes; a reference into another document, which didcomm does not follow, goes too", async () => {
    const bob = await webIdentity(BOB);
    const point = "034ee0f670fc96bb75e8b89c068a1665007a41c98513d6a911b6137e2d16f1d300";
    const elsewhere = "did:web:carol.example#agree";
    for (const id of [`${BOB}#extra`, `${BOB}?version=2#extra`, `${BOB}/keys/extra`]) {
      const document = structuredClone(bob.document);
      (document["verificationMethod"] as JsonObject[]).push({ id, type: "EcdsaSecp256k1VerificationKey2019", controller: BOB, publicKeyHex: point });
      (document["keyAgreement"] as string[]).push(id, elsewhere);
      const resolution = await resolved(BOB, none, { fetch: answering(() => json(document)) });
      expect(resolution.keyAgreementMethodIds, id).toEqual([`${BOB}#agree`, id, elsewhere]);
      expect([...authorizedKeys(resolution, "keyAgreement").keys()], id).toEqual([`${BOB}#agree`]);
      const projection = didcommDocumentOf(resolution);
      expect(projection.verificationMethod.map((m) => m.id), id).toEqual([`${BOB}#auth`, `${BOB}#agree`]);
      expect(projection.keyAgreement, id).toEqual([`${BOB}#agree`]);
      const plaintext = { id: "m1", typ: "application/didcomm-plain+json", type: "https://didcomm.org/basicmessage/2.0/message", to: [BOB], body: { content: "hi" } };
      const resolver = { resolve: async (did: string) => (did === BOB ? projection : null) };
      const [packed] = await new didcomm.Message(plaintext).pack_encrypted(BOB, null, null, resolver, secretsResolverFor([]), { forward: false });
      const [opened] = await didcomm.Message.unpack(packed, resolver, secretsResolverFor(bob.secrets), {});
      expect(opened.as_value().body, id).toEqual({ content: "hi" });
    }
  });

  it("what a published document carries beyond this agent's use is kept, its keys simply not selectable, and the document still seals", async () => {
    const bob = await webIdentity(BOB);
    const document = structuredClone(bob.document);
    const auth = (document["verificationMethod"] as JsonObject[])[0] as JsonObject;
    (document["service"] as JsonObject[]).push({ id: "https://bob.example/profile-service", type: "LinkedDomains", serviceEndpoint: "https://bob.example/" });
    (document["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#legacy`, type: "Ed25519VerificationKey2018", controller: BOB, publicKeyBase58: bs58.encode(Buffer.from((auth["publicKeyJwk"] as JsonObject)["x"] as string, "base64url")) });
    (document["verificationMethod"] as JsonObject[]).push({ id: `${BOB}#recovery`, type: "EcdsaSecp256k1RecoveryMethod2020", controller: BOB, blockchainAccountId: "eip155:1:0xab16a96d359ec26a11e2c2b3d8f8b8942d5bfcdb" });
    (document["authentication"] as string[]).push(`${BOB}#legacy`, `${BOB}#recovery`);
    const resolution = await resolved(BOB, none, { fetch: answering(() => json(document)) });
    expect(resolution.service).toBe("https://bob.example/didcomm");
    expect(resolution.authenticationMethodIds).toEqual([`${BOB}#auth`, `${BOB}#legacy`, `${BOB}#recovery`]);
    expect([...authorizedKeys(resolution, "authentication").keys()]).toEqual([`${BOB}#auth`]);
    expect([...authorizedKeys(resolution, "keyAgreement").keys()]).toEqual([`${BOB}#agree`]);
    expect((resolution.document["verificationMethod"] as JsonObject[]).map((m) => m["id"])).toEqual([`${BOB}#auth`, `${BOB}#agree`, `${BOB}#legacy`, `${BOB}#recovery`]);
    const projection = didcommDocumentOf(resolution);
    expect(projection.verificationMethod.map((m) => m.id)).toEqual([`${BOB}#auth`, `${BOB}#agree`, `${BOB}#legacy`]);
    expect(projection.authentication).toEqual([`${BOB}#auth`, `${BOB}#legacy`]);
    expect(projection.keyAgreement).toEqual([`${BOB}#agree`]);
    const plaintext = { id: "m1", typ: "application/didcomm-plain+json", type: "https://didcomm.org/basicmessage/2.0/message", to: [BOB], body: { content: "hi" } };
    const [packed] = await new didcomm.Message(plaintext).pack_encrypted(BOB, null, null, { resolve: async () => projection }, secretsResolverFor([]), { forward: false });
    const [opened] = await didcomm.Message.unpack(packed, { resolve: async () => projection }, secretsResolverFor(bob.secrets), {});
    expect(opened.as_value().body).toEqual({ content: "hi" });
  });

  it("a URI is one by RFC 3986, component by component, on the raw string", async () => {
    const bob = await webIdentity(BOB);
    const withEndpoint = (uri: string) => {
      const document = structuredClone(bob.document);
      ((document["service"] as JsonObject[])[0] as JsonObject)["serviceEndpoint"] = uri;
      return document;
    };
    const withId = (uri: string) => {
      const document = structuredClone(bob.document);
      ((document["service"] as JsonObject[])[0] as JsonObject)["id"] = uri;
      return document;
    };
    for (const uri of ["https://bob.example/%5Broute%5D", "https://[2001:db8::1]/didcomm", "https://[2001:db8::192.0.2.1]:8443/didcomm", "https://[v1.fe]/didcomm", "https://bob.example/didcomm#service", "https://bob.example/didcomm?x=1&y=/?", "urn:example:route", "mailto:bob@bob.example", "https://user@bob.example:8443/"]) {
      expect((await resolved(BOB, none, { fetch: answering(() => json(withEndpoint(uri))) })).service, uri).toBe(uri);
      expect((await resolve(BOB, none, { fetch: answering(() => json(withId(uri))) })).outcome, uri).toBe("resolved");
    }
    for (const uri of ["https://bob.example/[route]", "https://bob.example/didcomm#service#more", "urn:example:route[bad]", "https://bob.example/didcomm\n", "https://bob.example/didcomm\r", "https://[2001:db8::1", "https://[2001:db8::1%25eth0]/", "https://[2001:db8::1.2.3]/", "https://bob.example:8a/", "https://bob.example/%G", "//bob.example/didcomm", "bob.example/didcomm"]) {
      expect(await resolve(BOB, none, { fetch: answering(() => json(withEndpoint(uri))) }), uri).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("serviceEndpoint that is a URI") });
      expect(await resolve(BOB, none, { fetch: answering(() => json(withId(uri))) }), uri).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("service[0].id is a URI") });
    }
  });

  it("a policy refusal is definitive before any fetch; the loopback allowance is honoured", async () => {
    const bob = await webIdentity("did:web:localhost%3A8080");
    const { fetch, calls } = webFetch({ "http://localhost:8080/.well-known/did.json": () => json(bob.document) });
    expect(await resolve("did:web:localhost%3A8080", none, { fetch })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("loopback") });
    expect(await resolve("did:web:10.0.0.1", none, { fetch })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("IP-literal") });
    expect(await resolve("did:web:printer.local", none, { fetch })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("reserved name") });
    expect(calls).toEqual([]);
    const resolution = await resolved("did:web:localhost%3A8080", none, { fetch, insecureLoopback: true });
    expect(resolution.did).toBe("did:web:localhost%3A8080");
    expect(calls).toEqual(["http://localhost:8080/.well-known/did.json"]);
  });

  it("every network resolution is a diag entry", async () => {
    const { runtime, keys } = await freshVault();
    const trace = await AgentTrace.open(runtime.local);
    const bob = await webIdentity(BOB);
    const { fetch } = webFetch({ [BOB_URL]: () => json(bob.document) });
    const resolution = await resolved(BOB, none, { fetch, trace });
    await resolve("did:web:gone.example", none, { fetch, trace });
    const entries = await trace.read({ stream: "diag" });
    expect(entries.map((entry) => entry.type)).toEqual(["diag.resolve", "diag.resolve"]);
    expect(entries[0]?.data).toMatchObject({ did: BOB, url: BOB_URL, outcome: "resolved", cid: resolution.cid });
    expect(entries[1]?.data).toMatchObject({ did: "did:web:gone.example", outcome: "definitive", reason: expect.stringContaining("404") });

    const peerPublicKey = authorizedKeys(resolution, "keyAgreement").get(`${BOB}#agree` as never) as never;
    const event = await commitResolution(runtime, { resolution, localKeyName: LOCAL_KEY, peerPublicKey });
    expect(knownLongForms(await scanVault(runtime.vault, keys))(BOB as Did)).toBeNull();
    expect(event.data.did).toBe(BOB);
    await runtime.close();
  });
});
