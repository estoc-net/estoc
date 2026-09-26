import type { Hold } from "./types.js";

/**
 * The hold a daemon's event carried, or null where it carried none.
 * What comes over a socket is whatever that daemon sent, and a daemon
 * of an earlier version sends no hold: a removal asked with none is
 * refused on this side, since the call it would become is one that
 * daemon takes as unconditional.
 */
export function holdOf(carried: unknown): Hold | null {
  return typeof carried === "string" && carried !== "" ? carried : null;
}
