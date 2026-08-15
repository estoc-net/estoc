import { base64urlToUtf8, resolvePeer2, toDIDCommDIDDoc } from "@estoc/did-peer";

import { OOB_INVITATION } from "./types.js";

/**
 * A mediator can be handed over three ways, and they converge on its DID:
 * a DID pasted directly; an out-of-band invitation URL, whose `_oob`
 * parameter decodes to the invitation offline (the standard bootstrap, and
 * the DID inside is pinned by whoever handed over the URL); or a bare
 * mediator URL, probed with one GET for its JSON description — the only
 * form that has to trust what the server answers today.
 *
 * `prefer` picks one of the mediator's alias DIDs by prefix (say
 * `did:peer:2`) from the probe's `dids` list instead of its primary.
 */
export async function resolveMediatorInput(
  input: string,
  prefer?: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("paste an invitation URL, a mediator URL, or a DID");
  }
  if (trimmed.startsWith("did:")) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("not a DID or a URL");
  }

  const oob = url.searchParams.get("_oob");
  if (oob !== null) {
    let invitation: { type?: unknown; from?: unknown };
    try {
      invitation = JSON.parse(base64urlToUtf8(oob)) as {
        type?: unknown;
        from?: unknown;
      };
    } catch {
      throw new Error("_oob does not decode to a JSON message");
    }
    if (invitation.type !== OOB_INVITATION || typeof invitation.from !== "string") {
      throw new Error("_oob is not an out-of-band 2.0 invitation");
    }
    return invitation.from;
  }

  let body: { did?: unknown; dids?: unknown } | null;
  try {
    const res = await fetchFn(url, { headers: { accept: "application/json" } });
    body = (await res.json()) as { did?: unknown; dids?: unknown };
  } catch {
    throw new Error(`could not get a mediator description from ${url.host}`);
  }
  if (prefer !== undefined) {
    const dids = Array.isArray(body?.dids) ? body.dids : [];
    const match = dids.find(
      (did): did is string => typeof did === "string" && did.startsWith(prefer)
    );
    if (match === undefined) {
      throw new Error(`${url.host} does not answer as a ${prefer} DID`);
    }
    return match;
  }
  if (typeof body?.did !== "string" || !body.did.startsWith("did:")) {
    throw new Error(`${url.host} did not answer with a mediator DID`);
  }
  return body.did;
}

/** The host a DID names: the did:web domain, or a did:peer:2 HTTP endpoint's. */
export function didHost(did: string): string | undefined {
  if (did.startsWith("did:web:")) {
    // The DID is the domain: decode the host, drop any path segments.
    return decodeURIComponent(did.slice("did:web:".length).split(":")[0] as string);
  }
  try {
    const uri = toDIDCommDIDDoc(resolvePeer2(did))
      .service.map((service) =>
        typeof service.serviceEndpoint === "string"
          ? service.serviceEndpoint
          : service.serviceEndpoint.uri
      )
      .find((endpoint) => endpoint.startsWith("http"));
    if (uri !== undefined) {
      return new URL(uri).host;
    }
  } catch {
    // not a did:peer:2 — no host to derive
  }
  return undefined;
}
