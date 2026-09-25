import { createPrivateKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";

import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { base58, base64urlnopad } from "@scure/base";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { deriveContinuity } from "../src/index.js";
import { bindFromPrior, createFromPrior, FROM_PRIOR_PROFILE, inspectFromPrior, InvalidFromPrior, precheckFromPrior, verifyFromPrior, type FromPriorFailure, type IssuerEvidence, type Signer, type VerifiedFromPrior } from "../src/from-prior/index.js";

type Party = { longForm: string; shortForm: string; document: IssuerEvidence; kid: string; privateKey: KeyObject; publicKeyBytes: Uint8Array };

type Input = Record<string, unknown>;

/** A did:peer:4 party whose input document `shape` builds from its key material. */
function party(name: string, shape: (key: { multikey: string; jwk: Record<string, string>; bytes: Uint8Array }) => Input = (key) => ({ verificationMethod: [{ id: "#key-1", type: "Multikey", publicKeyMultibase: key.multikey }], authentication: ["#key-1"] })): Party {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = base64urlnopad.decode(publicKey.export({ format: "jwk" }).x!);
  const multikey = `z${base58.encode(new Uint8Array([0xed, 0x01, ...publicKeyBytes]))}`;
  const input = {
    ...shape({ multikey, jwk: { kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(publicKeyBytes) }, bytes: publicKeyBytes }),
    service: [{ id: "#service", type: "DIDCommMessaging", serviceEndpoint: { uri: `https://${name}.example`, accept: ["didcomm/v2"] } }],
  };
  const longForm = encodeLongForm(input);
  return { longForm, shortForm: longToShort(longForm), document: { ref: `doc-${name}`, longForm }, kid: `${longForm}#key-1`, privateKey, publicKeyBytes };
}

const IAT = 1_758_700_000;
const b0 = party("b0");
const b1 = party("b1");
const a0 = party("a0");

async function rotation(issuer: Party, successor: Party, header: Record<string, unknown> = {}, claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ iss: issuer.longForm, sub: successor.longForm, iat: IAT, ...claims })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: issuer.kid, ...header } as never)
    .sign(issuer.privateKey);
}

async function ending(issuer: Party, audience: Party | null): Promise<string> {
  return new SignJWT({ iss: issuer.longForm, iat: IAT, ...(audience === null ? {} : { aud: audience.longForm }) })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: issuer.kid })
    .sign(issuer.privateKey);
}

const segments = (jwt: string) => jwt.split(".") as [string, string, string];
const encode = (value: unknown) => base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)));
/** A signature segment of the right shape that nothing verifies, for cases about the other two segments. */
const unsigned = base64urlnopad.encode(new Uint8Array(64));

async function failure(promise: Promise<unknown>): Promise<InvalidFromPrior> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof InvalidFromPrior) return err;
    throw err;
  }
  throw new Error("verified");
}

function refusal(run: () => unknown): InvalidFromPrior {
  try {
    run();
  } catch (err) {
    if (err instanceof InvalidFromPrior) return err;
    throw err;
  }
  throw new Error("accepted");
}

/** A token signed by `issuer` over the exact header and claims given, so a test can shape both. */
function signed(issuer: Party, header: Record<string, unknown>, claims: Record<string, unknown>): string {
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${base64urlnopad.encode(new Uint8Array(nodeSign(null, new TextEncoder().encode(input), issuer.privateKey)))}`;
}

describe("inspect", () => {
  it("reads the header and claims of a token without verifying anything", async () => {
    const jwt = await rotation(b0, b1);
    const [h, p] = segments(jwt);
    const tampered = `${h}.${p}.${base64urlnopad.encode(new Uint8Array(64))}`;
    expect(inspectFromPrior(tampered)).toEqual({ header: { alg: "EdDSA", typ: "JWT", kid: b0.kid }, claims: { iss: b0.longForm, sub: b1.longForm, aud: undefined, iat: IAT } });
    expect(inspectFromPrior(await ending(b0, a0)).claims).toEqual({ iss: b0.longForm, sub: undefined, aud: a0.longForm, iat: IAT });
  });

  it("refuses what is not a JWT of the expected shape, each case for its own defect", () => {
    const cases: [string, RegExp][] = [
      ["", /compact JWT/],
      ["a.b", /compact JWT/],
      ["a.b.c", /compact JWT/],
      [`${encode({ alg: "EdDSA" })}.${encode({ iss: "x", iat: IAT })}.${unsigned}`, /kid/],
      [`${encode({ alg: "EdDSA", kid: "k" })}.${encode({ iss: "x", iat: 1.5 })}.${unsigned}`, /iat/],
      [`${encode({ alg: "EdDSA", kid: "k" })}.${encode({ iss: "x", sub: null, iat: IAT })}.${unsigned}`, /sub/],
      [`${encode({ alg: "EdDSA", kid: "k" })}.${encode({ iss: "x", aud: ["a"], iat: IAT })}.${unsigned}`, /aud/],
    ];
    for (const [jwt, defect] of cases) expect(refusal(() => inspectFromPrior(jwt)).message, jwt).toMatch(defect);
    expect(() => inspectFromPrior(`${encode({ alg: "EdDSA", kid: "k" })}.${encode({ iss: "x", iat: IAT })}.${unsigned}`)).not.toThrow();
  });

  it("refuses a validity window, which this profile does not evaluate", async () => {
    expect(refusal(() => inspectFromPrior(`${encode({ alg: "EdDSA", kid: b0.kid })}.${encode({ iss: b0.longForm, sub: b1.longForm, iat: IAT, exp: IAT + 10 })}.${unsigned}`)).message).toMatch(/exp/);
    expect((await failure(verifyFromPrior(await rotation(b0, b1, {}, { nbf: IAT }), b0.document))).failure).toBe("form");
  });
});

describe("precheck", () => {
  const header = { alg: "EdDSA", typ: "JWT", kid: b0.kid };
  const claims = { iss: b0.longForm, sub: b1.longForm, iat: IAT };

  it("refuses, without any issuer document, what the profile can already decide, and verification refuses the same way", async () => {
    const cases: [string, Record<string, unknown>, Record<string, unknown>, FromPriorFailure][] = [
      ["another algorithm", { ...header, alg: "ES256" }, claims, "profile"],
      ["alg none", { ...header, alg: "none" }, claims, "profile"],
      ["another media type", { ...header, typ: "JWS" }, claims, "profile"],
      ["a kid of another DID", { ...header, kid: `${b1.longForm}#key-1` }, claims, "profile"],
      ["a kid without a fragment", { ...header, kid: b0.longForm }, claims, "profile"],
      ["a rotation to the issuer itself", header, { ...claims, sub: b0.shortForm }, "profile"],
      ["a rotation with an audience", header, { ...claims, aud: a0.longForm }, "profile"],
      ["an ending addressed to the issuer", header, { iss: b0.longForm, aud: b0.shortForm, iat: IAT }, "profile"],
      ["an issuer of another method", header, { ...claims, iss: "did:web:b0.example" }, "profile"],
      ["a successor of another method", header, { ...claims, sub: "did:key:z6Mk" }, "profile"],
      ["a critical header this profile does not understand", { ...header, crit: ["x-ext"], "x-ext": 1 }, claims, "profile"],
      ["crit naming b64 the header lacks", { ...header, crit: ["b64"] }, claims, "form"],
      ["an empty crit", { ...header, crit: [] }, claims, "form"],
      ["a repeated crit entry", { ...header, b64: true, crit: ["b64", "b64"] }, claims, "form"],
    ];
    for (const [what, hdr, cl, expected] of cases) {
      const jwt = signed(b0, hdr, cl);
      expect(refusal(() => precheckFromPrior(jwt)).failure, what).toBe(expected);
      expect((await failure(verifyFromPrior(jwt, b0.document))).failure, what).toBe(expected);
    }
  });

  it("refuses a signature segment that cannot be an Ed25519 signature, and leaves a well-formed wrong one to verification", async () => {
    const [h, p, s] = segments(signed(b0, header, claims));
    for (const [what, segment] of [["empty", ""], ["not base64url", "!"], ["an odd length", "A"], ["one byte", "AA"], ["63 bytes", base64urlnopad.encode(new Uint8Array(63))], ["65 bytes", base64urlnopad.encode(new Uint8Array(65))], ["padded", `${s}=`]]) {
      const jwt = `${h}.${p}.${segment}`;
      expect(refusal(() => precheckFromPrior(jwt)).failure, what).toBe("form");
      expect(refusal(() => inspectFromPrior(jwt)).failure, what).toBe("form");
      expect((await failure(verifyFromPrior(jwt, b0.document))).failure, what).toBe("form");
    }
    const wrong = `${h}.${p}.${base64urlnopad.encode(new Uint8Array(64))}`;
    expect(precheckFromPrior(wrong)).toEqual(inspectFromPrior(wrong));
    expect((await failure(verifyFromPrior(wrong, b0.document))).failure).toBe("signature");
  });

  it("refuses a rotation whose successor is not the authenticated sender, before any material arrives", () => {
    const jwt = signed(b0, header, claims);
    expect(refusal(() => precheckFromPrior(jwt, { authenticatedSender: b0.longForm })).failure).toBe("binding");
    expect(refusal(() => precheckFromPrior(jwt, { authenticatedSender: a0.shortForm })).failure).toBe("binding");
    expect(refusal(() => precheckFromPrior(jwt, { authenticatedSender: "did:web:b1.example" })).failure).toBe("binding");
    expect(precheckFromPrior(jwt, { authenticatedSender: b1.longForm })).toEqual(inspectFromPrior(jwt));
    expect(precheckFromPrior(jwt, { authenticatedSender: b1.shortForm })).toEqual(inspectFromPrior(jwt));
  });

  it("accepts equivalent spellings: short and long forms of one DID are one identity", () => {
    expect(precheckFromPrior(signed(b0, { ...header, kid: `${b0.shortForm}#key-1` }, claims))).toMatchObject({ header: { kid: `${b0.shortForm}#key-1` } });
    expect(precheckFromPrior(signed(b0, header, { ...claims, iss: b0.shortForm }))).toMatchObject({ claims: { iss: b0.shortForm } });
    expect(refusal(() => precheckFromPrior(signed(b0, header, { ...claims, sub: b0.longForm }))).failure).toBe("profile");
    for (const typ of [undefined, "jwt", "application/jwt", "Application/JWT"]) {
      expect(() => precheckFromPrior(signed(b0, { alg: "EdDSA", kid: b0.kid, ...(typ === undefined ? {} : { typ }) }, claims)), typ ?? "omitted").not.toThrow();
    }
  });

  it("passes a token whose issuer material is still unknown: the host waits, it does not reject", async () => {
    const unknown = party("unknown");
    const jwt = signed(unknown, { alg: "EdDSA", kid: `${unknown.shortForm}#key-1` }, { iss: unknown.shortForm, sub: b1.longForm, iat: IAT });
    expect(precheckFromPrior(jwt, { authenticatedSender: b1.shortForm })).toEqual({ header: { alg: "EdDSA", typ: undefined, kid: `${unknown.shortForm}#key-1` }, claims: { iss: unknown.shortForm, sub: b1.longForm, aud: undefined, iat: IAT } });
    expect((await failure(verifyFromPrior(jwt, b0.document))).failure).toBe("document");
    await expect(verifyFromPrior(jwt, unknown.document)).resolves.toMatchObject({ issuer: { canonical: unknown.shortForm } });
  });

  it("grants nothing: a tampered token passes the precheck and still fails verification, and the result carries no verified brand", async () => {
    const jwt = await rotation(b0, b1);
    const [h, p] = segments(jwt);
    const tampered = `${h}.${p}.${base64urlnopad.encode(new Uint8Array(64))}`;
    const result = precheckFromPrior(tampered, { authenticatedSender: b1.longForm });
    expect(result).toEqual(inspectFromPrior(jwt));
    expect(Object.getOwnPropertySymbols(result)).toEqual([]);
    expect(Object.keys(result)).toEqual(["header", "claims"]);
    expect((await failure(verifyFromPrior(tampered, b0.document))).failure).toBe("signature");
  });

  it("leaves an ending to verification and binding: a sender given to the precheck does not reject it", async () => {
    const addressed = await ending(b0, a0);
    expect(precheckFromPrior(addressed, { authenticatedSender: b0.longForm })).toEqual(inspectFromPrior(addressed));
    const bare = await ending(b0, null);
    expect(precheckFromPrior(bare, { authenticatedSender: b0.longForm })).toEqual(inspectFromPrior(bare));
    const proof = await verifyFromPrior(addressed, b0.document);
    expect(bindFromPrior(proof, { ref: "receipt-e", token: addressed, recipient: a0.longForm, sender: b0.longForm }, { transitionId: "e1" })).toMatchObject({ status: "mismatch", because: expect.stringContaining("sender") });
    expect(bindFromPrior(proof, { ref: "receipt-e", token: addressed, recipient: a0.longForm, sender: null }, { transitionId: "e1" })).toMatchObject({ status: "bound" });
    expect(bindFromPrior(await verifyFromPrior(bare, b0.document), { ref: "receipt-e", token: bare, recipient: a0.longForm, sender: null }, { transitionId: "e1" })).toMatchObject({ status: "unbound" });
  });
});

describe("verify", () => {
  it("verifies a rotation against the issuer's long-form document", async () => {
    const jwt = await rotation(b0, b1);
    const proof = await verifyFromPrior(jwt, b0.document);
    expect(proof).toMatchObject({
      profile: FROM_PRIOR_PROFILE,
      token: jwt,
      issuer: { presented: b0.longForm, canonical: b0.shortForm },
      change: { kind: "rotate", successor: { presented: b1.longForm, canonical: b1.shortForm } },
      iat: IAT,
      document: { ref: "doc-b0", longForm: b0.longForm },
      method: b0.kid,
    });
  });

  it("verifies a short-form iss and kid against the retained long form, and keeps the presented spellings", async () => {
    const jwt = await new SignJWT({ iss: b0.shortForm, sub: b1.shortForm, iat: IAT }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: `${b0.shortForm}#key-1` }).sign(b0.privateKey);
    const proof = await verifyFromPrior(jwt, b0.document);
    expect(proof.issuer).toEqual({ presented: b0.shortForm, canonical: b0.shortForm });
    expect(proof.change).toMatchObject({ successor: { presented: b1.shortForm, canonical: b1.shortForm } });
    expect(proof.document.longForm).toBe(b0.longForm);
    expect(proof.method).toBe(`${b0.shortForm}#key-1`);
  });

  it("takes the issuer's key from the long form alone: a document assembled by the caller cannot substitute one", async () => {
    const attacker = party("attacker");
    const forged = await new SignJWT({ iss: b0.longForm, sub: attacker.longForm, iat: IAT }).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: b0.kid }).sign(attacker.privateKey);
    expect((await failure(verifyFromPrior(forged, b0.document))).failure).toBe("signature");
    expect((await failure(verifyFromPrior(forged, attacker.document))).failure).toBe("document");
    expect((await failure(verifyFromPrior(forged, { ref: "x", longForm: b0.shortForm }))).failure).toBe("document");
    const corrupted = b0.longForm.slice(0, -1) + (b0.longForm.endsWith("a") ? "b" : "a");
    expect((await failure(verifyFromPrior(forged, { ref: "x", longForm: corrupted }))).failure).toBe("document");
    expect((await failure(verifyFromPrior(await rotation(b0, b1), { ref: "x", longForm: corrupted }))).failure).toBe("document");
  });

  it("consults no clock", async () => {
    const jwt = await rotation(b0, b1);
    const NativeDate = globalThis.Date;
    let reads = 0;
    class Counting extends NativeDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) reads++;
        super(...(args as [number]));
      }
      static override now(): number {
        reads++;
        return NativeDate.now();
      }
    }
    globalThis.Date = Counting as unknown as DateConstructor;
    try {
      await expect(verifyFromPrior(jwt, b0.document)).resolves.toMatchObject({ iat: IAT });
    } finally {
      globalThis.Date = NativeDate;
    }
    expect(reads).toBe(0);
  });

  it("reads a repeated claim as its last value, the way the library does", async () => {
    const input = `${encode({ alg: "EdDSA", typ: "JWT", kid: b0.kid })}.${base64urlnopad.encode(new TextEncoder().encode(`{"iss":${JSON.stringify(b0.longForm)},"sub":${JSON.stringify(b1.longForm)},"iat":1,"iat":${IAT}}`))}`;
    const jwt = `${input}.${base64urlnopad.encode(new Uint8Array(nodeSign(null, new TextEncoder().encode(input), b0.privateKey)))}`;
    expect(inspectFromPrior(jwt).claims.iat).toBe(IAT);
    expect((await verifyFromPrior(jwt, b0.document)).iat).toBe(IAT);
  });

  it("takes typ as the optional media type it is, and creates the short spelling", async () => {
    const [h, p, s] = segments(await rotation(b0, b1));
    const header = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(h))) as Record<string, unknown>;
    expect(header["typ"]).toBe("JWT");
    const resigned = (hdr: Record<string, unknown>) => new SignJWT(JSON.parse(new TextDecoder().decode(base64urlnopad.decode(p))) as Record<string, unknown>).setProtectedHeader(hdr as never).sign(b0.privateKey);
    for (const typ of [undefined, "JWT", "jwt", "application/jwt", "Application/JWT"]) {
      await expect(verifyFromPrior(await resigned({ alg: "EdDSA", kid: b0.kid, ...(typ === undefined ? {} : { typ }) }), b0.document), typ ?? "omitted").resolves.toMatchObject({ iat: IAT });
    }
    for (const typ of ["JWS", "application/jose", "JWT ", "application/jwt; charset=utf-8"]) {
      expect((await failure(verifyFromPrior(await resigned({ alg: "EdDSA", typ, kid: b0.kid }), b0.document))).failure, typ).toBe("profile");
    }
    expect((await failure(verifyFromPrior(`${encode({ alg: "EdDSA", typ: 7, kid: b0.kid })}.${p}.${s}`, b0.document))).failure).toBe("form");
  });

  it("verifies an ending and retains its audience", async () => {
    const proof = await verifyFromPrior(await ending(b0, a0), b0.document);
    expect(proof.change).toEqual({ kind: "end", audience: { presented: a0.longForm, canonical: a0.shortForm } });
    const unaddressed = await verifyFromPrior(await ending(b0, null), b0.document);
    expect(unaddressed.change).toEqual({ kind: "end", audience: null });
  });

  it("reports a document failure for an authorized JWK that is not an Ed25519 key", async () => {
    for (const [what, x] of [["empty", ""], ["not base64url", "!"], ["one byte", "AA"], ["31 bytes", base64urlnopad.encode(new Uint8Array(31))], ["33 bytes", base64urlnopad.encode(new Uint8Array(33))]]) {
      const jwk = party(`jwk-${what}`, () => ({ verificationMethod: [{ id: "#key-1", type: "JsonWebKey2020", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x } }], authentication: ["#key-1"] }));
      const jwt = await rotation(jwk, b1);
      expect(() => precheckFromPrior(jwt), what).not.toThrow();
      expect((await failure(verifyFromPrior(jwt, jwk.document))).failure, what).toBe("document");
    }
  });

  it("accepts a JWK method, and an embedded authentication method", async () => {
    const jwk = party("jwk", (key) => ({ verificationMethod: [{ id: "#key-1", type: "JsonWebKey2020", publicKeyJwk: key.jwk }], authentication: ["#key-1"] }));
    await expect(verifyFromPrior(await rotation(jwk, b1), jwk.document)).resolves.toMatchObject({ method: jwk.kid });
    const embedded = party("embedded", (key) => ({ authentication: [{ id: "#key-1", type: "Multikey", publicKeyMultibase: key.multikey }] }));
    await expect(verifyFromPrior(await rotation(embedded, b1), embedded.document)).resolves.toMatchObject({ method: embedded.kid });
  });

  it("distinguishes failures of form, profile, document and signature", async () => {
    const jwt = await rotation(b0, b1);
    const [h, p, s] = segments(jwt);
    const payload = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(p))) as Record<string, unknown>;
    const header = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(h))) as Record<string, unknown>;
    const resigned = (hdr: Record<string, unknown>, claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader(hdr as never).sign(b0.privateKey);

    expect((await failure(verifyFromPrior("nope", b0.document))).failure).toBe("form");
    expect((await failure(verifyFromPrior(`${encode({ ...header, alg: "none" })}.${p}.${s}`, b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned({ alg: "EdDSA", typ: "JWS", kid: b0.kid }, payload), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned({ alg: "EdDSA", typ: "JWT", kid: `${b1.longForm}#key-1` }, payload), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, sub: b0.shortForm }), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, iss: "did:web:b0.example" }), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, sub: "did:key:z6Mk" }), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, aud: a0.longForm }), b0.document))).failure).toBe("profile");
    expect((await failure(verifyFromPrior(await resigned(header, { ...payload, iss: `${b0.longForm.slice(0, -1)}${b0.longForm.endsWith("a") ? "b" : "a"}` }), b0.document))).failure).toBe("profile");

    expect((await failure(verifyFromPrior(jwt, b1.document))).failure).toBe("document");
    expect((await failure(verifyFromPrior(await resigned({ ...header, kid: `${b0.longForm}#key-2` }, payload), b0.document))).failure).toBe("document");
    const unauthorized = party("unauthorized", (key) => ({ verificationMethod: [{ id: "#key-1", type: "Multikey", publicKeyMultibase: key.multikey }], keyAgreement: ["#key-1"] }));
    expect((await failure(verifyFromPrior(await rotation(unauthorized, b1), unauthorized.document))).failure).toBe("document");
    const x25519 = party("x25519", (key) => ({ verificationMethod: [{ id: "#key-1", type: "Multikey", publicKeyMultibase: `z${base58.encode(new Uint8Array([0xec, 0x01, ...key.bytes]))}` }], authentication: ["#key-1"] }));
    expect((await failure(verifyFromPrior(await rotation(x25519, b1), x25519.document))).failure).toBe("document");
    expect((await failure(verifyFromPrior(jwt, { ref: "x", longForm: null as unknown as string }))).failure).toBe("document");

    expect((await failure(verifyFromPrior(`${h}.${encode({ ...payload, iat: IAT + 1 })}.${s}`, b0.document))).failure).toBe("signature");
    expect((await failure(verifyFromPrior(`${h}.${p}.${base64urlnopad.encode(new Uint8Array(64))}`, b0.document))).failure).toBe("signature");
    const otherKey = await new SignJWT(payload).setProtectedHeader(header as never).sign(b1.privateKey);
    expect((await failure(verifyFromPrior(otherKey, b0.document))).failure).toBe("signature");
  });

  it("takes b64 as RFC 7797 has it: absent, or true and listed in crit", async () => {
    const jwt = await rotation(b0, b1);
    const [, p] = segments(jwt);
    const signed = (header: Record<string, unknown>) => {
      const input = `${encode({ alg: "EdDSA", typ: "JWT", kid: b0.kid, ...header })}.${p}`;
      return `${input}.${base64urlnopad.encode(new Uint8Array(nodeSign(null, new TextEncoder().encode(input), b0.privateKey)))}`;
    };
    await expect(verifyFromPrior(signed({ b64: true, crit: ["b64"] }), b0.document)).resolves.toMatchObject({ issuer: { canonical: b0.shortForm } });
    for (const header of [{ b64: true }, { b64: false }, { b64: false, crit: ["b64"] }, { b64: "no" }, { b64: "no", crit: ["b64"] }, { b64: true, crit: "b64" }]) {
      expect(() => inspectFromPrior(signed(header))).toThrow(InvalidFromPrior);
      expect((await failure(verifyFromPrior(signed(header), b0.document))).failure).toBe("form");
    }
  });

  it("refuses an unencoded payload and unknown critical extensions", async () => {
    const jwt = await rotation(b0, b1);
    const [, p] = segments(jwt);
    const unencoded = `${encode({ alg: "EdDSA", typ: "JWT", kid: b0.kid, b64: false, crit: ["b64"] })}.${new TextDecoder().decode(base64urlnopad.decode(p))}.${base64urlnopad.encode(new Uint8Array(64))}`;
    await expect(verifyFromPrior(unencoded, b0.document)).rejects.toThrow(InvalidFromPrior);
    const input = `${encode({ alg: "EdDSA", typ: "JWT", kid: b0.kid, crit: ["x-ext"], "x-ext": 1 })}.${p}`;
    const critical = `${input}.${base64urlnopad.encode(new Uint8Array(nodeSign(null, new TextEncoder().encode(input), b0.privateKey)))}`;
    expect(inspectFromPrior(critical).header.kid).toBe(b0.kid);
    expect(refusal(() => precheckFromPrior(critical)).failure).toBe("profile");
    expect((await failure(verifyFromPrior(critical, b0.document))).failure).toBe("profile");
  });
});

describe("bind", () => {
  it("binds a rotation to the receipt from the successor and yields a transition and an observation that the model accepts", async () => {
    const jwt = await rotation(b0, b1);
    const proof = await verifyFromPrior(jwt, b0.document);
    const binding = bindFromPrior(proof, { ref: "receipt-1", token: jwt, recipient: a0.longForm, sender: b1.longForm }, { transitionId: "p1", observationId: "o1" });
    expect(binding).toEqual({
      status: "bound",
      facts: [
        { kind: "peer-transition", id: "p1", at: { localDid: a0.shortForm, peerDid: b0.shortForm }, change: { kind: "rotate", successor: b1.shortForm }, receipt: "receipt-1" },
        { kind: "address-observed", id: "o1", at: { localDid: a0.shortForm, peerDid: b1.shortForm }, carriedTransition: "p1", receipt: "receipt-1" },
      ],
    });
    if (binding.status !== "bound") throw new Error(binding.status);
    const model = deriveContinuity(binding.facts);
    expect(model.head({ localDid: a0.shortForm, peerDid: b0.shortForm })).toEqual({ status: "head", channel: { localDid: a0.shortForm, peerDid: b1.shortForm }, support: ["p1"] });
    expect(model.confirmation(a0.shortForm, b0.shortForm)).toMatchObject({ status: "confirmed" });
  });

  it("binds a topology-only transition when no observation ID is given, and accepts the short-form sender", async () => {
    const jwt = await rotation(b0, b1);
    const proof = await verifyFromPrior(jwt, b0.document);
    const binding = bindFromPrior(proof, { ref: "receipt-1", token: jwt, recipient: a0.shortForm, sender: b1.shortForm }, { transitionId: "p1" });
    expect(binding).toMatchObject({ status: "bound", facts: [{ kind: "peer-transition", id: "p1" }] });
  });

  it("reports a mismatch instead of a fact for the wrong token, sender or recipient", async () => {
    const jwt = await rotation(b0, b1);
    const proof = await verifyFromPrior(jwt, b0.document);
    const ids = { transitionId: "p1", observationId: "o1" };
    expect(bindFromPrior(proof, { ref: "r", token: await rotation(b0, b1, {}, { iat: IAT + 1 }), recipient: a0.longForm, sender: b1.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("token") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: a0.longForm, sender: b0.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("sender") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: a0.longForm, sender: null }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("authenticated sender") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: b0.longForm, sender: b1.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("issuer") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: b1.longForm, sender: b1.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("successor") });
    expect(bindFromPrior(proof, { ref: "r", token: jwt, recipient: "did:web:a0.example", sender: b1.longForm }, ids)).toMatchObject({ status: "mismatch", because: expect.stringContaining("did:peer:4") });
  });

  it("binds an ending only to the recipient it names, on an anonymous receipt", async () => {
    const addressed = await ending(b0, a0);
    const proof = await verifyFromPrior(addressed, b0.document);
    expect(bindFromPrior(proof, { ref: "receipt-e", token: addressed, recipient: a0.longForm, sender: null }, { transitionId: "e1" })).toEqual({
      status: "bound",
      facts: [{ kind: "peer-transition", id: "e1", at: { localDid: a0.shortForm, peerDid: b0.shortForm }, change: { kind: "end" }, receipt: "receipt-e" }],
    });
    expect(bindFromPrior(proof, { ref: "receipt-e", token: addressed, recipient: b1.longForm, sender: null }, { transitionId: "e1" })).toMatchObject({ status: "mismatch", because: expect.stringContaining("aud") });
    expect(bindFromPrior(proof, { ref: "receipt-e", token: addressed, recipient: a0.longForm, sender: b0.longForm }, { transitionId: "e1" })).toMatchObject({ status: "mismatch", because: expect.stringContaining("sender") });
    const unaddressed = await ending(b0, null);
    const bare = await verifyFromPrior(unaddressed, b0.document);
    expect(bindFromPrior(bare, { ref: "receipt-e", token: unaddressed, recipient: a0.longForm, sender: null }, { transitionId: "e1" })).toMatchObject({ status: "unbound", because: expect.stringContaining("audience") });
  });
});

describe("create", () => {
  const signerOf = (issuer: Party, methodId = issuer.kid): Signer => ({ methodId, sign: async (input) => new Uint8Array(nodeSign(null, input, issuer.privateKey)) });

  it("creates a rotation proof that verifies and binds like a received one", async () => {
    const proof = await createFromPrior({ issuer: b0.longForm, change: { kind: "rotate", successor: b1.longForm }, iat: IAT, evidence: b0.document }, signerOf(b0));
    expect(proof).toMatchObject({ issuer: { presented: b0.longForm }, change: { kind: "rotate", successor: { presented: b1.longForm } }, iat: IAT, method: b0.kid });
    expect(inspectFromPrior(proof.token)).toEqual({ header: { alg: "EdDSA", typ: "JWT", kid: b0.kid }, claims: { iss: b0.longForm, sub: b1.longForm, aud: undefined, iat: IAT } });
    const again = await verifyFromPrior(proof.token, b0.document);
    expect(again.token).toBe(proof.token);
    expect(bindFromPrior(again, { ref: "r", token: proof.token, recipient: a0.longForm, sender: b1.longForm }, { transitionId: "p1" })).toMatchObject({ status: "bound" });
  });

  it("creates an ending proof addressed to the peer", async () => {
    const proof = await createFromPrior({ issuer: b0.longForm, change: { kind: "end", audience: a0.longForm }, iat: IAT, evidence: b0.document }, signerOf(b0));
    expect(proof.change).toEqual({ kind: "end", audience: { presented: a0.longForm, canonical: a0.shortForm } });
    expect(inspectFromPrior(proof.token).claims).toEqual({ iss: b0.longForm, sub: undefined, aud: a0.longForm, iat: IAT });
  });

  it("refuses a signer whose method the issuer does not authorize, or whose signature does not verify", async () => {
    const request = { issuer: b0.longForm, change: { kind: "rotate" as const, successor: b1.longForm }, iat: IAT, evidence: b0.document };
    expect((await failure(createFromPrior(request, signerOf(b0, `${b0.longForm}#key-2`)))).failure).toBe("document");
    expect((await failure(createFromPrior(request, signerOf(b1, b0.kid)))).failure).toBe("signature");
    expect((await failure(createFromPrior(request, { methodId: b0.kid, sign: async () => new Uint8Array(3) }))).failure).toBe("signature");
    expect((await failure(createFromPrior(request, { methodId: b0.kid, sign: async () => "sig" as unknown as Uint8Array }))).failure).toBe("signature");
  });

  it("refuses an inconsistent request before signing", async () => {
    let signed = 0;
    const counting: Signer = { methodId: b0.kid, sign: async (input) => (signed++, new Uint8Array(nodeSign(null, input, b0.privateKey))) };
    expect((await failure(createFromPrior({ issuer: b0.longForm, change: { kind: "rotate", successor: b0.shortForm }, iat: IAT, evidence: b0.document }, counting))).failure).toBe("profile");
    expect((await failure(createFromPrior({ issuer: b0.longForm, change: { kind: "rotate", successor: b1.longForm }, iat: 1.5, evidence: b0.document }, counting))).failure).toBe("profile");
    expect((await failure(createFromPrior({ issuer: "did:web:b0.example", change: { kind: "rotate", successor: b1.longForm }, iat: IAT, evidence: b0.document }, counting))).failure).toBe("profile");
    expect(signed).toBe(0);
  });

  it("works with a non-exportable key held by the host", async () => {
    const pem = b0.privateKey.export({ format: "pem", type: "pkcs8" });
    const held = createPrivateKey(pem);
    const signer: Signer = { methodId: b0.kid, sign: async (input) => new Uint8Array(nodeSign(null, input, held)) };
    const proof: VerifiedFromPrior = await createFromPrior({ issuer: b0.longForm, change: { kind: "rotate", successor: b1.longForm }, iat: IAT, evidence: b0.document }, signer);
    await expect(verifyFromPrior(proof.token, b0.document)).resolves.toBeDefined();
  });
});
