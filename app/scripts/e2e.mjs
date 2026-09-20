/**
 * Full-flow smoke against a running mediator and a served build: three
 * isolated browser contexts mint Alice, Bob and Carol, meet over invitation
 * links and message each other (live delivery, no reload); then the app's
 * own promises get exercised: a conversation is named, a DID is rotated by
 * hand and the thread goes on over it, a draft stays with the peer who
 * rotates under it, history survives a reload, a second
 * tab yields to the first, lock asks for the passphrase, a backup file
 * restores the identity in a fresh browser, where sending waits for the
 * restore to be explained, importing a backup into a live vault merges
 * instead of clobbering, and (where a service worker is serving) the shell
 * opens with the network off.
 *
 *   npm run preview        # serves the build on :4173 with the service worker
 *   node scripts/e2e.mjs [app-url]        (default http://localhost:4173)
 *
 * The mediator every identity uses is whatever the rail's dropdown
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
} else if (E2E_MEDIATOR !== undefined && E2E_MEDIATOR !== "local") {
  MEDIATOR_URL = E2E_MEDIATOR;
  MEDIATOR_LABEL = new URL(E2E_MEDIATOR).host;
}

const executablePath = "/usr/bin/chromium";
const PASS = { Alice: "alice-passes-the-salt", Bob: "bob-builds-boats-2026", Carol: "carol-carries-cardamom" };

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function watch(page, name) {
  pages[name] = page;
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.error(`[${name} console] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => console.error(`[${name} pageerror] ${err}`));
}

const waitLive = (page) => page.waitForSelector("text=live delivery on", { timeout: 30000 });

async function createIdentity(page, name, mediatorInvitation = null, startUrl = APP_URL) {
  await page.goto(startUrl);
  await page.fill('input[placeholder="your name, e.g. Alice"]', name);
  await page.fill('input[placeholder^="passphrase (seals"]', PASS[name]);
  await page.fill('input[placeholder="passphrase again"]', PASS[name]);
  await page.click('button:has-text("Create identity")');
  // The identity exists before any mediator does: the rail says so, and
  // offers the choice.
  await page.waitForSelector("text=not reachable yet", { timeout: 30000 });
  ok(`${name} minted without a mediator`);
  if (mediatorInvitation === null) {
    await page.selectOption(".rail-form select.field", { label: `via ${MEDIATOR_LABEL}` });
  } else {
    await page.selectOption(".rail-form select.field", { label: "via a pasted invitation…" });
    await page.fill('input[placeholder="invitation URL, mediator URL, or DID"]', mediatorInvitation);
  }
  await page.click('button:has-text("Use this mediator")');
  await waitLive(page);
  ok(`${name} mediated: live delivery on`);
}

async function invite(page) {
  await page.click('button:has-text("New invitation link")');
  await page.waitForSelector("[data-invitation-url]", { timeout: 20000 });
  const url = await page.getAttribute("[data-invitation-url]", "title");
  if (!url?.includes("_oob=")) {
    throw new Error("the invitation link carries no _oob");
  }
  return url;
}

async function send(page, label, text) {
  await page.fill(`input[placeholder="Write to ${label}"]`, text);
  await page.click('button:has-text("Send")');
}

async function expectBubble(page, text, timeout = 30000) {
  await page.waitForSelector(`.bubble:has-text("${text}")`, { timeout });
}

const channelsShown = (page, count) => page.waitForSelector(`[data-details-toggle]:has-text("${count} channel")`, { timeout: 45000 });

/** What a page says of itself when a step times out: the composer's error and the tail of the rail's log. */
async function dump(page, name) {
  const lines = await page.locator(".compose-error, .rail-log p").allInnerTexts().catch(() => []);
  console.error(`[${name}]\n  ${lines.slice(-12).join("\n  ")}`);
}

const pages = {};
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
  await createIdentity(alice, "Alice", invitationUrl);
  await createIdentity(bob, "Bob");

  // Bob hands Alice a link; she pastes it under a name of her own for him.
  const bobLink = await invite(bob);
  // A mediator with long endpoints makes a link no QR code holds; the link is what must be there.
  if ((await bob.locator(".invitation .qr svg, [data-no-qr]").count()) !== 1) {
    fail("the invitation should show as a QR code too, or say why it cannot");
  }
  ok("Bob issued a single-use invitation link (with a QR where it fits one)");
  await alice.click('button:has-text("+ contact")');
  await alice.fill('input[placeholder="name, e.g. Bob"]', "Bob");
  await alice.fill('input[placeholder="paste their invitation link"]', bobLink);
  await alice.click('button:has-text("Add contact")');
  await alice.waitForSelector('.contact-chip.active:has-text("Bob")', { timeout: 30000 });
  ok("Alice accepted it: Bob is a contact of hers");

  // On Bob's side nobody is named yet: the conversation opens under what
  // she calls herself, quoted as the claim it is, until he names it.
  await bob.waitForSelector('.contact-chip.nameless:has-text("Alice")', { timeout: 45000 });
  await bob.waitForSelector("[data-invitation-taken]", { timeout: 15000 });
  await bob.waitForFunction(() => !document.body.innerText.includes("open link"), null, { timeout: 15000 });
  ok("Bob saw Alice arrive under the name she claims; the link is taken");
  await bob.click('.contact-chip.nameless:has-text("Alice")');
  await bob.click("[data-details-toggle]");
  await bob.fill('[data-details] input[placeholder="what you call them"]', "Alice");
  await bob.click('button:has-text("Name this conversation")');
  await bob.waitForSelector('.contact-chip.active:not(.nameless):has-text("Alice")', { timeout: 15000 });
  ok("Bob named the conversation: a contact of his now");

  await send(alice, "Bob", "hello bob, through the mediator");
  await expectBubble(alice, "hello bob");
  await alice.waitForSelector('.bubble:has-text("hello bob") [data-delivery]:has-text("handed over")', { timeout: 30000 });
  ok("Alice's message shows in her thread, handed over to the mediator");
  await expectBubble(bob, "hello bob");
  ok("Bob received it live over the WebSocket");
  await send(bob, "Alice", "hi alice, loud and clear");
  await expectBubble(alice, "hi alice");
  ok("Alice received Bob's reply live");

  // The DID in Bob's link was disclosed; the first thing written to it
  // moved him to one minted for Alice alone, and she followed the proof.
  await channelsShown(bob, 2);
  await channelsShown(alice, 2);
  ok("Bob's disclosed DID gave way to a private one; both sides show the two channels");

  // A rotation by hand: Alice mints a fresh DID toward Bob and tells him.
  await alice.click("[data-details-toggle]");
  await alice.locator("[data-rotate]").last().click();
  await alice.waitForFunction(() => document.querySelectorAll("[data-channel]").length === 3, null, { timeout: 45000 });
  await alice.click("[data-details-toggle]");
  await send(alice, "Bob", "same alice, new address");
  await expectBubble(bob, "same alice, new address", 45000);
  await channelsShown(bob, 3);
  await send(bob, "Alice", "followed you there");
  await expectBubble(alice, "followed you there", 45000);
  ok("Alice rotated her DID by hand; the thread goes on over the new channel both ways");

  // Carol opens a link of Bob's before she has an identity at all.
  const carolLink = await invite(bob);
  const carolCtx = await browser.newContext();
  const carol = await carolCtx.newPage();
  watch(carol, "carol");
  await createIdentity(carol, "Carol", null, carolLink);
  await carol.waitForSelector("text=You were handed an invitation", { timeout: 10000 });
  ok("Carol opened the link before she had an identity; it waited through onboarding");
  await carol.fill('input[placeholder="what you call them, e.g. Alice"]', "Bob (invited)");
  await carol.click('button:has-text("Accept invitation")');
  await carol.waitForSelector('.contact-chip.active:has-text("Bob (invited)")', { timeout: 30000 });
  await bob.waitForSelector('.contact-chip.nameless:has-text("Carol")', { timeout: 45000 });
  await bob.click('.contact-chip.nameless:has-text("Carol")');
  await send(bob, "“Carol”", "welcome carol");
  await expectBubble(carol, "welcome carol");
  await send(carol, "Bob (invited)", "thanks bob");
  await expectBubble(bob, "thanks bob");
  ok("Bob and Carol talk both ways before he has named her");

  // Carol moves to a new DID while Bob, who has named only Alice, is
  // writing to her: the pair his open conversation is known by moves, and
  // the conversation and what he was writing stay hers.
  await channelsShown(bob, 2);
  await bob.fill('input[placeholder="Write to “Carol”"]', "for carol alone");
  await carol.click("[data-details-toggle]");
  await carol.locator("[data-rotate]").last().click();
  await channelsShown(bob, 3);
  if ((await bob.locator(".chat-head h2").innerText()) !== "“Carol”" || (await bob.inputValue(".composer input.field")) !== "for carol alone") {
    fail("a peer's rotation should leave the open conversation and its draft where they were");
  }
  await bob.click('button:has-text("Send")');
  await expectBubble(carol, "for carol alone", 45000);
  await bob.click('.contact-chip:has-text("Alice")');
  if ((await bob.inputValue(".composer input.field")) !== "" || (await alice.locator('.bubble:has-text("for carol alone")').count()) !== 0) {
    fail("what was written to Carol should reach nobody else");
  }
  ok("Carol rotated while Bob was writing to her: the draft stayed hers and reached her alone");
  await carolCtx.close();

  // Reload: history and identity come back from the vault, no passphrase.
  await bob.reload();
  await bob.click('.contact-chip:has-text("Alice")');
  await expectBubble(bob, "hello bob");
  await waitLive(bob);
  ok("Bob's history and live delivery survive a reload without a passphrase");

  // A second tab of the same browser must not open a second agent.
  const bob2 = await bobCtx.newPage();
  await bob2.goto(APP_URL);
  await bob2.waitForSelector("text=Open in another tab", { timeout: 15000 });
  ok("a second tab waits for the first");
  await bob2.close();

  // Lock: the seed cache is dropped; the passphrase — and only the right one — reopens.
  await bob.click('button:has-text("Lock")');
  await bob.waitForSelector("text=Locked", { timeout: 15000 });
  await bob.fill('input[placeholder="passphrase"]', "not-it");
  await bob.click('button:has-text("Unlock")');
  await bob.waitForSelector("text=wrong passphrase", { timeout: 15000 });
  await bob.fill('input[placeholder="passphrase"]', PASS.Bob);
  await bob.click('button:has-text("Unlock")');
  await bob.click('.contact-chip:has-text("Alice")');
  await expectBubble(bob, "hello bob");
  await waitLive(bob);
  ok("lock → wrong passphrase refused → right passphrase reopens with history");

  // Backup: Alice exports her vault; a fresh browser restores it and is Alice.
  const [download] = await Promise.all([alice.waitForEvent("download"), alice.click("[data-export]")]);
  const backupName = download.suggestedFilename();
  // the download lives with Alice's context; keep a copy that outlives it
  const backupPath = join(await mkdtemp(join(tmpdir(), "estoc-e2e-")), backupName);
  await copyFile(await download.path(), backupPath);
  if (!backupName.endsWith(".estoc.sqlite")) {
    fail(`backup is named ${backupName}, expected *.estoc.sqlite`);
  }
  ok(`Alice exported ${backupName}`);

  // Merge first, while Alice is still up: her own backup has nothing new.
  await alice.setInputFiles(".file-btn input[type=file]", backupPath);
  await alice.waitForSelector("[data-import-note]:has-text('nothing new in that backup')", { timeout: 30000 });
  await expectBubble(alice, "hello bob");
  await waitLive(alice);
  ok("importing her own backup merges nothing and leaves the vault as it was");

  // One receiver at a time: the original Alice goes away before the restore comes up.
  await aliceCtx.close();
  const alice2Ctx = await browser.newContext();
  const alice2 = await alice2Ctx.newPage();
  watch(alice2, "alice2");
  await alice2.goto(APP_URL);
  await alice2.click('button:has-text("Restore a backup")');
  await alice2.setInputFiles("input[type=file]", backupPath);
  await alice2.fill('input[placeholder="the backup\'s passphrase"]', "wrong-one");
  await alice2.click('button.btn:has-text("Restore")');
  await alice2.waitForSelector("text=does not open this backup", { timeout: 30000 });
  await alice2.setInputFiles("input[type=file]", backupPath);
  await alice2.fill('input[placeholder="the backup\'s passphrase"]', PASS.Alice);
  await alice2.click('button.btn:has-text("Restore")');
  await alice2.waitForSelector("[data-restore-notice]", { timeout: 45000 });
  await expectBubble(alice2, "hello bob");
  await expectBubble(alice2, "hi alice");
  if (!(await alice2.isDisabled('input[placeholder="Write to Bob"]'))) {
    fail("sending should wait for the restore to be explained");
  }
  ok("a fresh browser restored Alice from the file: full history, sending closed until the restore is explained");
  await alice2.click("[data-restore-understood]");
  await alice2.waitForSelector("[data-restore-notice]", { state: "detached", timeout: 15000 });
  await waitLive(alice2);
  await send(alice2, "Bob", "back from a backup");
  await expectBubble(bob, "back from a backup", 45000);
  await send(bob, "Alice", "welcome back, alice");
  await expectBubble(alice2, "welcome back", 45000);
  ok("restored Alice writes and receives over the channels the backup held");

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
    await expectBubble(alice2, "hello bob");
    await alice2.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
    await alice2Ctx.setOffline(true);
    // written with no network: in the vault at once, and shown as not handed over
    await send(alice2, "Bob", "written offline, sent later");
    const unsent = '.bubble:has-text("written offline") [data-delivery]:not(.submitted):not(.acknowledged)';
    await alice2.waitForSelector(unsent, { timeout: 30000 });
    ok("offline: a message written with no network is in the thread, not handed over");
    await alice2.reload();
    await expectBubble(alice2, "hello bob");
    await alice2.waitForSelector(unsent, { timeout: 30000 });
    ok("offline: the app shell and history open with no network, the unsent message included");
    await alice2Ctx.setOffline(false);
    // Opening a vault sends nothing, so the reload left the message to a
    // hand: sent again where the thread offers it.
    await waitLive(alice2);
    await alice2.click('.bubble:has-text("written offline") [data-retry]', { timeout: 30000 });
    await expectBubble(bob, "written offline, sent later", 45000);
    await alice2.waitForSelector('.bubble:has-text("written offline") [data-delivery].submitted', { timeout: 30000 });
    ok("back online: sent again by hand, it reached Bob");
  } else {
    console.log("· no service worker (dev server?) — offline check skipped");
  }

  await alice2.screenshot({ path: "scripts/e2e-alice.png", fullPage: true });
  await bob.screenshot({ path: "scripts/e2e-bob.png", fullPage: true });

  if (process.exitCode !== 1) {
    console.log("\nall green");
  }
} catch (err) {
  for (const [name, page] of Object.entries(pages)) {
    if (!page.isClosed()) await dump(page, name);
  }
  throw err;
} finally {
  await browser.close();
}
