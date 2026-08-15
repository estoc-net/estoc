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

/** A File's bytes. */
export async function bytesOf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
