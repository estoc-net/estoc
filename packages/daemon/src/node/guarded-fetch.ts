import dns from "node:dns";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * A fetch for URLs somebody else chose. A Node process, unlike a browser
 * tab, can reach whatever its network can — the router's admin page, a
 * cloud instance's metadata endpoint, a service on localhost — and a
 * package URL in a message is the sender's word. So the check is made
 * where it holds: at name resolution, on every address a name has, and
 * on the literal in the URL, refusing anything not a public unicast
 * address. Redirects are not followed (the caller says `redirect:
 * "error"`), so one check per request is the whole story.
 */

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    const found = addresses as dns.LookupAddress[];
    const bad = found.find((a) => !isPublicAddress(a.address));
    if (bad !== undefined || found.length === 0) {
      callback(
        Object.assign(new Error(`refused: ${hostname} resolves to ${bad?.address ?? "nothing"}, not a public address`), {
          code: "EBLOCKED",
        })
      );
      return;
    }
    if (options.all) {
      callback(null, found);
    } else {
      const first = found[0] as dns.LookupAddress;
      callback(null, first.address, first.family);
    }
  });
}

const dispatcher = new Agent({ connect: { lookup: guardedLookup as unknown as undefined } });

export const guardedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refused: ${url.protocol} is not a scheme a package comes over`);
  }
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(literal) && !isPublicAddress(literal)) {
    throw new Error(`refused: ${literal} is not a public address`);
  }
  try {
    const response = await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  } catch (err) {
    // undici says "fetch failed" and keeps the reason as the cause; the
    // reason is what a log should show, a refusal above all
    const cause = (err as { cause?: unknown }).cause;
    throw cause instanceof Error ? cause : err;
  }
};
