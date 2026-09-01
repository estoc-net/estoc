import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listKeys, parseSeedKeystore } from "@estoc/keystore";
import { hashObject, readObject, signObject, verifyObjectCard } from "@estoc/folder-object";
import { readTree } from "@estoc/folder-object/fs";
import {
  ANCHOR_KEY_NAME,
  ESTOC_DIR,
  createVaultKey,
  findVault,
  initVault,
  openVault,
  openVaultKey,
  readConfig,
  readKeystore,
} from "../src/vault.js";

const PASSPHRASE = "correct horse battery staple";
const seaDay = fileURLToPath(new URL("../../folder-object/test/fixtures/sea-day/", import.meta.url));

let base: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "estoc-cli-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("initVault", () => {
  it("creates .estoc with a config and a v3 keystore holding the anchor", async () => {
    const root = path.join(base, "my-vault");
    const { vault, did } = await initVault(root, "my-vault", PASSPHRASE);

    expect(vault.dir).toBe(path.join(root, ESTOC_DIR));
    expect(did).toMatch(/^did:key:z6Mk/);

    const config = await readConfig(vault);
    expect(config).toEqual({
      format: "estoc",
      version: 2,
      label: "my-vault",
      identity: { anchor: { key: ANCHOR_KEY_NAME, did } },
    });
    // version 2 on disk: the config carries the anchor only, the label is an event
    const onDisk = JSON.parse(await readFile(path.join(vault.dir, "config.json"), "utf8"));
    expect(onDisk).toEqual({ format: "estoc", version: 2, identity: { anchor: { key: ANCHOR_KEY_NAME, did } } });

    const doc = parseSeedKeystore(await readFile(path.join(vault.dir, "keystore.json"), "utf8"));
    expect(doc.version).toBe(3);
    expect(listKeys(doc)).toHaveLength(1);
    expect(listKeys(doc)[0]).toMatchObject({ name: ANCHOR_KEY_NAME, did });

    // The seed actually unlocks with the init passphrase and derives the anchor.
    const anchor = await openVaultKey(vault, ANCHOR_KEY_NAME, PASSPHRASE);
    expect(anchor.did).toBe(did);
    await expect(openVaultKey(vault, ANCHOR_KEY_NAME, "wrong")).rejects.toThrow();
  });

  it("creates the root folder itself when missing", async () => {
    const root = path.join(base, "does", "not", "exist");
    await initVault(root, "x", PASSPHRASE);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it("sets restrictive modes on .estoc and keystore.json", async () => {
    const { vault } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    expect((await stat(vault.dir)).mode & 0o777).toBe(0o700);
    const keystoreMode = (await stat(path.join(vault.dir, "keystore.json"))).mode;
    expect(keystoreMode & 0o777).toBe(0o600);
  });

  it("refuses to init where .estoc already exists", async () => {
    const root = path.join(base, "v");
    await initVault(root, "v", PASSPHRASE);
    await expect(initVault(root, "v", PASSPHRASE)).rejects.toThrow(/already exists/);
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

describe("createVaultKey", () => {
  it("derives a key by name under the same seed and records it", async () => {
    const { vault, did } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    const otherDid = await createVaultKey(vault, "org/estoc", PASSPHRASE);

    const keys = listKeys(await readKeystore(vault));
    expect(keys.map((k) => k.name)).toEqual([ANCHOR_KEY_NAME, "org/estoc"]);
    expect(keys.map((k) => k.did)).toEqual([did, otherDid]);
    expect(otherDid).not.toBe(did);

    // One seed, one passphrase: the new key opens with the vault passphrase
    // and derives the same DID it was recorded as.
    const identity = await openVaultKey(vault, "org/estoc", PASSPHRASE);
    expect(identity.did).toBe(otherDid);
  });

  it("rejects the wrong passphrase", async () => {
    const { vault } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    await expect(createVaultKey(vault, "x", "other passphrase")).rejects.toThrow();
  });

  it("rejects a duplicate name", async () => {
    const { vault } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    await expect(createVaultKey(vault, ANCHOR_KEY_NAME, PASSPHRASE)).rejects.toThrow(/already exists/);
  });
});

describe("openVaultKey", () => {
  it("refuses a keystore that does not derive the recorded anchor", async () => {
    const { vault } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    const config = await readConfig(vault);
    config.identity.anchor.did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
    await writeFile(path.join(vault.dir, "config.json"), JSON.stringify(config));
    await expect(openVaultKey(vault, ANCHOR_KEY_NAME, PASSPHRASE)).rejects.toThrow(/anchor/);
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
});

describe("readConfig", () => {
  it("rejects a config that is not an estoc vault", async () => {
    const { vault } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    await writeFile(path.join(vault.dir, "config.json"), JSON.stringify({ format: "something-else" }));
    await expect(readConfig(vault)).rejects.toThrow(/format is "something-else"/);
  });

  it("rejects a version 1 vault: this reader opens version 2 only", async () => {
    const { vault } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    const v1 = { format: "estoc", version: 1, label: "v", identity: { anchor: { key: ANCHOR_KEY_NAME, did: "did:key:z6Mk" } }, mediation: null };
    await writeFile(path.join(vault.dir, "config.json"), JSON.stringify(v1));
    await expect(readConfig(vault)).rejects.toThrow(/version 1 is not 2/);
  });

  it("rejects an unsupported version", async () => {
    const { vault } = await initVault(path.join(base, "v"), "v", PASSPHRASE);
    await writeFile(path.join(vault.dir, "config.json"), JSON.stringify({ format: "estoc", version: 99, label: "v" }));
    await expect(readConfig(vault)).rejects.toThrow(/version 99 is not 2/);
  });
});
