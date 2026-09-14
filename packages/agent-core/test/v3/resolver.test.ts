import { describe, expect, it } from "vitest";

import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { canonicalize } from "@estoc/event-store/v3";
import { canonicalPublicKey, didKeyName, peerResolution, rawCidOfBytes, scanVault, type DidId, type Did } from "@estoc/vault/v3";

import { AgentTrace, MAX_DOCUMENT_BYTES, authorizedKeys, commitResolution, knownLongForms, resolve, webDidUrl, type KnownLongForms, type Resolution, type ResolverOptions } from "../../src/v3/index.js";
import { MEDIATOR_HTTP } from "../fake-mediator.js";
import { freshVault, json, newMediator, party, webFetch, webIdentity } from "./helpers.js";

const none = () => null;
const BOB = "did:web:bob.example";
const BOB_URL = "https://bob.example/.well-known/did.json";

async function resolved(presented: string, known: KnownLongForms, options?: ResolverOptions): Promise<Resolution> {
  const outcome = await resolve(presented, known, options);
  if (outcome.outcome !== "resolved") throw new Error(`${presented}: ${outcome.outcome}: ${outcome.reason}`);
  return outcome.resolution;
}

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
    expect(refused("did:web:127.0.0.1")).toBe("a loopback authority");
    expect(refused("did:web:10.0.0.1")).toBe("an IP-literal authority");
    expect(refused("did:web:%5B2001%3Adb8%3A%3A1%5D")).toBe("an IP-literal authority");
    expect(refused("did:web:0x7f000001")).toBe("a loopback authority");
    expect(refused("did:web:printer.local")).toContain("a reserved name");
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
  it("fetches the derived URL without following redirects, and retains the document as the vault does", async () => {
    const bob = await webIdentity(BOB);
    const { fetch, calls } = webFetch({ [BOB_URL]: (init) => (init?.redirect === "manual" ? json(bob.document) : new Response("", { status: 500 })) });
    const resolution = await resolved(BOB, none, { fetch });
    const bytes = canonicalize(bob.document);
    expect(resolution).toMatchObject({ presentedDid: BOB, did: BOB, document: bob.document, cid: rawCidOfBytes(bytes), service: "https://bob.example/didcomm" });
    expect(resolution.bytes).toEqual(bytes);
    expect(resolution.authenticationMethodIds).toEqual([`${BOB}#auth`]);
    expect(resolution.keyAgreementMethodIds).toEqual([`${BOB}#agree`]);
    expect(authorizedKeys(resolution, "keyAgreement").get(`${BOB}#agree` as never)).toBe(canonicalPublicKey(bob.secrets[1]?.privateKeyJwk as never));
    expect(calls).toEqual([BOB_URL]);
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
    const answering = (respond: () => Response | Promise<Response>) => webFetch({ [BOB_URL]: respond }).fetch;
    for (const status of [408, 429, 500, 502, 503]) {
      expect(await resolve(BOB, none, { fetch: answering(() => new Response("", { status })) })).toEqual({ outcome: "unavailable", reason: `HTTP ${status}` });
    }
    expect(await resolve(BOB, none, { fetch: answering(() => Promise.reject(new TypeError("fetch failed"))) })).toMatchObject({ outcome: "unavailable", reason: expect.stringContaining("fetch failed") });
    const hanging: typeof fetch = (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)));
    expect(await resolve(BOB, none, { fetch: hanging, timeoutMs: 20 })).toMatchObject({ outcome: "unavailable", reason: expect.stringContaining("timeout") });
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

  it("a policy refusal is definitive before any fetch; the host's own check and the loopback allowance are honoured", async () => {
    const bob = await webIdentity("did:web:localhost%3A8080");
    const { fetch, calls } = webFetch({ "http://localhost:8080/.well-known/did.json": () => json(bob.document) });
    expect(await resolve("did:web:localhost%3A8080", none, { fetch })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("loopback") });
    expect(await resolve("did:web:10.0.0.1", none, { fetch })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("IP-literal") });
    expect(await resolve(BOB, none, { fetch, checkHost: (hostname) => `${hostname} resolves to a private address` })).toMatchObject({ outcome: "definitive", reason: expect.stringContaining("private address") });
    expect(calls).toEqual([]);
    const resolution = await resolved("did:web:localhost%3A8080", none, { fetch, insecureLoopback: true, checkHost: () => null });
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

    const localKeyName = didKeyName("019b0000-0000-7000-8000-00000000000b" as DidId, "key-agreement");
    const peerPublicKey = authorizedKeys(resolution, "keyAgreement").get(`${BOB}#agree` as never) as never;
    const event = await commitResolution(runtime, { resolution, localKeyName, peerPublicKey });
    expect(knownLongForms(await scanVault(runtime.vault, keys))(BOB as Did)).toBeNull();
    expect(event.data.did).toBe(BOB);
    await runtime.close();
  });
});
