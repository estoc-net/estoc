/**
 * user-profile/1.0 (didcomm.org): who a contact says they are. What a
 * profile announces is a claim the peer made in one channel, shown
 * beside it as such and read off the body when it is displayed; it
 * makes no contact and renames none, since a name the user gave stands
 * over what a peer calls themself. Nothing is answered on the
 * protocol's behalf: sharing our own profile is the application's
 * choice, made as a send.
 */

import type { JsonObject } from "@estoc/event-store/v3";

import { PROFILE, REQUEST_PROFILE, announcedName } from "../../protocol/user-profile.js";
import type { Handler } from "./handler.js";

export const userProfile: Handler = {
  types: [PROFILE, REQUEST_PROFILE],
  effectTypes: [],
  respond: async () => [],
};

/** The display name a profile's body claims, or null when it claims none; for display beside the channel it came by. */
export function claimedName(body: JsonObject): string | null {
  return announcedName({ body });
}
