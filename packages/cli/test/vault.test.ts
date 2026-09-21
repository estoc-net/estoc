import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOCKET_FILE, nodeHost, runDaemon, type Served } from "@estoc/daemon/node";
import { hashObject, readObject, signObject, verifyObjectCard } from "@estoc/folder-object";
import { readTree } from "@estoc/folder-object/fs";
import { ANCHOR_KEY_NAME, ESTOC_DIR, findVault, initVault, openVault, openVaultKey, vaultStatus } from "../src/vault.js";

const PASSPHRASE = "correct horse battery staple";
const seaDay = fileURLToPath(new URL("../../folder-object/test/fixtures/sea-day/", import.meta.url));

let base: string;
let daemons: Served[];

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "estoc-cli-"));
  daemons = [];
});

afterEach(async () => {
  for (const daemon of daemons) await daemon.close();
  await rm(base, { recursive: true, force: true });
});

async function daemonOn(root: string): Promise<Served> {
  const served = await runDaemon({ root, port: 0, appDir: null, log: () => undefined });
  daemons.push(served);
  return served;
}

describe("initVault", () => {
  it("makes a vault the passphrase opens, under the anchor its seed derives", async () => {
    const root = path.join(base, "my-vault");
    const { vault, did } = await initVault(root, "my-vault", PASSPHRASE);

    expect(vault.dir).toBe(path.join(root, ESTOC_DIR));
    expect(did).toMatch(/^did:key:z6Mk/);
    expect((await readdir(vault.dir)).filter((name) => name.endsWith(".sqlite")).sort()).toEqual(["owner.sqlite", "vault.sqlite"]);
    expect(await vaultStatus(vault)).toEqual({ anchor: did, label: "my-vault", daemon: null, damaged: null });

    expect((await openVaultKey(vault, ANCHOR_KEY_NAME, PASSPHRASE)).did).toBe(did);
    await expect(openVaultKey(vault, ANCHOR_KEY_NAME, "wrong")).rejects.toThrow();
  });

  it("creates the root folder itself when missing", async () => {
    const root = path.join(base, "does", "not", "exist");
    await initVault(root, "x", PASSPHRASE);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it("keeps .estoc to its owner", async () => {
    const { vault } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    expect((await stat(vault.dir)).mode & 0o777).toBe(0o700);
  });

  it("closes a .estoc that stood open to others before anything is written into it", async () => {
    for (const held of [false, true]) {
      const root = path.join(base, held ? "held" : "free");
      await mkdir(path.join(root, ESTOC_DIR), { recursive: true });
      await chmod(path.join(root, ESTOC_DIR), 0o755);
      if (held) {
        await daemonOn(root);
        expect((await stat(path.join(root, ESTOC_DIR))).mode & 0o777).toBe(0o700);
        await chmod(path.join(root, ESTOC_DIR), 0o755);
      }
      const { vault } = await initVault(root, "v", PASSPHRASE);
      expect((await stat(vault.dir)).mode & 0o777).toBe(0o700);
    }
  });

  it("refuses a folder that holds a vault already, and leaves it as it is", async () => {
    const root = path.join(base, "v");
    const { vault, did } = await initVault(root, "first", PASSPHRASE);
    await expect(initVault(root, "second", "another passphrase")).rejects.toThrow(/already holds a vault/);
    expect(await vaultStatus(vault)).toMatchObject({ anchor: did, label: "first" });
  });

  it("says of a vault whose history is damaged that it is, read here or held by a daemon, and still derives its keys: the seed does not hang on the history", async () => {
    const root = path.join(base, "v");
    const { vault, did } = await initVault(root, "v", PASSPHRASE);
    const db = new DatabaseSync(path.join(vault.dir, "vault.sqlite"));
    const { event_id: eventId, canonical } = db.prepare("SELECT event_id, canonical FROM events LIMIT 1").get() as { event_id: string; canonical: Uint8Array };
    db.prepare("UPDATE events SET canonical = ? WHERE event_id = ?").run(canonical.slice(0, -3), eventId);
    db.close();

    const damaged = expect.stringMatching(/^events\/.* is damaged/);
    expect(await vaultStatus(vault)).toEqual({ anchor: did, label: null, daemon: null, damaged });
    expect((await openVaultKey(vault, ANCHOR_KEY_NAME, PASSPHRASE)).did).toBe(did);

    const { url } = await daemonOn(root);
    expect(await vaultStatus(vault)).toEqual({ anchor: null, label: null, daemon: { at: new URL(url).origin, phase: "damaged", detail: damaged }, damaged });
  });

  it("writes nothing beside a vault of the folder format", async () => {
    const root = path.join(base, "v");
    await mkdir(path.join(root, ESTOC_DIR), { recursive: true });
    await writeFile(path.join(root, ESTOC_DIR, "config.json"), JSON.stringify({ format: "estoc", version: 2 }));

    await expect(initVault(root, "v", PASSPHRASE)).rejects.toThrow(/folder format/);
    await expect(vaultStatus(await openVault(root))).rejects.toThrow(/folder format/);
    await expect(runDaemon({ root, port: 0, appDir: null, log: () => undefined })).rejects.toThrow(/folder format/);
    expect(await readdir(path.join(root, ESTOC_DIR))).toEqual(["config.json"]);
  });
});

describe("findVault", () => {
  it("walks upward from a nested directory, like git", async () => {
    const root = path.join(base, "v");
    await initVault(root, "v", PASSPHRASE);
    const nested = path.join(root, "a", "b");
    await mkdir(nested, { recursive: true });

    const found = await findVault(nested);
    expect(found?.root).toBe(root);
    expect(found?.dir).toBe(path.join(root, ESTOC_DIR));
  });

  it("returns null when no vault encloses the directory", async () => {
    expect(await findVault(base)).toBeNull();
  });

  it("ignores a plain file named .estoc", async () => {
    const root = path.join(base, "v");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, ESTOC_DIR), "not a directory");
    expect(await findVault(root)).toBeNull();
  });
});

describe("openVault", () => {
  it("rejects a folder without .estoc", async () => {
    await expect(openVault(base)).rejects.toThrow(/no \.estoc directory/);
  });
});

describe("openVaultKey", () => {
  it("derives the same key for a name every time, and another for another name", async () => {
    const { vault, did } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    const blog = await openVaultKey(vault, "blog", PASSPHRASE);
    expect(blog.did).toMatch(/^did:key:z6Mk/);
    expect(blog.did).not.toBe(did);
    expect((await openVaultKey(vault, "blog", PASSPHRASE)).did).toBe(blog.did);
  });

  it("signs a folder-object with a vault key that verifies", async () => {
    const { vault, did } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    const identity = await openVaultKey(vault, ANCHOR_KEY_NAME, PASSPHRASE);
    const object = readObject(await readTree(seaDay));
    const jws = await signObject(object, identity.signer);
    const verdict = await verifyObjectCard(jws, object);
    expect(verdict.did).toBe(did);
    expect(verdict.matches).toBe(true);
    expect(verdict.root).toBe(await hashObject(object));
  });

  it("says so where no vault was made yet", async () => {
    const root = path.join(base, "v");
    await mkdir(path.join(root, ESTOC_DIR), { recursive: true });
    await expect(openVaultKey(await openVault(root), ANCHOR_KEY_NAME, PASSPHRASE)).rejects.toThrow(/no vault in .* yet/);
  });
});

describe("a folder a daemon holds", () => {
  it("is asked of the daemon: a locked vault shows its phase, its keys stay where they are", async () => {
    const root = path.join(base, "v");
    const { vault, did } = await initVault(root, "v", PASSPHRASE);
    const served = await daemonOn(root);
    const at = new URL(served.url).origin;

    expect(await vaultStatus(vault)).toEqual({ anchor: null, label: null, daemon: { at, phase: "locked", detail: null }, damaged: null });
    await expect(openVaultKey(vault, ANCHOR_KEY_NAME, PASSPHRASE)).rejects.toThrow(/holds this vault/);
    await expect(initVault(root, "again", PASSPHRASE)).rejects.toThrow(/already holds a vault/);

    await served.daemon.unlock(PASSPHRASE);
    expect(await vaultStatus(vault)).toEqual({ anchor: did, label: "v", daemon: { at, phase: "open", detail: null }, damaged: null });
  });

  it("has its vault made by the daemon, and is this process's again once the daemon is gone", async () => {
    const root = path.join(base, "v");
    const served = await daemonOn(root);

    const { vault, did } = await initVault(root, "made over the socket", PASSPHRASE);
    expect(await vaultStatus(vault)).toMatchObject({ anchor: did, label: "made over the socket", daemon: { phase: "open" } });

    await served.close();
    daemons = [];
    await expect(readFile(path.join(vault.dir, SOCKET_FILE))).rejects.toThrow();
    expect(await vaultStatus(vault)).toEqual({ anchor: did, label: "made over the socket", daemon: null, damaged: null });
    expect((await openVaultKey(vault, ANCHOR_KEY_NAME, PASSPHRASE)).did).toBe(did);
  });

  it("says who holds it when nobody left word of a socket", async () => {
    const root = path.join(base, "v");
    const { vault } = await initVault(root, "v", PASSPHRASE);
    await daemonOn(root);
    await rm(path.join(vault.dir, SOCKET_FILE));
    await expect(vaultStatus(vault)).rejects.toThrow(/held by another process/);
  });

  it("leaves the word of the daemon that took the folder over alone", async () => {
    const root = path.join(base, "v");
    const { vault } = await initVault(root, "v", PASSPHRASE);
    const first = await daemonOn(root);
    const waiting = runDaemon({ root, port: 0, appDir: null, log: () => undefined });

    await first.close();
    const second = await waiting;
    daemons = [second];
    expect(await readFile(path.join(vault.dir, SOCKET_FILE), "utf8")).toBe(second.url);

    await first.close();
    expect(await readFile(path.join(vault.dir, SOCKET_FILE), "utf8")).toBe(second.url);
    expect(await vaultStatus(vault)).toMatchObject({ daemon: { phase: "locked" } });
  });

  it("gives back the port and the folder when it cannot come up", async () => {
    const root = path.join(base, "v");
    const { vault } = await initVault(root, "v", PASSPHRASE);
    const failures: { options: Partial<Parameters<typeof runDaemon>[0]>; error: RegExp }[] = [
      { options: { app: "not a url" }, error: /Invalid URL/ },
      { options: {}, error: /EISDIR/ },
    ];
    await mkdir(path.join(vault.dir, SOCKET_FILE));
    for (const { options, error } of failures) {
      const lines: string[] = [];
      await expect(runDaemon({ root, port: 0, appDir: null, log: (line) => lines.push(line), ...options })).rejects.toThrow(error);

      const socket = new URL(lines.find((line) => line.startsWith("socket:"))!.split(/\s+/)[1]!);
      await expect(fetch(`http://${socket.host}/`)).rejects.toThrow();
      await (await nodeHost(root).storage()).close();
    }
  });
});
