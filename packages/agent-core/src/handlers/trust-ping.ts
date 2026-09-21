/**
 * trust-ping/2.0 (didcomm.org): a Ping asking whether the line is
 * live is answered with a ping-response, unless it said not to ask, or
 * its own expiry has come. The reply threads on the Ping's wire ID and
 * keeps its parent thread and timing, so that the Ping's expiry is the
 * reply's; it carries nothing and requests nothing, the receipt the
 * Ping may have asked for being a separate output of the vault's own.
 * Whether the Ping asked for a reply is in its body, so a Ping whose
 * body is gone earns none.
 */

import { PING_RESPONSE_EFFECT, PING_RESPONSE_TYPE, PING_TYPE } from "@estoc/vault";

import type { Handler } from "./handler.js";

export const trustPing: Handler = {
  types: [PING_TYPE],
  effectTypes: [PING_RESPONSE_EFFECT],
  async respond(input) {
    const { data } = input.source.event;
    const none = (because: string) => [{ effectType: PING_RESPONSE_EFFECT, content: null, because }];
    if (data.expiresTime !== null && input.now() >= data.expiresTime * 1000) return none("the Ping has expired");
    const body = await input.readBody();
    if (body === null) return none("the Ping's body is not here to say whether it asked for a reply");
    if (body["response_requested"] === false) return none("the Ping asked for no reply");
    return [
      {
        effectType: PING_RESPONSE_EFFECT,
        content: { type: PING_RESPONSE_TYPE, body: {}, thid: data.wireMessageId, pthid: data.pthid, createdTime: data.createdTime, expiresTime: data.expiresTime, pleaseAck: null, ack: [] },
      },
    ];
  },
};
