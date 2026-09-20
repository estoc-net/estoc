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
