/**
 * What every open, laying and import looks at before it takes or
 * writes anything: the structural roots, `config.json`, and whether a
 * folder is empty enough to lay a vault in. Shared by the folder vault,
 * interchange and import, and depending on none of them.
 */

import type { VaultBackend } from "../../backend/types.js";
import { walk } from "../../backend/types.js";
import { DamagedLayout, NotAVault } from "../errors.js";
import type { Damaged } from "../event.js";
import { parseConfig, type Config } from "./config.js";
import { CONFIG_FILE, IMPORT_DIR, KEYSTORE_FILE, LOCAL_DIR } from "./layout.js";

/** Where ownership is named: under `local/`, this copy's own; on disk, the writer's pid file. */
export const OWNER_FILE = `${LOCAL_DIR}/owner.pid`;

/** What stands at the roots no store owns and the layout does not allow: a directory where `config.json` or `keystore.json` belongs, a file where `import/` or `local/` belongs; in path order. `events/` and `objects/` are their stores' to report. */
export async function layoutDamage(backend: VaultBackend, base: string): Promise<Damaged[]> {
  const damaged: Damaged[] = [];
  for (const file of [CONFIG_FILE, KEYSTORE_FILE]) {
    const at = `${base}/${file}`;
    if ((await backend.list(at)).length > 0 || (await backend.dirs(at)).length > 0) damaged.push({ where: file, error: `a directory where ${file} belongs` });
  }
  for (const dir of [IMPORT_DIR, LOCAL_DIR]) {
    if ((await backend.size(`${base}/${dir}`)) !== null) damaged.push({ where: dir, error: `a file where the ${dir} directory belongs` });
  }
  return damaged;
}

/** A file where `import/` or `local/` belongs is refused before ownership is taken or anything written. */
export async function checkRoots(backend: VaultBackend, base: string): Promise<void> {
  for (const damage of await layoutDamage(backend, base)) {
    if (damage.where === IMPORT_DIR || damage.where === LOCAL_DIR) throw new DamagedLayout(damage.where, damage.error);
  }
}

/** `config.json` read and checked; `NotAVault` when it is not there. */
export async function readConfig(backend: VaultBackend, base: string): Promise<Config> {
  const bytes = await backend.read(`${base}/${CONFIG_FILE}`);
  if (bytes === null) throw new NotAVault(`no ${base}/${CONFIG_FILE}: not a vault`);
  return parseConfig(bytes, CONFIG_FILE);
}

/**
 * A folder a vault may be laid in — by `create`, or by a restore or an
 * export: nothing under `base` but what ownership itself makes under
 * `local/`. Anything else — a config or keystore, a segment, an object,
 * `import/` state, an opaque file, other `local/` state — is refused as
 * `NotAVault`, naming the first path found, and nothing is written.
 */
export async function checkEmpty(backend: VaultBackend, base: string): Promise<void> {
  if ((await backend.size(base)) !== null) throw new NotAVault(`${base} is a file, not a folder to lay a vault in`);
  const prefix = `${base}/`;
  for (const path of await walk(backend, base)) {
    const rel = path.slice(prefix.length);
    if (rel.startsWith(`${OWNER_FILE}`)) continue;
    throw new NotAVault(`${base} is not an empty folder: ${rel} is there; a vault is created in an empty folder, never over one`);
  }
}
