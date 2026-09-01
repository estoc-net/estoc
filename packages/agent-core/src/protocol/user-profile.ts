import type { PlainMessage } from "../records.js";

/**
 * user-profile/1.0 (didcomm.org): who a contact says they are — the
 * types, and what a `profile` announces. What the agent does with one
 * is the handler's (`handlers/user-profile.ts`).
 */
export const PROFILE = "https://didcomm.org/user-profile/1.0/profile";
export const REQUEST_PROFILE = "https://didcomm.org/user-profile/1.0/request-profile";

/** The displayName a `profile` message announces, or null when it names none. */
export function announcedName(profile: PlainMessage): string | null {
  const body = profile.body as { profile?: { displayName?: unknown } };
  const name = body.profile?.displayName;
  return typeof name === "string" && name !== "" ? name : null;
}
