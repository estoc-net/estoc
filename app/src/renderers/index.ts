import {
  BASIC_MESSAGE,
  OBJECT_SHARE,
  PROFILE,
  REQUEST_PROFILE,
  TRUST_PING,
  TRUST_PING_RESPONSE,
} from "@estoc/agent-core";

import BasicMessage from "./BasicMessage.vue";
import Generic from "./Generic.vue";
import ObjectShare from "./ObjectShare.vue";
import Profile from "./Profile.vue";
import { registerFallback, registerRenderer } from "./registry.js";

export { registerRenderer, rendererFor, showsInThread, type MessageRenderer } from "./registry.js";

/**
 * The renderers this build ships with, registered by type. Everything
 * between contacts is in the log (see agent-core); this is where the app
 * decides what of it a thread shows, and how.
 */
registerRenderer({ types: [BASIC_MESSAGE], component: BasicMessage });
registerRenderer({ types: [PROFILE], component: Profile });
registerRenderer({ types: [OBJECT_SHARE], component: ObjectShare });
// Heartbeats and profile requests are protocol plumbing: logged, not a
// line in the conversation. Anything nobody registered is the opposite —
// unknown, so shown, so it is not silently swallowed.
registerRenderer({
  types: [TRUST_PING, TRUST_PING_RESPONSE, REQUEST_PROFILE],
  component: Generic,
  shows: () => false,
});
registerFallback({ types: [], component: Generic });
