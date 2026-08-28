#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { listKeys } from "@estoc/keystore";
import {
  hashObject,
  readAny,
  readObject,
  signObject,
  signedTree,
  verifyObjectCard,
  type FolderObject,
} from "@estoc/folder-object";
import { readTree, writeTree } from "@estoc/folder-object/fs";
import { isPost, renderPost, validatePost } from "@estoc/post";
import { unzipTree, zipTree } from "@estoc/folder-object/zip";
import { appDir } from "@estoc/app";
import { exitOnSignal, runDaemon } from "@estoc/daemon/node";
import { promptNewPassphrase, promptPassphrase } from "./prompt.js";
import { fill } from "./template.js";
import {
  ANCHOR_KEY_NAME,
  createVaultKey,
  findVault,
  initVault,
  openVault,
  openVaultKey,
  readConfig,
  readKeystore,
  type Vault,
} from "./vault.js";

const USAGE = `usage: estoc <command>

  init [--label <label>]         create a vault here: a .estoc directory with
                                 one seed-sealed keystore and its anchor key
  status                         show the enclosing vault and its keys
  key list                       list keys as JSON (no passphrase needed)
  key new <name>                 derive a key by name and record it

  object hash   [<dir>]          root CID of a folder-object (default: .)
  object sign   [<dir>] [--key <name>] [--out <signedDir>] [--zip <file>]
                                 sign the object with a vault key (default:
                                 anchor); prints the card, or lays the signed
                                 object ({object/, card.jws}) out under --out
                                 and/or zips it to --zip
  object verify [<signedDir | signed.zip | objectDir>] [--card card.jws]
  object render [<signedDir | signed.zip | objectDir>] [--template <html>]
                [--out <file>] [--asset-base <prefix>]
                                 project a post/1.0 object: its vocabulary,
                                 body as an HTML fragment, assets, files,
                                 root and signer — as JSON, or laid into a
                                 Mustache-style template ({{title}},
                                 {{{body}}}, {{#files}}{{path}}{{/files}},
                                 {{#card}}{{did}}{{/card}}, …). In-tree
                                 references are prefixed with --asset-base
                                 (default: object for a signed layout)

  serve [--port <n>] [--bind <addr>] [--app <url>] [--token <t>]
                                 run the daemon on the enclosing vault (make
                                 one with init) and serve the app for it at
                                 http://127.0.0.1:7357/; the page talks to
                                 this process, the vault is that .estoc.
                                 --app <url> also prints a ?_daemon= link
                                 for an app served elsewhere

options:
  --vault <dir>   use the vault at <dir> instead of searching upward from
                  the working directory (env: ESTOC_VAULT)
  --version       print the version
  -h, --help      show this help

Passphrase prompts read ESTOC_PASSPHRASE if set, else a no-echo prompt on a
TTY, else one line of stdin.
`;

/** --vault flag, then ESTOC_VAULT, then walk upward from cwd like git. */
async function requireVault(vaultFlag: string | undefined): Promise<Vault> {
  const explicit = vaultFlag ?? process.env["ESTOC_VAULT"];
  if (explicit) return openVault(explicit);
  const found = await findVault(process.cwd());
  if (!found) {
    throw new Error("not inside an estoc vault (run `estoc init`)");
  }
  return found;
}

async function cmdInit(label: string | undefined) {
  const root = process.cwd();
  const enclosing = await findVault(root);
  if (enclosing && enclosing.root !== root) {
    process.stderr.write(`warning: creating a vault inside another vault (${enclosing.root})\n`);
  }
  const passphrase = await promptNewPassphrase();
  const { vault, did } = await initVault(root, label ?? path.basename(root), passphrase);
  process.stdout.write(`initialized estoc vault in ${vault.dir}\n`);
  process.stdout.write(`${ANCHOR_KEY_NAME}  ${did}\n`);
}

async function cmdStatus(vaultFlag: string | undefined) {
  const vault = await requireVault(vaultFlag);
  const config = await readConfig(vault);
  const keys = listKeys(await readKeystore(vault));
  process.stdout.write(`vault   ${vault.root}\n`);
  process.stdout.write(`label   ${config.label}\n`);
  process.stdout.write(`anchor  ${config.identity.anchor.did}\n`);
  for (const key of keys) {
    process.stdout.write(`key     ${key.name}  ${key.did}  ${key.createdAt}\n`);
  }
}

async function cmdKeyList(vaultFlag: string | undefined) {
  const vault = await requireVault(vaultFlag);
  const keys = listKeys(await readKeystore(vault));
  process.stdout.write(JSON.stringify(keys, null, 2) + "\n");
}

async function cmdKeyNew(vaultFlag: string | undefined, name: string) {
  const vault = await requireVault(vaultFlag);
  const did = await createVaultKey(vault, name, await promptPassphrase());
  process.stdout.write(`${name}  ${did}\n`);
}

interface ServeFlags {
  vault?: string;
  port?: string;
  bind?: string;
  app?: string;
  token?: string;
}

async function cmdServe(flags: ServeFlags) {
  const { root } = await requireVault(flags.vault);
  const served = await runDaemon({
    root,
    port: flags.port === undefined ? undefined : Number(flags.port),
    bind: flags.bind,
    appDir,
    app: flags.app,
    token: flags.token,
  });
  exitOnSignal(served);
}

async function loadObject(dir: string): Promise<FolderObject> {
  return readObject(await readTree(dir));
}

/** A signed-object directory, a signed-object zip, or a bare object directory. */
async function loadAny(p: string): Promise<{ object: FolderObject; card?: string }> {
  const s = await stat(p);
  const mapping = s.isDirectory() ? await readTree(p) : unzipTree(new Uint8Array(await readFile(p)));
  return readAny(mapping);
}

async function readCard(file: string): Promise<string> {
  return (await readFile(file, "utf8")).trim();
}

interface ObjectFlags {
  vault?: string;
  key?: string;
  card?: string;
  out?: string;
  zip?: string;
  template?: string;
  "asset-base"?: string;
}

/** Every part a host page could want, in one view: the projection plus the fact it projects. */
async function renderView(target: string, flags: ObjectFlags) {
  const { object, card } = await loadAny(target);
  if (!isPost(object.meta)) throw new Error(`not a post/1.0 object: ${object.meta.format}`);
  const issues = validatePost(object.meta);
  if (issues.length) throw new Error(`invalid post: ${issues.map((i) => `${i.member} ${i.message}`).join("; ")}`);
  const assetBase = flags["asset-base"] ?? (card === undefined ? "" : "object");
  const post = renderPost(object, { assetBase });
  const root = await hashObject(object);
  const prefix = assetBase ? assetBase.replace(/\/$/, "") + "/" : "";
  const files = Object.keys(object.tree)
    .sort()
    .map((path) => ({ path, href: prefix + path }));
  const view: Record<string, unknown> = { ...post, format: object.meta.format, root, files };
  if (post.published) view["publishedDate"] = post.published.slice(0, 10);
  if (post.updated) view["updatedDate"] = post.updated.slice(0, 10);
  if (card !== undefined) {
    const verdict = await verifyObjectCard(card, object);
    if (!verdict.matches) throw new Error(`card MISMATCH — signs ${verdict.root}, not this object`);
    view["card"] = { did: verdict.did, file: "card.jws" };
  }
  return view;
}

async function cmdObject(sub: string | undefined, target: string, flags: ObjectFlags) {
  switch (sub) {
    case "hash": {
      process.stdout.write((await hashObject(await loadObject(target))) + "\n");
      return;
    }
    case "sign": {
      const object = await loadObject(target);
      const vault = await requireVault(flags.vault);
      const identity = await openVaultKey(vault, flags.key ?? ANCHOR_KEY_NAME, await promptPassphrase());
      const jws = await signObject(object, identity.signer);
      if (!flags.out && !flags.zip) {
        process.stdout.write(jws + "\n");
        return;
      }
      const signed = signedTree(object, jws);
      if (flags.out) await writeTree(flags.out, signed);
      if (flags.zip) await writeFile(flags.zip, zipTree(signed));
      return;
    }
    case "verify": {
      const { object, card: beside } = await loadAny(target);
      const card = flags.card ? await readCard(flags.card) : beside;
      const root = await hashObject(object);
      process.stdout.write(`format  ${object.meta.format}\nid      ${object.meta.id}\nroot    ${root}\n`);
      if (card === undefined) {
        process.stdout.write("card    none (an object, not a signed one)\n");
        return;
      }
      const verdict = await verifyObjectCard(card, object);
      process.stdout.write(`signer  ${verdict.did}\n`);
      process.stdout.write(`card    ${verdict.matches ? "VERIFIED — signs this object" : `MISMATCH — signs ${verdict.root}`}\n`);
      if (!verdict.matches) process.exitCode = 1;
      return;
    }
    case "render": {
      const view = await renderView(target, flags);
      const text = flags.template ? fill(await readFile(flags.template, "utf8"), view) : JSON.stringify(view, null, 2) + "\n";
      if (flags.out) await writeFile(flags.out, text);
      else process.stdout.write(text);
      return;
    }
    default:
      throw new Error(`unknown object subcommand: ${sub ?? "(none)"} (hash, sign, verify, render)`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      vault: { type: "string" },
      label: { type: "string" },
      key: { type: "string" },
      card: { type: "string" },
      out: { type: "string" },
      zip: { type: "string" },
      template: { type: "string" },
      "asset-base": { type: "string" },
      port: { type: "string" },
      bind: { type: "string" },
      app: { type: "string" },
      token: { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.version) {
    const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === "help") {
    process.stdout.write(USAGE);
    if (command === undefined && !values.help) process.exitCode = 1;
    return;
  }

  switch (command) {
    case "init":
      if (rest.length > 0) {
        throw new Error("estoc init takes no arguments; run it inside the folder");
      }
      await cmdInit(values.label);
      return;
    case "status":
      await cmdStatus(values.vault);
      return;
    case "key": {
      const sub = rest[0];
      if (sub === "list") return cmdKeyList(values.vault);
      if (sub === "new") {
        const name = rest[1];
        if (!name) throw new Error("usage: estoc key new <name>");
        return cmdKeyNew(values.vault, name);
      }
      throw new Error(`unknown key subcommand: ${sub ?? "(none)"}`);
    }
    case "object":
      await cmdObject(rest[0], rest[1] ?? ".", values);
      return;
    case "serve":
      if (rest.length > 0) {
        throw new Error("estoc serve takes no arguments; run it inside the vault (or --vault <dir>)");
      }
      await cmdServe(values);
      return;
    default:
      throw new Error(`unknown command: ${command} (try \`estoc --help\`)`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`estoc: ${(err as Error).message}\n`);
  process.exit(1);
});
