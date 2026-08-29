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
import { copyFile, cp, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

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
// The mediator Bob moves to, by its dropdown label: production under its
// other DID when the run is already there, production otherwise (so a
// local run needs the internet for this one step). E2E_OTHER_MEDIATOR
// names another entry.
const OTHER_LABEL =
  process.env.E2E_OTHER_MEDIATOR ??
  (MEDIATOR_LABEL === "mediator.estoc.dev" ? "mediator.estoc.dev (did:peer:2)" : "mediator.estoc.dev");

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

async function createIdentity(page, name, invitationUrl = null, startUrl = APP_URL) {
  await page.goto(startUrl);
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

  // The onion lens: what the vault's trace observed of a message, peeled
  // under its bubble. Inbound at Bob: the frame, the mediator's delivery,
  // the message sealed to him, the plaintext. Outbound at Alice: the frame
  // she sent, the forward to the mediator, the message sealed to Bob.
  const bobBubble = bob.locator('.bubble:has-text("hello bob")').first();
  await bobBubble.locator('[data-lens="onion"]').click();
  await bobBubble.locator("[data-onion-layers]").waitFor({ timeout: 10000 });
  const bobLayers = Number(await bobBubble.locator("[data-onion-layers]").getAttribute("data-onion-layers"));
  const bobKinds = await bobBubble.locator(".layer-kind").allInnerTexts();
  if (bobLayers < 3 || !bobKinds.some((k) => k.startsWith("WIRE")) || !bobKinds.some((k) => k.startsWith("AUTHCRYPT")) || !bobKinds.some((k) => k === "PLAINTEXT")) {
    fail(`Bob's onion has ${bobLayers} layers: ${bobKinds.join(" / ")}`);
  }
  ok(`Bob peeled the message he received: ${bobLayers} layers, wire → authcrypt → plaintext`);
  const aliceBubble = alice.locator('.bubble:has-text("hello bob")').first();
  await aliceBubble.locator('[data-lens="onion"]').click();
  await aliceBubble.locator("[data-onion-layers]").waitFor({ timeout: 10000 });
  const aliceKinds = await aliceBubble.locator(".layer-kind").allInnerTexts();
  if (!aliceKinds.some((k) => k.startsWith("ROUTING")) || !aliceKinds.some((k) => k.startsWith("AUTHCRYPT"))) {
    fail(`Alice's onion lacks the forward or the seal: ${aliceKinds.join(" / ")}`);
  }
  ok("Alice peeled the message she sent: the forward to the mediator around the seal to Bob");
  await aliceBubble.locator('[data-lens="onion"]').click(); // close
  // The trace level is a device preference: off, and no bubble offers the lens.
  await alice.selectOption("[data-trace-level]", "off");
  await alice.waitForSelector('[data-lens="onion"]', { state: "detached", timeout: 5000 });
  await alice.selectOption("[data-trace-level]", "normal");
  await alice.waitForSelector('[data-lens="onion"]', { timeout: 5000 });
  ok("trace off hides the lens; back on shows it");

  // An object goes over whole: Alice picks the sea-day example folder — a
  // bare object, so the app asks — first sends it as it is (not signed),
  // then again signed by her anchor; both threads project the post, Bob's
  // after re-verifying tree and card on his side.
  const seaDay = fileURLToPath(new URL("../../../folder-object/examples/sea-day/", import.meta.url));
  await alice.setInputFiles('input[data-share="object"]', seaDay);
  await alice.waitForSelector('.share-name:has-text("post/1.0, not signed")', { timeout: 15000 });
  await alice.click('[data-share-choice="plain"]');
  await alice.waitForSelector('.object-title:has-text("A Day at the Sea")', { timeout: 15000 });
  await alice.waitForSelector('.object-meta:has-text("not signed")', { timeout: 15000 });
  ok("Alice picked an object folder and sent it as it is: in her thread, not signed");
  await bob.waitForSelector('.object-title:has-text("A Day at the Sea")', { timeout: 15000 });
  await bob.waitForSelector('.object-meta:has-text("not signed")', { timeout: 15000 });
  ok("Bob received the object whole and it verifies on his side");
  await alice.setInputFiles('input[data-share="object"]', seaDay);
  await alice.click('[data-share-choice="sign"]');
  await alice.waitForSelector('.object-meta:has-text("signed by")', { timeout: 15000 });
  ok("Alice picked it again and signed it: in her thread, signed by her anchor");
  await bob.waitForSelector('.object-meta:has-text("signed by")', { timeout: 15000 });
  ok("Bob received the signed object and its card verifies on his side");

  // Too big for one message: the same post with a 1.2 MiB file beside it
  // goes as the minimal share — skeleton and index.json, no leaves — and
  // Bob sees what it is and what is still on the way. The leaves he
  // already holds (the body, the picture: same CIDs) count as present.
  const bigDay = await mkdtemp(join(tmpdir(), "estoc-big-day-"));
  await cp(seaDay, bigDay, { recursive: true });
  await writeFile(join(bigDay, "files", "big.bin"), new Uint8Array(1258291));
  await alice.setInputFiles('input[data-share="object"]', bigDay);
  await alice.click('[data-share-choice="plain"]');
  // Alice holds every block herself, so on her side the object is whole
  await alice.waitForFunction(() => document.querySelectorAll(".object-title").length >= 3, null, { timeout: 15000 });
  if ((await alice.$$(".object-awaiting")).length !== 0) {
    fail("Alice's own share should be whole on her side: she holds every block");
  }
  ok("Alice sent the minimal share; her own thread shows the object whole, from her blobs");
  await bob.waitForSelector('.object-awaiting:has-text("1 file still on the way (1258291 B)")', { timeout: 15000 });
  await bob.waitForSelector('.object-until:has-text("available until")', { timeout: 5000 });
  ok("Bob received the skeleton, reads the post, knows exactly which bytes are missing and until when they are promised");

  // Pairwise: each side writes from a DID minted for the other alone. The
  // chat head says which; it is not the public DID on the rail.
  const aliceHeadMyDid = await alice.getAttribute('.head-dids .eyebrow:has-text("you as")', "title");
  if (!aliceHeadMyDid?.includes("did:peer:4") || aliceHeadMyDid.includes(aliceDid)) {
    fail("Alice's DID toward Bob should be a pairwise did:peer:4, not her public one");
  }
  const bobHeadMyDid = await bob.getAttribute('.head-dids .eyebrow:has-text("you as")', "title");
  if (!bobHeadMyDid?.includes("did:peer:4") || bobHeadMyDid.includes(bobDid)) {
    fail("Bob's DID toward Alice should be a pairwise did:peer:4, not his public one");
  }
  ok("both write from pairwise DIDs, not their public ones");

  // Bob pastes Alice's public DID (her business card) as a contact: it is
  // the same Alice — her first message vouched for its DID with the public
  // one — so no twin appears.
  await addContact(bob, "Alice", aliceDid);
  await bob.waitForTimeout(300);
  const aliceChips = await bob.locator('.contact-chip:has-text("Alice")').count();
  if (aliceChips !== 1) {
    fail(`Bob has ${aliceChips} contacts named Alice; pasting her public DID should find the existing one`);
  }
  ok("pasting Alice's public DID finds the contact her pairwise DID created");
  await send(bob, "Alice", "hi alice, got it");
  await expectBubble(alice, "hi alice");
  ok("Alice received Bob's reply live");

  // Invitations: Bob makes a link for one person. Carol, new to Estoc,
  // opens it — onboarding, mediator, then the invitation waiting for her —
  // and accepts under a name of her choosing. Nothing public changes hands:
  // Bob writes to her from the invitation's DID, she to him from one minted
  // for him.
  await bob.click('button:has-text("New invitation link")');
  await bob.waitForSelector("[data-invitation-url]", { timeout: 20000 });
  const inviteUrl = await bob.getAttribute("[data-invitation-url]", "title");
  if (!inviteUrl?.startsWith(APP_URL.replace(/\/$/, "")) || !inviteUrl.includes("_oob=")) {
    fail(`invitation link should be this app's URL carrying _oob; got ${inviteUrl}`);
  }
  const inviteDid = JSON.parse(
    Buffer.from(new URL(inviteUrl).searchParams.get("_oob"), "base64url").toString()
  ).from;
  if (!inviteDid?.startsWith("did:peer:4") || inviteDid === bobDid) {
    fail("the invitation should carry a did:peer:4 minted for it, not Bob's public DID");
  }
  const qrCells = await bob.locator(".invitation .qr svg").count();
  if (qrCells !== 1) {
    fail("the invitation should show as a QR code too");
  }
  ok("Bob issued a single-use invitation link (with a QR) carrying a DID of its own");

  const carolCtx = await browser.newContext();
  const carol = await carolCtx.newPage();
  watch(carol, "Carol");
  const carolDid = await createIdentity(carol, "Carol", null, inviteUrl);
  await carol.waitForSelector("text=You were handed an invitation", { timeout: 10000 });
  await carol.waitForSelector('text=“Write to Bob”');
  ok("Carol opened the link before she had an identity; it waited through onboarding");
  await carol.fill('input[placeholder="what you call them, e.g. Alice"]', "Bob (invited)");
  await carol.click('button:has-text("Accept invitation")');
  await carol.waitForSelector('.contact-chip.active:has-text("Bob (invited)")', { timeout: 15000 });
  await bob.waitForSelector('.contact-chip:has-text("Carol")', { timeout: 20000 });
  ok("Bob saw Carol arrive the moment she accepted (her introduction, pthid = the invitation)");
  await bob.waitForFunction(() => !document.body.innerText.includes("open link"), { timeout: 10000 });
  await bob.waitForSelector("[data-invitation-taken]:has-text('Carol')", { timeout: 10000 });
  await bob.click('.contact-chip:has-text("Carol")');
  const bobHeadToCarol = await bob.getAttribute('.head-dids .eyebrow:has-text("you as")', "title");
  if (!bobHeadToCarol?.includes(inviteDid)) {
    fail("Bob's DID toward Carol should be the invitation's DID");
  }
  const carolHeadToBob = await carol.getAttribute('.head-dids .eyebrow:has-text("you as")', "title");
  if (!carolHeadToBob?.includes("did:peer:4") || carolHeadToBob.includes(carolDid)) {
    fail("Carol's DID toward Bob should be one minted for him, not her public one");
  }
  ok("the invitation is taken: Bob writes to Carol as its DID, Carol to Bob from a pairwise one");
  await send(bob, "Carol", "welcome carol");
  await expectBubble(carol, "welcome carol");
  await send(carol, "Bob (invited)", "thanks bob");
  await expectBubble(bob, "thanks bob");
  ok("Bob and Carol talk both ways over the invitation");
  await carolCtx.close();

  // Changing mediator: Bob moves. Every DID of his is minted anew there —
  // the public one on the rail, the ones toward Alice and Carol — and each
  // contact is told from the new DID (from_prior), so Alice follows without
  // Bob writing to her. An open invitation link is withdrawn: it led to the
  // old mediator.
  await bob.click('button:has-text("New invitation link")');
  await bob.waitForSelector("[data-invitation-url]", { timeout: 20000 });
  const bobHeadToAliceBefore = bobHeadMyDid;
  await bob.click("[data-change-mediator]");
  await bob.selectOption(".rail-form select.field", { label: `via ${OTHER_LABEL}` });
  await bob.click('button:has-text("Move to this mediator")');
  await bob.waitForFunction(
    (old) => {
      const did = document.querySelector(".did-chip")?.getAttribute("title");
      return did?.startsWith("did:peer:4") && did !== old && document.body.innerText.includes("live delivery on");
    },
    bobDid,
    { timeout: 40000 }
  );
  const bobDid2 = await bob.getAttribute(".did-chip", "title");
  await bob.waitForSelector(`text=via ${OTHER_LABEL}`);
  ok(`Bob moved to ${OTHER_LABEL}: new public DID, live again`);
  if (await bob.locator("[data-invitation-url]").count() !== 0 || (await bob.innerText("body")).includes("open link")) {
    fail("Bob's open invitation link should have been withdrawn by the move");
  }
  ok("the open invitation link was withdrawn");
  await bob.click('.contact-chip:has-text("Alice")');
  await bob.waitForFunction(
    (before) => {
      const heads = [...document.querySelectorAll(".head-dids .eyebrow")];
      const mine = heads.find((h) => h.textContent?.includes("you as"));
      return mine !== undefined && mine.getAttribute("title") !== before;
    },
    bobHeadToAliceBefore,
    { timeout: 10000 }
  );
  ok("Bob writes to Alice as a fresh DID now");
  await alice.waitForSelector('.rail-log:has-text("Bob moved to a new DID, vouched for by the old one")', { timeout: 30000 });
  ok("Alice was told by from_prior and moved Bob to his new DID — no message from Bob needed");
  await send(alice, "Bob", "still there after the move?");
  await expectBubble(bob, "still there after the move?");
  await send(bob, "Alice", `here, via ${OTHER_LABEL}`);
  await expectBubble(alice, `here, via ${OTHER_LABEL}`);
  ok("Alice and Bob talk across mediators over the new DIDs");
  if (bobDid2 === bobDid) {
    fail("Bob's public DID should have changed with the mediator");
  }

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
    // written with no network: logged at once, marked as not sent
    await send(alice2, "Bob", "written offline, sent later");
    await alice2.waitForSelector('.bubble:has-text("written offline") .delivery:has-text("not sent")', { timeout: 15000 });
    ok("offline: a message written with no network is in the thread, marked not sent");
    await alice2.reload();
    await expectBubble(alice2, "hello bob", 20000);
    await alice2.waitForSelector('.bubble:has-text("written offline") .delivery:has-text("not sent")', { timeout: 15000 });
    ok("offline: the app shell and history open with no network — the unsent message and its mark included");
    await alice2Ctx.setOffline(false);
    // the network is back: the outbox delivers, the mark clears
    await expectBubble(bob, "written offline, sent later", 30000);
    await alice2.waitForFunction(
      () => ![...document.querySelectorAll(".bubble")].some((b) => b.textContent.includes("written offline") && b.querySelector(".delivery") !== null),
      null,
      { timeout: 15000 }
    );
    ok("back online: the outbox delivered it to Bob and the mark cleared");
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
