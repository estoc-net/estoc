import { BASIC_MESSAGE, PROFILE, REQUEST_PROFILE, TRUST_PING, TRUST_PING_RESPONSE } from "@estoc/agent-core";

import BasicMessage from "./BasicMessage.vue";
import Generic from "./Generic.vue";
import Profile from "./Profile.vue";
import { registerFallback, registerRenderer } from "./registry.js";

export { needsAttention, registerRenderer, rendererFor, showsInThread, typeOf, type MessageRenderer } from "./registry.js";

/**
 * The renderers this build ships with, registered by type. Everything
 * between peers is in the vault; this is where the app decides what of
 * it a thread shows, and how.
 */
registerRenderer({ types: [BASIC_MESSAGE], component: BasicMessage });
registerRenderer({ types: [PROFILE], component: Profile });
// Heartbeats and profile requests are protocol plumbing: kept, not a line
// in the conversation (the registry hides what the vault sends on its own). Anything nobody registered is the
// opposite: unknown, so shown, so it is not silently swallowed.
registerRenderer({
  types: [TRUST_PING, TRUST_PING_RESPONSE, REQUEST_PROFILE],
  component: Generic,
  shows: () => false,
});
registerFallback({ types: [], component: Generic });
