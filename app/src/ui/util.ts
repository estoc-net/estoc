import type { ObservationRecord } from "../core/types.js";

/** did:peer:4 long forms run ~800 characters; show head and tail. */
export function shortDid(did: string): string {
  return did.length <= 36 ? did : `${did.slice(0, 22)}…${did.slice(-8)}`;
}

export function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export async function bytesOf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** The short form of a did:peer:4, which is how a channel names its ends; any other DID as it is. */
export function shortFormOf(did: string): string {
  return did.startsWith("did:peer:4") ? did.split(":").slice(0, 3).join(":") : did;
}

/** What the vault made of an observation, in a phrase: whether it is taken in, and what stands in the way when it is not. */
export function dispositionOf({ disposition }: ObservationRecord): string {
  switch (disposition.status) {
    case "admitted":
      return "taken in";
    case "refused":
      return `refused: ${disposition.because}`;
    case "ignored-superseded":
      return "ignored: they had moved to another address";
    case "pending-admission":
      return `not taken in yet: ${disposition.because}`;
  }
}
