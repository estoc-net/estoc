/**
 * blob-store/1.0 (`docs/blob-store.md`), the client side: ask our own
 * mediator to keep bytes named by hash, then PUT them where it says. It
 * is a mediation service — spoken to the mediator, never a contact — so
 * like mediation and pickup it stays out of the message log.
 */

export const BLOB_STORE_PROTOCOL = "https://estoc.dev/blob-store/1.0";
export const BLOB_PUT = `${BLOB_STORE_PROTOCOL}/put`;
export const BLOB_PUT_RESULT = `${BLOB_STORE_PROTOCOL}/put-result`;
export const BLOB_DELETE = `${BLOB_STORE_PROTOCOL}/delete`;
export const BLOB_DELETE_RESULT = `${BLOB_STORE_PROTOCOL}/delete-result`;

/** What a put came back with: where the blob is, how long, and where to send the bytes if it lacks them. */
export interface BlobPlacement {
  hash: string;
  url: string;
  /** ISO 8601 */
  retainUntil: string;
  upload: { url: string; expires: string } | null;
}

/** Read a put-result body; throws if it is not one. */
export function parsePutResult(body: Record<string, unknown>): BlobPlacement {
  const { hash, url, retain_until, upload } = body as Partial<{
    hash: string;
    url: string;
    retain_until: string;
    upload: { url?: unknown; expires?: unknown };
  }>;
  if (typeof hash !== "string" || typeof url !== "string" || typeof retain_until !== "string") {
    throw new Error("blob put-result is malformed");
  }
  let placed: BlobPlacement["upload"] = null;
  if (upload !== undefined) {
    if (typeof upload?.url !== "string" || typeof upload.expires !== "string") {
      throw new Error("blob put-result upload is malformed");
    }
    placed = { url: upload.url, expires: upload.expires };
  }
  return { hash, url, retainUntil: retain_until, upload: placed };
}
