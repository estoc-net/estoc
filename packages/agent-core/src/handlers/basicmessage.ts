import { BASIC_MESSAGE } from "../protocol/basicmessage.js";
import type { ProtocolHandler } from "../handler.js";

export const basicmessageHandler: ProtocolHandler = {
  types: [BASIC_MESSAGE],
};
