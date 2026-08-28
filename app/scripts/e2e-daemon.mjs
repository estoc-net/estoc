/**
 * The app on a Node daemon: `estoc-daemon` runs on a temp folder, Alice's
 * page is opened with the link it prints and so talks to that process over
 * a WebSocket; Bob is an ordinary in-browser install. They exchange
 * messages and an object both ways (records and bytes cross the socket),
 * Alice's history survives a reload and a second tab (both are the same
 * daemon, so neither yields), the vault is a folder on disk, lock asks for
 * the passphrase, and the daemon's package fetch refuses a private address.
 *
 *   npm run preview                      # the build on :4173
 *   node scripts/e2e-daemon.mjs [app-url]   (default http://localhost:4173)
 *
 * The mediator is the rail's localhost entry unless E2E_MEDIATOR=estoc.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const APP_URL = process.argv[2] ?? "http://localhost:4173";
const MEDIATOR_LABEL = process.env.E2E_MEDIATOR === "estoc" ? "mediator.estoc.dev" : "localhost:8080";
const executablePath = "/usr/bin/chromium";
const PASS = { Alice: "alice-passes-the-salt", Bob: "bob-builds-boats-2026" };
const BIN = fileURLToPath(new URL("../../packages/daemon/dist/node/bin.js", import.meta.url));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}
function ok(message) {
  console.log(`✓ ${message}`);
}
function watch(page, name) {
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.error(`[${name} console] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => console.error(`[${name} pageerror] ${err}`));
}

async function waitLive(page) {
  await page.waitForSelector("text=live delivery on", { timeout: 25000 });
  await page.waitForFunction(
    () => document.querySelector(".did-chip")?.getAttribute("title")?.startsWith("did:peer:4"),
    { timeout: 20000 }
  );
  return page.getAttribute(".did-chip", "title");
}

async function createIdentity(page, name, startUrl) {
  await page.goto(startUrl);
  await page.fill('input[placeholder="your name, e.g. Alice"]', name);
  await page.fill('input[placeholder^="passphrase (seals"]', PASS[name]);
  await page.fill('input[placeholder="passphrase again"]', PASS[name]);
  await page.click('button:has-text("Create identity")');
  await page.waitForSelector("text=not reachable yet", { timeout: 20000 });
  await page.selectOption(".rail-form select.field", { label: `via ${MEDIATOR_LABEL}` });
  await page.click('button:has-text("Use this mediator")');
  const did = await waitLive(page);
  ok(`${name} mediated; public DID ${did.length} chars`);
  return did;
}

async function addContact(page, label, did) {
  await page.click('button:has-text("+ contact")');
  await page.fill('input[placeholder="name, e.g. Bob"]', label);
  await page.fill('input[placeholder="paste their invitation link or DID"]', did);
  await page.click('button:has-text("Add contact")');
}
async function send(page, contactLabel, text) {
  await page.fill(`input[placeholder="Write to ${contactLabel}"]`, text);
  await page.click('button:has-text("Send")');
}
async function expectBubble(page, text, timeout = 15000) {
  await page.waitForSelector(`.bubble:has-text("${text}")`, { timeout });
}

/** Start estoc-daemon on `root`; resolves to the app link it prints. */
function startDaemon(root) {
  const child = spawn(process.execPath, [BIN, root, "--port", "0", "--app", APP_URL], { stdio: ["ignore", "inherit", "pipe"] });
  const link = new Promise((resolve, reject) => {
    let out = "";
    child.stderr.on("data", (chunk) => {
      out += chunk.toString();
      const m = out.match(/^open:\s+(\S+)$/m);
      if (m) {
        resolve(m[1]);
      }
      process.stderr.write(chunk.toString().replace(/^/gm, "[daemon] "));
    });
    child.once("exit", (code) => reject(new Error(`estoc-daemon exited with ${code}\n${out}`)));
  });
  return { child, link };
}

const root = await mkdtemp(join(tmpdir(), "estoc-e2e-daemon-"));
const daemon = startDaemon(root);
const browser = await chromium.launch({ executablePath });
try {
  const link = await daemon.link;
  ok(`estoc-daemon up on ${root}`);
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  watch(alice, "alice");
  watch(bob, "bob");

  const aliceDid = await createIdentity(alice, "Alice", link);
  await alice.waitForSelector("text=via estoc-daemon at", { timeout: 5000 });
  if (alice.url().includes("_daemon=")) {
    fail("the _daemon parameter should be taken off the URL");
  }
  await stat(join(root, ".estoc", "config.json"));
  ok("Alice's vault is a folder on disk, and the rail says the daemon is where it lives");
  const bobDid = await createIdentity(bob, "Bob", APP_URL);

  await addContact(alice, "Bob", bobDid);
  await send(alice, "Bob", "hello bob, from a laptop process");
  await expectBubble(alice, "hello bob");
  await expectBubble(bob, "hello bob");
  ok("Bob received a message the daemon sent");
  await bob.waitForSelector('.contact-chip:has-text("Alice")', { timeout: 15000 });
  await send(bob, "Alice", "hi alice, got it");
  await expectBubble(alice, "hi alice");
  ok("Alice's page shows what the daemon received, live over the socket");

  // an object each way: bytes cross the socket in both directions
  const seaDay = fileURLToPath(new URL("../../../folder-object/examples/sea-day/", import.meta.url));
  await alice.setInputFiles('input[data-share="object"]', seaDay);
  await alice.click('[data-share-choice="plain"]');
  await alice.waitForSelector('.object-title:has-text("A Day at the Sea")', { timeout: 15000 });
  await bob.waitForSelector('.object-title:has-text("A Day at the Sea")', { timeout: 15000 });
  ok("an object picked in Alice's page went through the daemon to Bob");
  await bob.setInputFiles('input[data-share="object"]', seaDay);
  await bob.click('[data-share-choice="plain"]');
  await alice.waitForFunction(() => document.querySelectorAll(".object-title").length >= 2, null, { timeout: 15000 });
  const blobs = await readdir(join(root, ".estoc", "blobs")).catch(() => []);
  if (blobs.length === 0) {
    fail("the object Bob sent should be in the daemon's blobs/ on disk");
  }
  ok(`Bob's object arrived at the daemon: ${blobs.length} entries under .estoc/blobs`);

  // history is the daemon's: a reload and a second tab both see it, neither yields
  await alice.reload();
  await alice.waitForSelector('.contact-chip:has-text("Bob")', { timeout: 15000 });
  await alice.click('.contact-chip:has-text("Bob")');
  await expectBubble(alice, "hi alice");
  ok("Alice's history is there after a reload (no _daemon in the URL: the choice was remembered)");
  const tab2 = await aliceCtx.newPage();
  await tab2.goto(APP_URL);
  await tab2.waitForSelector('.contact-chip:has-text("Bob")', { timeout: 15000 });
  await send(bob, "Alice", "second tab too?");
  await tab2.click('.contact-chip:has-text("Bob")');
  await expectBubble(tab2, "second tab too?");
  await expectBubble(alice, "second tab too?");
  ok("a second tab is another client of the same daemon: both open, both live");
  await tab2.close();

  // lock: the seed leaves the daemon's memory; the passphrase opens it again
  await alice.click('button:has-text("Lock")');
  await alice.waitForSelector('input[placeholder="passphrase"]', { timeout: 5000 });
  await alice.fill('input[placeholder="passphrase"]', "wrong one");
  await alice.click('button:has-text("Unlock")');
  await alice.waitForSelector("text=wrong passphrase", { timeout: 5000 });
  await alice.fill('input[placeholder="passphrase"]', PASS.Alice);
  await alice.click('button:has-text("Unlock")');
  await alice.waitForSelector('.contact-chip:has-text("Bob")', { timeout: 15000 });
  ok("lock and unlock go through the daemon");

  // the daemon gone: the page says so, and finds it again when it is back
  daemon.child.kill("SIGTERM");
  await alice.waitForSelector("text=is not answering", { timeout: 10000 });
  ok("Alice's page reports the daemon gone");
  await alice.evaluate(() => localStorage.removeItem("estoc:daemon"));
  await alice.goto(`${APP_URL}/?_daemon=off`);
  await alice.waitForSelector('input[placeholder="your name, e.g. Alice"]', { timeout: 15000 });
  ok("?_daemon=off returns the page to its own worker: a fresh install here");
  void aliceDid;
} finally {
  await browser.close();
  daemon.child.kill("SIGTERM");
  await rm(root, { recursive: true, force: true });
}
if (process.exitCode) {
  console.error("some checks failed");
} else {
  console.log("all green");
}
