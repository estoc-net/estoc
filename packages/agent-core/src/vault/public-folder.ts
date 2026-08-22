import type { VaultBackend } from "../backend/types.js";
import { STATE_DIR, prettyJson, text, utf8 } from "./layout.js";

/**
 * What the vault keeps about the published public folder — and all it
 * keeps: the folder's contents are the application's projection of vault
 * facts, regenerable at will, so the vault stores no copy of the tree and
 * none of its objects. What cannot be regenerated is what was *signed and
 * sent*: the current card, and the relay's receipt for it. That is enough
 * to renew, to know what is live, and to notice a takedown.
 *
 * One JSON file under `state/`, last write wins, carried by snapshots like
 * everything outside `cache/`.
 */

export const PUBLIC_FOLDER_STATE_PATH = `${STATE_DIR}/public-folder.json`;

/** The `published` receipt, field names as they came over the wire. */
export interface PublishedReceipt {
  did: string;
  card_id: string;
  /** how long the relay commits to keeping the publication — always a date (spec: REQUIRED) */
  retain_until: string;
}

export interface PublicFolderState {
  /** the current root card, compact JWS — what the relay serves */
  card: string;
  /** the relay's receipt for that card */
  receipt: PublishedReceipt;
  publishedAt: string;
}

export function parsePublicFolderState(json: string): PublicFolderState {
  const raw = JSON.parse(json) as Partial<PublicFolderState>;
  const receipt = raw.receipt as Partial<PublishedReceipt> | undefined;
  if (
    typeof raw.card !== "string" ||
    typeof raw.publishedAt !== "string" ||
    typeof receipt?.did !== "string" ||
    typeof receipt.card_id !== "string" ||
    typeof receipt.retain_until !== "string"
  ) {
    throw new Error("state/public-folder.json is not a public-folder state");
  }
  return {
    card: raw.card,
    publishedAt: raw.publishedAt,
    receipt: {
      did: receipt.did,
      card_id: receipt.card_id,
      retain_until: receipt.retain_until,
    },
  };
}

export class PublicFolderStore {
  constructor(private readonly backend: VaultBackend) {}

  async get(): Promise<PublicFolderState | null> {
    const bytes = await this.backend.read(PUBLIC_FOLDER_STATE_PATH);
    return bytes === null ? null : parsePublicFolderState(text(bytes));
  }

  async put(state: PublicFolderState): Promise<void> {
    await this.backend.write(PUBLIC_FOLDER_STATE_PATH, utf8(prettyJson(state)));
  }
}
