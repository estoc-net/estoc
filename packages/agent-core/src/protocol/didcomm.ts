import type {
  DIDResolver,
  FromPrior as FromPriorClass,
  IMessage,
  Message as MessageClass,
  SecretsResolver,
  UnpackMetadata,
} from "didcomm";

import type { DIDDoc, Secret } from "@estoc/did-peer";

/**
 * The slice of didcomm-rust the agent uses, handed in by the application
 * rather than imported here: the WASM has to be instantiated differently in
 * every runtime (Vite's `?url`, workerd's module import, didcomm-node's
 * native build), and that wiring is the one thing this package refuses to
 * know. Both `didcomm` and `didcomm-node` export `Message` and `FromPrior`
 * with these exact shapes.
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
 * call made with it, and is freed once that call has settled — after the
 * caller has the result, or has stopped waiting for it at a deadline of
 * its own, whichever comes first.
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
