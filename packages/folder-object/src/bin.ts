#!/usr/bin/env node
/**
 * estoc-object — the folder-object reference tool.
 *
 *   estoc-object key init   --keystore <file> --key <name>      create a v3 keystore (or add a key) and print its did:key
 *   estoc-object key list   --keystore <file>
 *   estoc-object hash       <objectDir>                          root CID of the canonical tree
 *   estoc-object sign       <objectDir> --keystore <file> --key <name> [--out card.jws]
 *   estoc-object verify     <bundleDir | bundle.zip | objectDir> [--card card.jws]
 *   estoc-object bundle     <objectDir> [--card card.jws] [--out <dir>] [--zip <file>]
 *   estoc-object render     <objectDir> --template <page.html> [--assets <urlBase>] [--out <file>]
 *
 * The passphrase is read from ESTOC_PASSPHRASE, else from a prompt (no echo on a TTY).
 */
import { readFile, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { stdin, stdout, stderr, env, argv, exit } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  addDerivedKey,
  createSeedKeystore,
  listKeys,
  openDerivedKey,
  parseSeedKeystore,
  serializeKeystore,
  unlockSeedKeystore,
} from "@estoc/keystore";
import { readTree, writeTree } from "./fs.js";
import { hashObject, readObject } from "./object.js";
import { signObject, verifyObjectCard } from "./card.js";
import { bundleTree, readBundle, unzipMapping, zipBundle } from "./bundle.js";
import { fillTemplate, renderPost } from "./render.js";
import type { FolderObject } from "./types.js";

interface Args {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(list: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (a.startsWith("--")) {
      const next = list[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = "true";
      else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function need(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (v === undefined || v === "true") throw new Error(`--${name} is required`);
  return v;
}

async function passphrase(confirm = false): Promise<string> {
  if (env["ESTOC_PASSPHRASE"]) return env["ESTOC_PASSPHRASE"];
  const ask = async (label: string): Promise<string> => {
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin });
      const line = await rl.question("");
      rl.close();
      return line;
    }
    stderr.write(`${label}: `);
    const rl = createInterface({ input: stdin, output: stderr, terminal: true });
    // hide echo: write nothing on keypress
    const orig = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    const line = await rl.question("");
    (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput = orig;
    rl.close();
    stderr.write("\n");
    return line;
  };
  const p = await ask("passphrase");
  if (confirm) {
    const again = await ask("confirm passphrase");
    if (again !== p) throw new Error("passphrases differ");
  }
  return p;
}

async function loadObject(dir: string): Promise<FolderObject> {
  return readObject(await readTree(dir));
}

async function loadAny(path: string): Promise<{ object: FolderObject; card?: string }> {
  const s = await stat(path);
  const mapping = s.isDirectory() ? await readTree(path) : unzipMapping(new Uint8Array(await readFile(path)));
  return readBundle(mapping);
}

async function openSigner(flags: Record<string, string>) {
  const file = need(flags, "keystore");
  const name = need(flags, "key");
  const doc = parseSeedKeystore(await readFile(file, "utf8"));
  const seedKey = await unlockSeedKeystore(doc, await passphrase());
  return (await openDerivedKey(doc, seedKey, name)).signer;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case "key": {
      const [sub] = positional;
      const file = need(flags, "keystore");
      if (sub === "list") {
        const doc = parseSeedKeystore(await readFile(file, "utf8"));
        stdout.write(JSON.stringify(listKeys(doc), null, 2) + "\n");
        return;
      }
      if (sub === "init") {
        const name = need(flags, "key");
        let doc, seedKey;
        try {
          doc = parseSeedKeystore(await readFile(file, "utf8"));
          seedKey = await unlockSeedKeystore(doc, await passphrase());
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          ({ doc, seedKey } = await createSeedKeystore(await passphrase(true)));
        }
        const added = await addDerivedKey(doc, seedKey, name);
        await writeFile(file, serializeKeystore(added.doc), { mode: 0o600 });
        stdout.write(added.identity.did + "\n");
        return;
      }
      throw new Error("key: expected init or list");
    }
    case "hash": {
      const object = await loadObject(positional[0] ?? ".");
      stdout.write((await hashObject(object)) + "\n");
      return;
    }
    case "sign": {
      const object = await loadObject(positional[0] ?? ".");
      const signer = await openSigner(flags);
      const jws = await signObject(object, signer);
      if (flags["out"]) await writeFile(flags["out"], jws + "\n");
      else stdout.write(jws + "\n");
      return;
    }
    case "verify": {
      const { object, card: bundled } = await loadAny(positional[0] ?? ".");
      const card = flags["card"] ? (await readFile(flags["card"], "utf8")).trim() : bundled;
      const root = await hashObject(object);
      stdout.write(`format  ${object.meta.format}\nid      ${object.meta.id}\nroot    ${root}\n`);
      if (card === undefined) {
        stdout.write("card    none (unsigned object)\n");
        return;
      }
      const verdict = await verifyObjectCard(card, object);
      stdout.write(`signer  ${verdict.did}\ncard    ${verdict.matches ? "VERIFIED — signs this tree" : `MISMATCH — signs ${verdict.root}`}\n`);
      if (!verdict.matches) exit(1);
      return;
    }
    case "bundle": {
      const object = await loadObject(positional[0] ?? ".");
      const card = flags["card"] ? (await readFile(flags["card"], "utf8")).trim() : undefined;
      if (flags["out"]) await writeTree(flags["out"], bundleTree(object, card));
      if (flags["zip"]) await writeFile(flags["zip"], zipBundle(object, card));
      if (!flags["out"] && !flags["zip"]) throw new Error("bundle: give --out <dir> and/or --zip <file>");
      return;
    }
    case "render": {
      const object = await loadObject(positional[0] ?? ".");
      const template = await readFile(need(flags, "template"), "utf8");
      const post = renderPost(object, flags["assets"] ? { assetBase: flags["assets"] } : {});
      const html = fillTemplate(template, {
        title: post.title,
        summary: post.summary,
        published: post.published,
        updated: post.updated ?? post.published,
        publishedDate: post.published?.slice(0, 10),
        lang: post.inLanguage ?? "en",
        tags: post.tag.join(", "),
        id: object.meta.id,
        root: await hashObject(object),
        body: post.bodyHtml,
      });
      if (flags["out"]) await writeFile(flags["out"], html);
      else stdout.write(html);
      return;
    }
    default:
      stderr.write("usage: estoc-object <key|hash|sign|verify|bundle|render> …\n");
      exit(2);
  }
}

main().catch((e: unknown) => {
  stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  exit(1);
});
