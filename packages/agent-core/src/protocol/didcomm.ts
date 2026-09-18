import type {
  DIDResolver,
  FromPrior as FromPriorClass,
  IMessage,
  Message as MessageClass,
  SecretsResolver,
  UnpackMetadata,
} from "@estoc/didcomm";

import type { DIDDoc, Secret } from "@estoc/did-peer";

/**
 * The slice of didcomm-rust the agent uses, handed in by the application
 * rather than imported here: the WASM has to be instantiated differently in
 * every runtime (Vite's `?url`, workerd's module import, the Node build's
 * native loading), and that wiring is the one thing this package refuses to
 * know. `@estoc/didcomm` and `@estoc/didcomm-node` export `Message` and
 * `FromPrior` with these exact shapes; so do the upstream `didcomm` builds,
 * but only the Estoc builds can leave a `from_prior` unverified, which
 * `unpack` needs.
 */
export interface DidcommApi {
  Message: typeof MessageClass;
  /** the DID-rotation header, signed by the DID being left behind */
  FromPrior: typeof FromPriorClass;
}

export type { DIDResolver, IMessage, SecretsResolver, UnpackMetadata };

export const PLAIN_TYP = "application/didcomm-plain+json";
export const ENCRYPTED_MIME = "application/didcomm-encrypted+json";

/*
 * The binding keeps every `Message` and `FromPrior` in WebAssembly memory
 * that no garbage collection reclaims: each lives only as long as the one
 * call made with it. It is freed only after that call settles, even when
 * its caller has already stopped waiting at a deadline of its own, since
 * the call may still be using it.
 */

/** `pack_encrypted` over a `Message` made for this pack alone. */
export async function packEncrypted(didcomm: DidcommApi, message: IMessage, ...args: Parameters<MessageClass["pack_encrypted"]>): ReturnType<MessageClass["pack_encrypted"]> {
  const native = new didcomm.Message(message);
  try {
    return await native.pack_encrypted(...args);
  } finally {
    native.free();
  }
}

/** `Message.unpack`, the opened message read out as a plain value. */
export async function unpackMessage(didcomm: DidcommApi, ...args: Parameters<DidcommApi["Message"]["unpack"]>): Promise<[IMessage, UnpackMetadata]> {
  const [native, metadata] = await didcomm.Message.unpack(...args);
  try {
    return [native.as_value(), metadata];
  } finally {
    native.free();
  }
}

/** An envelope `unpack` will not open as an inbound message: what it is, not who sealed it, is wrong. */
export class EnvelopeRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "EnvelopeRefused";
  }
}

/** An inbound envelope opened: what the envelope itself proved, and what the plaintext carried. */
export interface Unpacked {
  plaintext: IMessage;
  /**
   * The key that sealed the envelope as authenticated encryption, and its
   * DID, which the plaintext's `from` names byte for byte; null when the
   * envelope was anonymous, signed or not. A signature proves who wrote
   * the plaintext, not who sent this envelope: anyone holding a signed
   * plaintext can seal it to us again.
   */
  sender: { did: string; kid: string } | null;
  /** the `from_prior` header as it came off the wire, unverified; null when the plaintext carries none */
  fromPrior: string | null;
  metadata: UnpackMetadata;
}

/**
 * `Message.unpack` for an inbound message, with the `from_prior` header
 * left unverified. The binding checks the envelope's integrity, that a
 * key of ours opened it, that the sealer's key is one its document
 * authorizes and that the wire is well formed (a `from_prior` that is
 * not a string is malformed to it; an explicit null reads as absent,
 * as the vault reads every optional header). What is checked here is
 * what ties the layers together: the plaintext's `from` is the sealer's
 * DID, a signature inside the sealed envelope is the sealer's too, and
 * the sealed layer is the outermost one. The binding reports only the
 * outermost layer's recipients, so an authenticated layer wrapped in an
 * anonymous one could have been sealed to someone else and re-wrapped
 * to us; nothing we send is sender-protected, and such an envelope is
 * refused until the binding reports the recipients of every layer.
 * The rotation proof is kept as the string it came as: a proof whose
 * issuer cannot be resolved, or that does not verify, must not stop the
 * message from being received and acknowledged; what the proof is worth
 * is decided once the message is recorded, from the recorded evidence.
 */
export async function unpack(didcomm: DidcommApi, packed: string, resolver: DIDResolver, secrets: SecretsResolver): Promise<Unpacked> {
  const [plaintext, metadata] = await unpackMessage(didcomm, packed, resolver, secrets, { verify_from_prior: false });
  if (metadata.from_prior != null || metadata.from_prior_issuer_kid != null) {
    throw new Error("the didcomm binding verified from_prior on its own: it is not a build that can leave it unverified");
  }
  if (!metadata.encrypted) throw new EnvelopeRefused("the envelope is not encrypted");
  const kid = metadata.encrypted_from_kid;
  const sender = typeof kid === "string" ? { did: didOf(kid) as string, kid } : null;
  if (sender !== null) {
    if (metadata.anonymous_sender) throw new EnvelopeRefused("the authenticated layer is wrapped in an anonymous one: its own recipients are not reported");
    if (plaintext.from !== sender.did) throw new EnvelopeRefused(`from ${plaintext.from === undefined ? "is missing" : "does not name the sealer"}`);
    if (metadata.non_repudiation && didOf(metadata.sign_from) !== sender.did) throw new EnvelopeRefused("the plaintext is signed by another than the sealer");
  }
  return { plaintext, sender, fromPrior: plaintext.from_prior ?? null, metadata };
}

/** `pack` over a `FromPrior` made for this signature alone. */
export async function packFromPrior(didcomm: DidcommApi, value: ConstructorParameters<DidcommApi["FromPrior"]>[0], ...args: Parameters<FromPriorClass["pack"]>): ReturnType<FromPriorClass["pack"]> {
  const native = new didcomm.FromPrior(value);
  try {
    return await native.pack(...args);
  } finally {
    native.free();
  }
}

/** A SecretsResolver over a fixed set of secrets. */
export function secretsResolverFor(secrets: Secret[]): SecretsResolver {
  const byId = new Map(secrets.map((secret) => [secret.id, secret]));
  return {
    get_secret: async (id: string) => byId.get(id) ?? null,
    find_secrets: async (ids: string[]) => ids.filter((id) => byId.has(id)),
  };
}

export function serviceUris(doc: DIDDoc): string[] {
  return doc.service.map((service) =>
    typeof service.serviceEndpoint === "string"
      ? service.serviceEndpoint
      : service.serviceEndpoint.uri
  );
}

export function endpointOf(doc: DIDDoc, scheme: "http" | "ws"): string | null {
  return serviceUris(doc).find((uri) => uri.startsWith(scheme)) ?? null;
}

/** A DIDComm plaintext skeleton: fresh id, spec'd typ, UTC epoch seconds. */
export function plainMessage(
  type: string,
  from: string | null,
  to: string,
  body: Record<string, unknown>
): IMessage {
  return {
    id: crypto.randomUUID(),
    typ: PLAIN_TYP,
    type,
    ...(from === null ? {} : { from }),
    to: [to],
    // The spec wants UTC epoch seconds, not milliseconds.
    created_time: Math.floor(Date.now() / 1000),
    body,
  } as IMessage;
}

/** A key id names a DID and a key within it; everything here wants the DID. */
export function didOf(kid: string | null | undefined): string | null {
  return kid ? (kid.split("#")[0] as string) : null;
}
