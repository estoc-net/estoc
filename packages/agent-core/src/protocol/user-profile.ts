import { currentDid, didPlaceholder, type ContactRecord } from "../vault/contacts.js";
import type { PlainMessage } from "../vault/messages.js";
import type { HandlerContext, ProtocolHandler } from "./handler.js";

/**
 * user-profile/1.0 (didcomm.org): who a contact says they are. Our
 * announcement doubles as the introduction that precedes the first
 * message to anyone; theirs is remembered as a claim and becomes the
 * petname only while the petname is still the DID placeholder — a name
 * the user typed is never overwritten by what the contact calls themself.
 */
export const PROFILE = "https://didcomm.org/user-profile/1.0/profile";
export const REQUEST_PROFILE = "https://didcomm.org/user-profile/1.0/request-profile";

/** The displayName a `profile` message announces, or null when it names none. */
export function announcedName(profile: PlainMessage): string | null {
  const body = profile.body as { profile?: { displayName?: unknown } };
  const name = body.profile?.displayName;
  return typeof name === "string" && name !== "" ? name : null;
}

/**
 * Send our profile to a contact and note that they have been introduced
 * to; `sendBackYours` asks for theirs. The displayName they see is
 * whatever we claim it is — a receiving UI should say as much.
 */
export async function shareProfile(
  contact: ContactRecord,
  sendBackYours: boolean,
  agent: HandlerContext
): Promise<void> {
  await agent.reply(contact, PROFILE, {
    profile: { displayName: agent.displayName() },
    send_back_yours: sendBackYours,
  });
  // re-read: delivery may have saved a freshly minted DID on the record
  const saved = await agent.vault.contacts.byCid(contact.cid);
  if (saved !== null && saved.profileSharedAt === undefined) {
    saved.profileSharedAt = new Date().toISOString();
    await agent.vault.contacts.put(saved);
  }
}

export const userProfileHandler: ProtocolHandler = {
  types: [PROFILE, REQUEST_PROFILE],

  async introduce(contact, agent) {
    await shareProfile(contact, true, agent);
  },

  async onInbound(record, contact, agent) {
    const { msg } = record;
    if (msg.type === REQUEST_PROFILE) {
      // Someone asked who we are: answer, without asking back.
      agent.log("profile requested; sending ours");
      await shareProfile(contact, false, agent);
      return;
    }

    const claimed = announcedName(msg);
    if (claimed !== null) {
      contact.claimedName = claimed;
      if (contact.name === didPlaceholder(currentDid(contact))) {
        contact.name = claimed;
      }
      await agent.saveContact(contact);
    }

    const body = msg.body as { send_back_yours?: unknown };
    if (body.send_back_yours === true && contact.profileSharedAt === undefined) {
      await shareProfile(contact, true, agent);
    }
  },
};
