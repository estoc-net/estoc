import { describe, expect, it } from "vitest";

import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { MemoryVault, canonicalize, type JsonObject } from "@estoc/event-store/v3";
import { canonicalPublicKey, didKeyName, peerResolution, rawCidOfBytes, scanVault, type DidId, type Did } from "@estoc/vault/v3";

import { AgentTrace, DEFINITIVE_TRANSPORT_CODES, MAX_DOCUMENT_BYTES, authorizedKeys, commitResolution, didcommDocumentOf, knownLongForms, resolve, webDidUrl, type KnownLongForms, type Resolution, type ResolverOptions } from "../../src/v3/index.js";
import { MEDIATOR_HTTP } from "../fake-mediator.js";
import { freshVault, json, newMediator, party, webFetch, webIdentity } from "./helpers.js";

const none = () => null;
const BOB = "did:web:bob.example";
const BOB_URL = "https://bob.example/.well-known/did.json";
const LOCAL_KEY = didKeyName("019b0000-0000-7000-8000-00000000000b" as DidId, "key-agreement");

async function resolved(presented: string, known: KnownLongForms, options?: ResolverOptions): Promise<Resolution> {
  const outcome = await resolve(presented, known, options);
  if (outcome.outcome !== "resolved") throw new Error(`${presented}: ${outcome.outcome}: ${outcome.reason}`);
  return outcome.resolution;
}

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
      ["a controller that is not a DID", (d) => (method(d, 1)["controller"] = 3), "verificationMethod[1] has a DID controller if any"],
      ["a method with two keys", (d) => (method(d, 1)["publicKeyMultibase"] = "z6Mk"), "carries one of publicKeyMultibase and publicKeyJwk"],
      ["a JWK with a private member", (d) => ((method(d, 1)["publicKeyJwk"] as JsonObject)["d"] = "secret"), "without the private member d"],
      ["a service without an ID", (d) => delete service(d)["id"], "service[0] has a string id"],
      ["a service without a type", (d) => delete service(d)["type"], "service[0] has a type"],
      ["an endpoint that is not a URI", (d) => ((service(d)["serviceEndpoint"] as JsonObject)["uri"] = "not a URI"), "whose uri is a URI"],
      ["a string endpoint that is not a URI", (d) => (service(d)["serviceEndpoint"] = "not a URI"), "serviceEndpoint that is a URI"],
      ["two services under one ID", (d) => (d["service"] as JsonObject[]).push({ ...service(d) }), `two services are ${BOB}#didcomm`],
      ["a service ID that is neither a DID URL nor a fragment", (d) => (service(d)["id"] = "didcomm"), "service[0].id is a DID URL or a fragment reference"],
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
