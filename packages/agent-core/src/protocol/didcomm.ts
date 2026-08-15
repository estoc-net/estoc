import type {
  DIDResolver,
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
 * know. Both `didcomm` and `didcomm-node` export a `Message` with this
 * exact shape.
 */
export interface DidcommApi {
  Message: typeof MessageClass;
}

export type { DIDResolver, IMessage, SecretsResolver, UnpackMetadata };

export const PLAIN_TYP = "application/didcomm-plain+json";
export const ENCRYPTED_MIME = "application/didcomm-encrypted+json";

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

/** Pretty-print a wire object (JSON text or value) for the inspector. */
export function pretty(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}
