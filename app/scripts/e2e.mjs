/**
 * Full-flow smoke against a running mediator and a served build: two
 * isolated browser contexts mint Alice and Bob, exchange DIDs and message
 * each other (live delivery, no reload); then the app's own promises get
 * exercised — history survives a
 * reload, a second tab yields to the first, lock asks for the passphrase,
 * a backup zip restores the identity in a fresh browser and receives mail
 * there, importing a backup into a live vault merges instead of clobbering,
 * and (where a service worker is serving) the shell opens with the network
 * off.
 *
 *   npm run preview        # serves the build on :4173 with the service worker
 *   node scripts/e2e.mjs [app-url]        (default http://localhost:4173)
 *
 * The mediator both identities use is whatever the rail's dropdown
 * offers — the localhost entry unless E2E_MEDIATOR=estoc (production,
 * did:web:mediator.estoc.dev) or E2E_MEDIATOR=<url> (any other value is a
 * mediator's URL — the entry a VITE_MEDIATOR_DID build labels with that
 * URL's host).
 */
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const APP_URL = process.argv[2] ?? "http://localhost:4173";
const E2E_MEDIATOR = process.env.E2E_MEDIATOR;
let MEDIATOR_LABEL = "localhost:8080";
let MEDIATOR_URL = "http://localhost:8080";
if (E2E_MEDIATOR === "estoc" || E2E_MEDIATOR === "web") {
  MEDIATOR_LABEL = "mediator.estoc.dev";
  MEDIATOR_URL = "https://mediator.estoc.dev";
} else if (E2E_MEDIATOR === "estoc-peer2") {
  MEDIATOR_LABEL = "mediator.estoc.dev (did:peer:2)";
  MEDIATOR_URL = "https://mediator.estoc.dev";
} else if (E2E_MEDIATOR !== undefined && E2E_MEDIATOR !== "local") {
  MEDIATOR_URL = E2E_MEDIATOR;
  MEDIATOR_LABEL = new URL(E2E_MEDIATOR).host;
}

const executablePath = "/usr/bin/chromium";
const PASS = { Alice: "alice-passes-the-salt", Bob: "bob-builds-boats-2026" };

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

async function createIdentity(page, name, invitationUrl = null) {
  await page.goto(APP_URL);
  await page.fill('input[placeholder="your name, e.g. Alice"]', name);
  await page.fill('input[placeholder^="passphrase (seals"]', PASS[name]);
  await page.fill('input[placeholder="passphrase again"]', PASS[name]);
  await page.click('button:has-text("Create identity")');
  // The identity exists before any mediator does: the rail says so, and
  // offers the choice.
  await page.waitForSelector("text=not reachable yet", { timeout: 20000 });
  ok(`${name} minted without a mediator`);
  if (invitationUrl === null) {
    await page.selectOption(".rail-form select.field", { label: `via ${MEDIATOR_LABEL}` });
  } else {
    await page.selectOption(".rail-form select.field", { label: "via a pasted invitation…" });
    await page.fill('input[placeholder="invitation URL, mediator URL, or DID"]', invitationUrl);
  }
  await page.click('button:has-text("Use this mediator")');
  const did = await waitLive(page);
  if (!did || !did.startsWith("did:peer:4")) {
    throw new Error(`${name} has no public did:peer:4 after mediation`);
  }
  ok(`${name} mediated; public DID ${did.length} chars`);
  return did;
}

async function addContact(page, label, did) {
  await page.click('button:has-text("+ contact")');
  await page.fill('input[placeholder="name, e.g. Bob"]', label);
  await page.fill('input[placeholder="paste their DID (did:peer:4… or did:web:…)"]', did);
  await page.click('button:has-text("Add contact")');
}

async function send(page, contactLabel, text) {
  await page.fill(`input[placeholder="Write to ${contactLabel}"]`, text);
  await page.click('button:has-text("Send")');
}

async function expectBubble(page, text, timeout = 15000) {
  await page.waitForSelector(`.bubble:has-text("${text}")`, { timeout });
}

const browser = await chromium.launch({ executablePath });
try {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  watch(alice, "alice");
  watch(bob, "bob");

  // Alice onboards by pasting the mediator's OOB invitation URL; Bob uses
  // the dropdown, so both bootstrap paths stay covered.
  const { invitationUrl } = await (await fetch(MEDIATOR_URL)).json();
  if (typeof invitationUrl !== "string" || !invitationUrl.includes("_oob=")) {
    throw new Error(`mediator at ${MEDIATOR_URL} publishes no invitation URL`);
  }
  const aliceDid = await createIdentity(alice, "Alice", invitationUrl);
  const bobDid = await createIdentity(bob, "Bob");

  await addContact(alice, "Bob", bobDid);
  await send(alice, "Bob", "hello bob, through the mediator");
  await expectBubble(alice, "hello bob");
  ok("Alice's sent message shows in her thread");
  await expectBubble(bob, "hello bob");
  ok("Bob received it live over the WebSocket");

  await bob.waitForSelector('.contact-chip:has-text("Alice")', { timeout: 15000 });
  await expectBubble(bob, "introduced themself as “Alice”");
  await expectBubble(alice, "introduced themself as “Bob”");
  ok("profiles exchanged both ways; Bob's stranger contact took Alice's claimed name");

  await addContact(bob, "Alice", aliceDid);
  await send(bob, "Alice", "hi alice, got it");
  await expectBubble(alice, "hi alice");
  ok("Alice received Bob's reply live");

  // Reload: history and identity come back from the OPFS vault, no passphrase.
  await bob.reload();
  await expectBubble(bob, "hello bob");
  await bob.waitForSelector("text=live delivery on", { timeout: 25000 });
  ok("Bob's history and live delivery survive a reload without a passphrase");

  // A second tab of the same browser must not open a second agent.
  const bob2 = await bobCtx.newPage();
  await bob2.goto(APP_URL);
  await bob2.waitForSelector("text=Open in another tab", { timeout: 10000 });
  ok("a second tab waits for the first (Web Locks)");
  await bob2.close();

  // Lock: the seed cache is dropped; the passphrase — and only the right one — reopens.
  await bob.click('button:has-text("Lock")');
  await bob.waitForSelector("text=Locked", { timeout: 5000 });
  await bob.fill('input[placeholder="passphrase"]', "not-it");
  await bob.click('button:has-text("Unlock")');
  await bob.waitForSelector("text=wrong passphrase", { timeout: 10000 });
  await bob.fill('input[placeholder="passphrase"]', PASS.Bob);
  await bob.click('button:has-text("Unlock")');
  await expectBubble(bob, "hello bob");
  await bob.waitForSelector("text=live delivery on", { timeout: 25000 });
  ok("lock → wrong passphrase refused → right passphrase reopens with history");

  // Backup: Alice exports her vault; a fresh browser restores it and is Alice.
  const [download] = await Promise.all([
    alice.waitForEvent("download"),
    alice.click('button:has-text("Export backup")'),
  ]);
  const zipName = download.suggestedFilename();
  // the download lives with Alice's context; keep a copy that outlives it
  const zipPath = join(await mkdtemp(join(tmpdir(), "estoc-e2e-")), zipName);
  await copyFile(await download.path(), zipPath);
  if (!zipName.endsWith(".estoc.zip")) {
    fail(`backup is named ${zipName}, expected *.estoc.zip`);
  }
  ok(`Alice exported ${zipName}`);

  // Merge first, while Alice is still up: her own backup has nothing new.
  await alice.setInputFiles('.file-btn input[type=file]', zipPath);
  await alice.waitForSelector("text=nothing new in that backup", { timeout: 15000 });
  await expectBubble(alice, "hello bob");
  await alice.waitForSelector("text=live delivery on", { timeout: 25000 });
  ok("importing her own backup merges nothing and leaves the vault as it was");

  // One receiver at a time: the original Alice goes away before the restore comes up.
  await aliceCtx.close();
  const alice2Ctx = await browser.newContext();
  const alice2 = await alice2Ctx.newPage();
  watch(alice2, "alice2");
  await alice2.goto(APP_URL);
  await alice2.click('button:has-text("Restore a backup")');
  await alice2.setInputFiles('input[type=file]', zipPath);
  await alice2.fill('input[placeholder="the backup\'s passphrase"]', "wrong-one");
  await alice2.click('button.btn:has-text("Restore")');
  await alice2.waitForSelector("text=does not open this backup", { timeout: 15000 });
  await alice2.setInputFiles('input[type=file]', zipPath);
  await alice2.fill('input[placeholder="the backup\'s passphrase"]', PASS.Alice);
  await alice2.click('button.btn:has-text("Restore")');
  const restoredDid = await waitLive(alice2);
  if (restoredDid !== aliceDid) {
    fail("restored Alice has a different public DID");
  }
  await expectBubble(alice2, "hello bob");
  await expectBubble(alice2, "hi alice");
  ok("a fresh browser restored Alice from the zip: same DID, full history");

  await send(bob, "Alice", "welcome back, alice");
  await expectBubble(alice2, "welcome back");
  ok("restored Alice receives new mail live");

  // Offline: with a service worker in charge, the shell opens with the network off.
  // (The worker registered on this page's first load takes control on the next;
  // one online reload first, then the network goes away.)
  const hasSw = await alice2.evaluate(() =>
    "serviceWorker" in navigator
      ? Promise.race([
          navigator.serviceWorker.ready.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
        ])
      : false
  );
  if (hasSw) {
    await alice2.reload();
    await expectBubble(alice2, "hello bob", 20000);
    await alice2.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 10000 });
    await alice2Ctx.setOffline(true);
    await alice2.reload();
    await expectBubble(alice2, "hello bob", 20000);
    ok("offline: the app shell and history open with no network");
    await alice2Ctx.setOffline(false);
  } else {
    console.log("· no service worker (dev server?) — offline check skipped");
  }

  await alice2.screenshot({ path: "scripts/e2e-alice.png", fullPage: true });
  await bob.screenshot({ path: "scripts/e2e-bob.png", fullPage: true });

  if (process.exitCode !== 1) {
    console.log("\nall green");
  }
} finally {
  await browser.close();
}
