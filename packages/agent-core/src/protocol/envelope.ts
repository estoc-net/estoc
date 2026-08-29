/**
 * What a packed envelope says about itself before it is opened: the
 * protected header of a JWE or JWS, or the `typ` of a plaintext. Read
 * from the bytes on the wire, never from didcomm-rust's metadata, so the
 * trace describes what arrived even when opening it fails.
 */
export interface EnvelopeHeader {
  kind: "authcrypt" | "anoncrypt" | "signed" | "plain" | "unknown";
  /** the JWE key-agreement / JWS signing algorithm */
  alg?: string;
  /** the JWE content encryption */
  enc?: string;
  /** authcrypt: the sender's key id */
  skid?: string;
  /** the recipient key ids the envelope is addressed to (JWE) or signed with (JWS) */
  kids?: string[];
}

function base64urlJson(text: string): Record<string, unknown> | null {
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function kidsOf(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const kids: string[] = [];
  for (const item of list) {
    const kid = (item as { header?: { kid?: unknown } })?.header?.kid;
    if (typeof kid === "string") {
      kids.push(kid);
    }
  }
  return kids;
}

export function envelopeHeader(packed: string): EnvelopeHeader {
  let outer: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(packed);
    if (typeof parsed !== "object" || parsed === null) {
      return { kind: "unknown" };
    }
    outer = parsed as Record<string, unknown>;
  } catch {
    return { kind: "unknown" };
  }
  if (typeof outer.ciphertext === "string" && typeof outer.protected === "string") {
    const header = base64urlJson(outer.protected) ?? {};
    const skid = typeof header.skid === "string" ? header.skid : undefined;
    const result: EnvelopeHeader = { kind: skid === undefined ? "anoncrypt" : "authcrypt", kids: kidsOf(outer.recipients) };
    if (typeof header.alg === "string") result.alg = header.alg;
    if (typeof header.enc === "string") result.enc = header.enc;
    if (skid !== undefined) result.skid = skid;
    return result;
  }
  if (typeof outer.payload === "string" && Array.isArray(outer.signatures)) {
    const first = outer.signatures[0] as { protected?: unknown } | undefined;
    const header = typeof first?.protected === "string" ? (base64urlJson(first.protected) ?? {}) : {};
    const result: EnvelopeHeader = { kind: "signed", kids: kidsOf(outer.signatures) };
    if (typeof header.alg === "string") result.alg = header.alg;
    return result;
  }
  if (typeof outer.typ === "string") {
    return { kind: "plain" };
  }
  return { kind: "unknown" };
}
