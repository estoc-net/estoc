/**
 * basicmessage/2.0 (didcomm.org): a line of chat. Nothing is answered
 * on the protocol's behalf; the type is registered so that a line of
 * chat is known mail, not an unknown protocol.
 */

import { BASIC_MESSAGE } from "../../protocol/basicmessage.js";
import type { Handler } from "./handler.js";

export const basicMessage: Handler = {
  types: [BASIC_MESSAGE],
  effectTypes: [],
  respond: async () => [],
};
