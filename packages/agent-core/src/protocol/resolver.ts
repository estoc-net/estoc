import { Resolver } from "did-resolver";
import { getResolver as webDidResolver } from "web-did-resolver";
import { resolveDIDCommDoc, toDIDCommDIDDoc } from "@estoc/did-peer";
import type { DIDDoc } from "@estoc/did-peer";

/**
 * The composed DID resolver: did:web through DIF's web-did-resolver,
 * everything else falls through to @estoc/did-peer's pure decoder — the
 * resolver composition did-peer leaves to applications, done once here.
 *
 * `cache: true` keeps successful did:web lookups for the session — a chat
 * partner's keys changing mid-conversation is not a case this resolver chases.
 * Failures are not cached, so a transient network error stays transient.
 */

const webResolver = new Resolver(webDidResolver(), { cache: true });

/**
 * The did.json URL of a loopback did:web, or null for any other host.
 * web-did-resolver only ever fetches https — right for the world at large,
 * but a local mediator (`npm run dev`, plain http) answers as
 * did:web:localhost%3A8080, and a loopback name was never reachable by
 * anyone else anyway.
 */
function loopbackDidWebUrl(did: string): string | null {
  const [host = "", ...segments] = did
    .slice("did:web:".length)
    .split(":")
    .map((part) => decodeURIComponent(part));

  const hostname = host.split(":")[0];
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    return null;
  }

  const path =
    segments.length === 0
      ? "/.well-known/did.json"
      : `/${segments.join("/")}/did.json`;
  return `http://${host}${path}`;
}

export async function resolveDid(did: string): Promise<DIDDoc | null> {
  if (!did.startsWith("did:web:")) {
    return resolveDIDCommDoc(did);
  }

  let didDocument: Record<string, unknown> | { id?: unknown } | null;
  const loopback = loopbackDidWebUrl(did);
  if (loopback !== null) {
    try {
      const response = await fetch(loopback);
      didDocument = response.ok
        ? ((await response.json()) as Record<string, unknown>)
        : null;
    } catch {
      didDocument = null;
    }
  } else {
    didDocument = (await webResolver.resolve(did)).didDocument;
  }

  if (didDocument === null || didDocument.id !== did) {
    // A document claiming a different id than the DID that led to it is
    // someone else's document; using its keys would misattribute messages.
    return null;
  }

  try {
    return toDIDCommDIDDoc(didDocument as Record<string, unknown>);
  } catch {
    return null;
  }
}
