<script setup lang="ts">
import { ref, watch } from "vue";
import { missingBytes, verifyShare, type VerifiedShare } from "@estoc/agent-core";
import { isPost, readPost, renderPost, validatePost } from "@estoc/post";

import type { Entry } from "../core/entries.js";
import { fetchPackage, heldBlock } from "../core/store.js";
import type { Contact } from "../core/types.js";
import Bubble from "./Bubble.vue";

/**
 * object-share/1.0: an object handed over whole — its root and every
 * block of the tree, inline, and a card when someone stands behind it.
 * The renderer re-runs the check the agent ran (blocks reaching the
 * root, the tree a well-formed object, the card if any under its own
 * did:key and about this root) and projects what verified: a post/1.0
 * object as its title and body, any other format as its files, signed
 * by whom or by nobody. A share that does not verify is shown as exactly
 * that. A share whose leaves are not all here — the minimal share, or one
 * still filling in — is a partial object: what it is, its files and
 * their sizes are all known; what is missing is said, not hidden. Blocks
 * are looked up in the vault's `blobs/` too, so leaves that arrived by
 * another road show. A share that names a package — the bytes as one
 * encrypted file at a URL — offers to fetch it; fetched, checked and
 * opened, the object fills in and is shown again.
 *
 * The body is someone else's text rendered to HTML by our own Markdown
 * renderer (raw HTML stripped), and still goes into a sandboxed frame:
 * no scripts, no origin, images as data URIs from the verified tree.
 */
const props = defineProps<{ entry: Entry; contact: Contact | null }>();

/** What is still on the way: files and bytes, or null when the object is whole. */
interface Awaiting {
  files: number;
  bytes: number;
  /** the package's size, when the share names one to fetch */
  packaged: number | null;
  /** when the package's store said it would let go of the bytes, when the share names one */
  until: string | null;
  /** why the named package cannot be fetched, when the share names one this app cannot use */
  unusable: string | null;
}

/** The fetch of a package, as it goes. */
const fetching = ref<{ state: "idle" } | { state: "busy" } | { state: "failed"; reason: string }>({ state: "idle" });

type View =
  | { state: "checking" }
  | { state: "bad"; reason: string }
  | {
      state: "post";
      did: string | null;
      root: string;
      title: string;
      summary: string;
      html: string | null;
      files: number;
      awaiting: Awaiting | null;
    }
  | {
      state: "files";
      did: string | null;
      root: string;
      files: { path: string; size: number; here: boolean }[];
      awaiting: Awaiting | null;
    };

const view = ref<View>({ state: "checking" });

const MEDIA: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function dataUri(path: string, bytes: Uint8Array): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const type = MEDIA[ext] ?? "application/octet-stream";
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

function page(bodyHtml: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:.25rem .5rem;font:15px/1.5 system-ui,sans-serif;color:#1d2528;overflow-wrap:anywhere}
    img{max-width:100%;height:auto}pre{overflow:auto}a{color:inherit}
  </style>${bodyHtml}`;
}

/** Which reading of the record is current: a record replaced while a check is in flight makes that check stale. */
let reading = 0;

/**
 * One reading of a record: the view it makes, unless a newer reading
 * began meanwhile — then this one is dropped and the newer stands. The
 * erase is asked before the blocks (vault-events.md §8.2): they may live
 * on for another record naming them. A fetch's outcome belongs to the
 * reading it was begun under: a new reading lets a finished one go
 * (its error was about a record that is no longer shown), while a fetch
 * still running keeps its busy state and clears it itself when it ends
 * overtaken (`fetchBytes`), so one fetch runs at a time.
 */
async function read(record: Entry["record"]): Promise<void> {
  const run = ++reading;
  if (fetching.value.state !== "busy") {
    fetching.value = { state: "idle" };
  }
  const msg = record.msg;
  if (msg === null) {
    // the body was erased or is missing: the record stands, its object does not
    view.value = { state: "bad", reason: "the message body is not in this vault any more" };
    return;
  }
  const root = (msg.body as { root?: unknown }).root;
  if (typeof root === "string" && record.erased.includes(root)) {
    view.value = { state: "bad", reason: "the object was erased from this vault" };
    return;
  }
  let share: VerifiedShare;
  try {
    share = await verifyShare(msg, heldBlock);
  } catch (err) {
    if (run === reading) {
      view.value = { state: "bad", reason: err instanceof Error ? err.message : String(err) };
    }
    return;
  }
  if (run === reading) {
    show(share);
  }
}

/**
 * The record as it stands, read again whenever it changes under this
 * component: a snapshot after a merge, a restore or a change of mediator
 * replaces every entry in place (the thread keys by mid, so nothing
 * remounts), and what it brought — the body or the object erased, a
 * partial share made whole — must show. The view shown stays until the
 * new reading is in.
 */
watch(
  () => props.entry.record,
  (record) => {
    void read(record);
  },
  { immediate: true }
);

/** "available until <date>" or "may be gone since <date>": the store's word, not a promise. */
function untilWords(iso: string): string {
  const when = new Date(iso);
  const date = Number.isNaN(when.getTime()) ? iso : when.toLocaleDateString();
  return when.getTime() < Date.now() ? `may be gone since ${date}` : `available until ${date}`;
}

/**
 * Fetch the package the share names, and show the object as it is after.
 * The blocks land in `blobs/` whatever happens to the record meanwhile —
 * they are by CID, any record naming them reads them — so a fetch
 * overtaken by a newer record does not drop what it brought: it reads
 * the record as it stands now, since blocks landing change no record and
 * nothing else would look again. Only the reading a fetch was begun
 * under shows its outcome; overtaken, it clears its own busy state and
 * says nothing — and an outcome it did show is let go by the next
 * reading (`read`).
 */
async function fetchBytes(): Promise<void> {
  const run = reading;
  fetching.value = { state: "busy" };
  try {
    const share = await fetchPackage(props.entry.record);
    fetching.value = { state: "idle" };
    if (run === reading) {
      show(share);
    } else {
      await read(props.entry.record);
    }
  } catch (err) {
    if (run === reading) {
      fetching.value = { state: "failed", reason: err instanceof Error ? err.message : String(err) };
    } else {
      fetching.value = { state: "idle" };
      await read(props.entry.record);
    }
  }
}

function show(share: VerifiedShare): void {
  const { root, object, tree } = share;
  const did = share.card?.did ?? null;
  const files = object.tree;
  const awaiting: Awaiting | null = share.complete
    ? null
    : {
        files: tree.partial.size,
        bytes: missingBytes(tree),
        packaged: share.package?.byteCount ?? null,
        until: share.package?.availableUntil ?? null,
        unusable: share.packageProblem,
      };
  if (!isPost(object.meta) || validatePost(object.meta).length > 0) {
    // every file the tree names, sized by the skeleton when its bytes are not here
    const listing = [...tree.files.keys()]
      .filter((path) => path === "index.json" || path.startsWith("files/"))
      .map((path) => {
        const bytes = files[path];
        const size = bytes?.length ?? (tree.partial.get(path) ?? []).reduce((n, cid) => n + (tree.missing.get(cid) ?? 0), 0);
        return { path, size, here: bytes !== undefined };
      })
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    view.value = { state: "files", did, root, files: listing, awaiting };
    return;
  }
  const meta = readPost(object.meta);
  if ("path" in meta.content && files[meta.content.path] === undefined) {
    // the body itself is on the way: the post's name, its size, no page yet
    view.value = {
      state: "post",
      did,
      root,
      title: meta.title ?? "",
      summary: meta.summary ?? "",
      html: null,
      files: tree.files.size,
      awaiting,
    };
    return;
  }
  const post = renderPost(object, { assetBase: "estoc-object" });
  // in-tree references came out as estoc-object/<path>; the frame has
  // no origin to fetch from, so each asset that is here becomes the
  // verified bytes inline
  let html = post.bodyHtml;
  for (const path of post.assets) {
    const bytes = files[path];
    if (bytes === undefined) continue;
    html = html.replaceAll(`"estoc-object/${path}"`, `"${dataUri(path, bytes)}"`);
  }
  view.value = {
    state: "post",
    did,
    root,
    title: post.title ?? "",
    summary: post.summary ?? "",
    html: page(html),
    files: Object.keys(files).length,
    awaiting,
  };
}

const shortDid = (did: string) => `${did.slice(0, 16)}…${did.slice(-6)}`;
</script>

<template>
  <Bubble :entry="entry">
    <div class="object-share">
      <p v-if="view.state === 'checking'" class="object-meta">checking the object…</p>
      <template v-else-if="view.state === 'bad'">
        <p class="object-meta object-bad">an object that does not verify: {{ view.reason }}</p>
      </template>
      <template v-else>
        <template v-if="view.state === 'post'">
          <h3 v-if="view.title" class="object-title">{{ view.title }}</h3>
          <p v-if="view.summary" class="object-summary">{{ view.summary }}</p>
          <iframe v-if="view.html !== null" class="object-body" sandbox="" :srcdoc="view.html" :title="view.title || 'post'"></iframe>
        </template>
        <ul v-else class="object-files">
          <li v-for="f in view.files" :key="f.path" :class="{ 'object-away': !f.here }">
            <code>{{ f.path }}</code> <span>{{ f.size }} B</span>
          </li>
        </ul>
        <p v-if="view.awaiting !== null" class="object-meta object-awaiting">
          {{ view.awaiting.files }} {{ view.awaiting.files === 1 ? "file" : "files" }} still on the way ({{ view.awaiting.bytes }} B)
          <button
            v-if="view.awaiting.packaged !== null"
            type="button"
            class="object-fetch"
            :disabled="fetching.state === 'busy'"
            @click="fetchBytes"
          >
            {{ fetching.state === "busy" ? "fetching…" : `fetch (${view.awaiting.packaged} B)` }}
          </button>
          <span v-if="view.awaiting.until !== null" class="object-until" :title="view.awaiting.until">
            {{ untilWords(view.awaiting.until) }}
          </span>
        </p>
        <p v-if="view.awaiting?.unusable" class="object-meta object-bad">bytes were offered in a way this app cannot fetch: {{ view.awaiting.unusable }}</p>
        <p v-if="fetching.state === 'failed'" class="object-meta object-bad">could not fetch the package: {{ fetching.reason }}</p>
        <p v-if="view.did !== null" class="object-meta" :title="`${view.did}\n${view.root}`">
          signed by <code>{{ shortDid(view.did) }}</code>
        </p>
        <p v-else class="object-meta" :title="view.root">not signed</p>
      </template>
    </div>
  </Bubble>
</template>

<style scoped>
.object-share {
  min-width: 14rem;
  max-width: 100%;
}
.object-title {
  margin: 0 0 0.25rem;
  font-size: 1.05rem;
}
.object-summary {
  margin: 0 0 0.5rem;
  opacity: 0.8;
}
.object-body {
  display: block;
  width: 100%;
  min-width: 18rem;
  height: 20rem;
  border: 0;
  border-radius: 0.5rem;
  background: #fff;
}
.object-files {
  margin: 0;
  padding-left: 1.2rem;
}
.object-files span {
  opacity: 0.6;
  font-size: 0.85em;
}
.object-meta {
  margin: 0.4rem 0 0;
  font-size: 0.8em;
  opacity: 0.7;
}
.object-bad {
  opacity: 1;
  color: #a33;
}
.object-away {
  opacity: 0.55;
}
.object-until {
  margin-left: 0.5em;
  opacity: 0.7;
}
.object-awaiting {
  font-style: italic;
}
.object-fetch {
  margin-left: 0.5rem;
  font: inherit;
  font-style: normal;
  padding: 0.1rem 0.5rem;
  border: 1px solid currentColor;
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.object-fetch:disabled {
  cursor: default;
  opacity: 0.6;
}
</style>
