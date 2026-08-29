import Onion from "./Onion.vue";
import { registerLens } from "./registry.js";

export { lensesFor, registerLens, type Lens, type LensContext } from "./registry.js";
export { foldOnion, type Onion as OnionView, type OnionLayer } from "./onion.js";

/**
 * The lenses this build ships with. The onion opens on any entry as long
 * as this device keeps a trace at all; whether that entry's part is still
 * there is the lens's own finding.
 */
registerLens({
  id: "onion",
  label: "peel",
  component: Onion,
  available: (_entry, { traceLevel }) => traceLevel !== "off",
});
