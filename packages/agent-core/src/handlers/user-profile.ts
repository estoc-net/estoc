import { drafts } from "@estoc/vault";

import { PROFILE, REQUEST_PROFILE, announcedName } from "../protocol/user-profile.js";
import type { HandlerContext, ProtocolHandler } from "../handler.js";
import type { ContactRecord } from "../records.js";

/**
 * user-profile/1.0 (didcomm.org): who a contact says they are. Our
 * announcement doubles as the introduction that precedes the first
 * message to anyone, and is recorded as `profile.shared` on the channel
 * it went out by; theirs is recorded as `profile.nameClaimed` on the
 * channel it came by, with the message as grounds. Nothing here decides
 * a contact's name: the fold shows what they claimed until a petname
 * says otherwise (`nameOf`), so a name the user typed is not overwritten
 * by what the contact calls themself.
 */

/**
 * Send our profile to a contact and record that it went out;
 * `sendBackYours` asks for theirs. The displayName they see is whatever
 * we claim it is — a receiving UI should say as much.
 */
export async function shareProfile(contact: ContactRecord, sendBackYours: boolean, ctx: HandlerContext): Promise<void> {
  const sent = await ctx.reply(contact, PROFILE, {
    profile: { displayName: ctx.displayName() },
    send_back_yours: sendBackYours,
  });
  await ctx.record(drafts.profileShared({ ...sent.pair, mid: sent.mid }));
}

export const userProfileHandler: ProtocolHandler = {
  types: [PROFILE, REQUEST_PROFILE],

  async introduce(contact, ctx) {
    await shareProfile(contact, true, ctx);
  },

  async onInbound(record, contact, ctx) {
    const { msg } = record;
    if (msg.type === REQUEST_PROFILE) {
      // Someone asked who we are: answer, without asking back.
      ctx.log("profile requested; sending ours");
      await shareProfile(contact, false, ctx);
      return;
    }

    const claimed = announcedName(msg);
    if (claimed !== null) {
      await ctx.record(drafts.profileNameClaimed({ ...record.pair, mid: record.mid, name: claimed }));
    }

    const body = msg.body as { send_back_yours?: unknown };
    if (body.send_back_yours === true && contact.profileSharedAt === null) {
      await shareProfile(contact, true, ctx);
    }
  },
};
