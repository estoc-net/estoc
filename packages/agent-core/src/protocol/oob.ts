import { base64urlToUtf8, utf8ToBase64url } from "@estoc/did-peer";

import type { InvitationRecord } from "@estoc/vault";
import { PLAIN_TYP } from "./didcomm.js";
import { OOB_INVITATION } from "./spec.js";

/**
 * out-of-band/2.0 invitations, as the DIDComm v2 spec has them: a plaintext
 * message, carried not in an envelope but base64url-encoded in the `_oob`
 * query parameter of a URL — the thing a QR code shows or a link opens.
 * The URL's host is a convenience for whoever taps it (an app that knows
 * what to do with `_oob`); every Estoc client reads only the parameter,
 * so an invitation minted at one deployment opens at any other.
 *
 * `goal_code` says what answering leads to. A mediator's says
 * `request-mediate`; a person's, here, `connect` — a conversation, in
 * words the `goal` spells out for whoever is looking at the link.
 */

export const GOAL_CONNECT = "connect";

export interface Invitation {
  type: typeof OOB_INVITATION;
  id: string;
  typ: typeof PLAIN_TYP;
  from: string;
  body: {
    goal_code?: string;
    goal?: string;
    accept?: string[];
  };
}

/** The invitation message an issued invitation record stands for. */
export function invitationMessage(record: InvitationRecord): Invitation {
  return {
    type: OOB_INVITATION,
    id: record.id,
    typ: PLAIN_TYP,
    from: record.did,
    body: {
      goal_code: GOAL_CONNECT,
      goal: record.goal,
      accept: ["didcomm/v2"],
    },
  };
}

/** `<base>?_oob=<base64url plaintext>` — base64url needs no escaping. */
export function invitationUrl(base: string, invitation: Invitation): string {
  const url = new URL(base);
  url.searchParams.set("_oob", utf8ToBase64url(JSON.stringify(invitation)));
  return url.toString();
}

/**
 * Read an invitation out of whatever was pasted or scanned: a URL carrying
 * `_oob`, the bare base64url parameter, or the plaintext JSON itself.
 * Anything else — a DID, a mediator URL, an unrelated message — throws.
 */
export function parseInvitation(input: string): Invitation {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("nothing to read an invitation from");
  }
  if (trimmed.startsWith("did:")) {
    throw new Error("that is a DID, not an invitation");
  }
  let json: string;
  if (trimmed.startsWith("{")) {
    json = trimmed;
  } else {
    let encoded = trimmed;
    if (trimmed.includes("://")) {
      const param = new URL(trimmed).searchParams.get("_oob");
      if (param === null) {
        throw new Error("that URL carries no _oob invitation");
      }
      encoded = param;
    }
    try {
      json = base64urlToUtf8(encoded);
    } catch {
      throw new Error("_oob does not decode");
    }
  }
  let message: Partial<Invitation>;
  try {
    message = JSON.parse(json) as Partial<Invitation>;
  } catch {
    throw new Error("_oob does not decode to a JSON message");
  }
  if (typeof message !== "object" || message === null || message.type !== OOB_INVITATION) {
    throw new Error("not an out-of-band 2.0 invitation");
  }
  if (typeof message.from !== "string" || !message.from.startsWith("did:")) {
    throw new Error("the invitation names no DID to write to");
  }
  if (typeof message.id !== "string" || message.id === "") {
    throw new Error("the invitation has no id");
  }
  const body =
    typeof message.body === "object" && message.body !== null ? message.body : {};
  return {
    type: OOB_INVITATION,
    id: message.id,
    typ: PLAIN_TYP,
    from: message.from,
    body: {
      ...(typeof body.goal_code === "string" ? { goal_code: body.goal_code } : {}),
      ...(typeof body.goal === "string" ? { goal: body.goal } : {}),
      ...(Array.isArray(body.accept) ? { accept: body.accept as string[] } : {}),
    },
  };
}
