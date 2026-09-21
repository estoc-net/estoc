import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createVault, inspectRuntime } from "@estoc/agent-core/v3";
import { RESTORE_EXPLAINED, VAULT_FILE, connect, decode, encode, type Daemon, type DaemonStorage, type Phase, type Port, type Snapshot } from "@estoc/daemon/v3";
import { ESTOC_DIR, SOCKET_FILE, nodeHost, vaultDir } from "@estoc/daemon/v3/node";
import { DatabaseBusy } from "@estoc/event-store/v3";
import { createSeedKeystore, deriveIdentity, unlockSeedKeystore, type DerivedIdentity } from "@estoc/keystore";
import { ANCHOR_KEY_NAME, Keys } from "@estoc/vault/v3";

export { ANCHOR_KEY_NAME, ESTOC_DIR };

/**
 * A vault is any folder the user owns with a `.estoc` directory inside —
 * the git model: the folder holds the user's content, `.estoc` holds ours,
 * which is the daemon's Node host's: `vault.sqlite` and what it keeps
 * beside it. The folder is one process's at a time. A command takes it
 * for as long as it runs; when a daemon has it, the command asks the
 * daemon instead, at the socket the daemon left word of.
 */
export interface Vault {
  /** The user's folder. */
  root: string;
  /** `root`/.estoc */
  dir: string;
}

function vaultAt(root: string): Vault {
  const resolved = path.resolve(root);
  return { root: resolved, dir: path.join(resolved, ESTOC_DIR) };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk from `startDir` upward to the filesystem root looking for a `.estoc`
 * directory, like git discovering its repository.
 */
export async function findVault(startDir: string): Promise<Vault | null> {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = vaultAt(current);
    if (await isDirectory(candidate.dir)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The vault whose root is exactly `root`, or an error if none is there. */
export async function openVault(root: string): Promise<Vault> {
  const vault = vaultAt(root);
  if (!(await isDirectory(vault.dir))) {
    throw new Error(`no ${ESTOC_DIR} directory in ${vault.root}`);
  }
  return vault;
}

/** The daemon that holds a folder, as far as one replay of where it stands. */
interface Remote {
  daemon: Daemon;
  /** the socket without its token */
  at: string;
  phase: Phase;
  detail: string | null;
  snapshot: Snapshot | null;
  close(): void;
}

type Reached = { storage: DaemonStorage } | { remote: Remote };

function socketPort(ws: WebSocket): Port {
  return {
    postMessage: (message) => ws.send(encode(message)),
    addEventListener(type: "message" | "close", listener: (event: MessageEvent) => void) {
      if (type === "close") ws.addEventListener("close", () => (listener as () => void)());
      else
        ws.addEventListener("message", (event) => {
          let data: unknown;
          try {
            data = decode(String(event.data));
          } catch {
            ws.close();
            return;
          }
          listener({ data } as MessageEvent);
        });
    },
  } as Port;
}

async function daemonOf(vault: Vault): Promise<Remote> {
  let url: URL;
  try {
    url = new URL((await readFile(path.join(vault.dir, SOCKET_FILE), "utf8")).trim());
  } catch {
    throw new Error(`${vault.dir} is held by another process, and no daemon says where it listens`);
  }
  const at = url.origin;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error(`${vault.dir} is held by another process, and no daemon answers at ${at}`)));
  });
  const remote: Remote = { daemon: null as unknown as Daemon, at, phase: "booting", detail: null, snapshot: null, close: () => ws.close() };
  const told = (snapshot: Snapshot) => {
    remote.phase = "open";
    remote.detail = null;
    remote.snapshot = snapshot;
  };
  remote.daemon = connect<Daemon>(socketPort(ws), {
    phase(phase: Phase, detail: string | null) {
      remote.phase = phase;
      remote.detail = detail;
      remote.snapshot = null;
    },
    opened: told,
    changed: told,
  });
  try {
    await remote.daemon.boot();
  } catch (err) {
    ws.close();
    throw err;
  }
  return remote;
}

/** The folder's files in this process, or the daemon that has them. */
async function reach(vault: Vault): Promise<Reached> {
  await vaultDir(vault.root);
  try {
    return { storage: await nodeHost(vault.root).storage() };
  } catch (err) {
    if (!(err instanceof DatabaseBusy)) throw err;
  }
  return { remote: await daemonOf(vault) };
}

async function refuseForeign(vault: Vault): Promise<void> {
  const foreign = await nodeHost(vault.root).unreadable?.();
  if (foreign != null) throw new Error(foreign);
}

export interface InitResult {
  vault: Vault;
  /** did:key of the vault's anchor. */
  did: string;
}

/**
 * A vault made in `root`/.estoc, as the daemon makes one: a fresh seed
 * sealed under `passphrase`, the anchor it derives, `label` as the first
 * `identity.label`. Creates `root` itself if needed, with default modes —
 * the content folder is theirs — and `.estoc` at 0700, which is what
 * keeps the files inside from anyone else. A vault that stands there
 * already is refused and left as it is.
 */
export async function initVault(root: string, label: string, passphrase: string): Promise<InitResult> {
  const vault = vaultAt(root);
  await refuseForeign(vault);
  await mkdir(vault.root, { recursive: true });
  const reached = await reach(vault);
  if ("remote" in reached) {
    const { remote } = reached;
    try {
      if (remote.phase !== "onboarding") throw new Error(`${vault.dir} already holds a vault`);
      await remote.daemon.createIdentity(label, passphrase);
      if (remote.snapshot === null) throw new Error(`the daemon at ${remote.at} made the vault and did not show it`);
      return { vault, did: remote.snapshot.anchor };
    } finally {
      remote.close();
    }
  }
  const { storage } = reached;
  try {
    if (await storage.has(VAULT_FILE)) throw new Error(`${vault.dir} already holds a vault`);
    const { doc, seedKey } = await createSeedKeystore(passphrase);
    const driver = await storage.open(VAULT_FILE, "create", "runtime");
    try {
      const created = await createVault(driver, { seedKey, wrapped: { version: 3, seedJwe: doc.seedJwe }, label });
      try {
        await created.runtime.local.options.set(RESTORE_EXPLAINED, true);
      } finally {
        await created.runtime.close();
      }
    } catch (err) {
      driver.close();
      await storage.remove(VAULT_FILE);
      throw err;
    }
    return { vault, did: await Keys.anchorOf(seedKey) };
  } finally {
    await storage.close();
  }
}

/** What `estoc status` shows. Of a vault a daemon holds locked, only the daemon knows more than the phase. */
export interface VaultStatus {
  /** the vault's identity; null when the daemon that holds it has not opened it */
  anchor: string | null;
  label: string | null;
  /** the daemon that holds the folder, when one does */
  daemon: { at: string; phase: Phase; detail: string | null } | null;
}

export async function vaultStatus(vault: Vault): Promise<VaultStatus> {
  await refuseForeign(vault);
  const reached = await reach(vault);
  if ("remote" in reached) {
    const { remote } = reached;
    remote.close();
    const { at, phase, detail, snapshot } = remote;
    return { anchor: snapshot?.anchor ?? null, label: snapshot?.label ?? null, daemon: { at, phase, detail } };
  }
  return looked(vault, reached.storage, async ({ runtime, fold }) => ({ anchor: runtime.metadata.anchor, label: fold.label, daemon: null }));
}

async function looked<T>(vault: Vault, storage: DaemonStorage, work: (inspected: Awaited<ReturnType<typeof inspectRuntime>>) => Promise<T>): Promise<T> {
  try {
    if (!(await storage.has(VAULT_FILE))) throw new Error(`no vault in ${vault.dir} yet (run \`estoc init\`)`);
    const inspected = await inspectRuntime(await storage.open(VAULT_FILE, "readwrite", "runtime"));
    try {
      return await work(inspected);
    } finally {
      await inspected.runtime.close();
    }
  } finally {
    await storage.close();
  }
}

/**
 * The key `name` derives under the vault's seed, once the seed the
 * passphrase unlocks has derived the vault's own anchor. Nothing is
 * recorded: a name always derives the same key. The seed never leaves
 * the process that unlocked it, so while a daemon holds the vault there
 * is no key to hand to this one.
 */
export async function openVaultKey(vault: Vault, name: string, passphrase: string): Promise<DerivedIdentity> {
  await refuseForeign(vault);
  const reached = await reach(vault);
  if ("remote" in reached) {
    reached.remote.close();
    throw new Error(`the daemon at ${reached.remote.at} holds this vault, and its keys stay with it: stop it to sign here`);
  }
  return looked(vault, reached.storage, async ({ runtime, wrapped }) => {
    const seedKey = await unlockSeedKeystore({ version: 3, seedJwe: wrapped.seedJwe, keys: [] }, passphrase);
    await Keys.open(seedKey, runtime.metadata.anchor);
    return deriveIdentity(seedKey, name);
  });
}
