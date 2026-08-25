<script setup lang="ts">
import { onMounted, ref } from "vue";
import { verifyShare, type VerifiedShare } from "@estoc/agent-core";

import type { Entry } from "../core/entries.js";
import { POST_FORMAT, renderPost } from "../core/post.js";
import type { Contact } from "../core/types.js";
import Bubble from "./Bubble.vue";

/**
 * object-share/1.0: an object handed over whole — a card and every block
 * of the tree, inline. The renderer re-runs the check the agent ran (card
 * under its own did:key, blocks reaching the root, the tree a well-formed
 * object) and projects what verified: a post/1.0 object as its title and
 * body, any other format as its files. A share that does not verify is
 * shown as exactly that.
 *
 * The body is someone else's text rendered to HTML by our own djot
 * renderer (raw HTML stripped), and still goes into a sandboxed frame:
 * no scripts, no origin, images as data URIs from the verified tree.
 */
const props = defineProps<{ entry: Entry; contact: Contact | null }>();

type View =
  | { state: "checking" }
  | { state: "bad"; reason: string }
  | { state: "post"; did: string; root: string; title: string; summary: string; html: string; files: number }
  | { state: "files"; did: string; root: string; files: { path: string; size: number }[] };

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

onMounted(async () => {
  let share: VerifiedShare;
  try {
    share = await verifyShare(props.entry.record.msg);
  } catch (err) {
    view.value = { state: "bad", reason: err instanceof Error ? err.message : String(err) };
    return;
  }
  const { did, root } = share.card;
  const { object } = share;
  const files = object.tree;
  if (object.meta.format !== POST_FORMAT) {
    const listing = Object.entries(files)
      .map(([path, bytes]) => ({ path, size: bytes.length }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    view.value = { state: "files", did, root, files: listing };
    return;
  }
  const post = renderPost(object, { assetBase: "estoc-object" });
  // in-tree references came out as estoc-object/files/…; the frame has
  // no origin to fetch from, so each becomes the verified bytes inline
  const html = post.bodyHtml.replace(/(src|href)="estoc-object\/(files\/[^"]*)"/g, (whole, attr: string, path: string) => {
    const bytes = files[path];
    return bytes === undefined ? whole : `${attr}="${dataUri(path, bytes)}"`;
  });
  view.value = {
    state: "post",
    did,
    root,
    title: post.title ?? "",
    summary: post.summary ?? "",
    html: page(html),
    files: Object.keys(files).length,
  };
});

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
          <iframe class="object-body" sandbox="" :srcdoc="view.html" :title="view.title || 'post'"></iframe>
        </template>
        <ul v-else class="object-files">
          <li v-for="f in view.files" :key="f.path"><code>{{ f.path }}</code> <span>{{ f.size }} B</span></li>
        </ul>
        <p class="object-meta" :title="`${view.did}\n${view.root}`">
          signed by <code>{{ shortDid(view.did) }}</code>
        </p>
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
</style>
