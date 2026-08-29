<script setup lang="ts">
import { computed } from "vue";

import type { OnionLayer } from "./onion.js";

/** One layer, and inside it the rest: the onion draws itself recursively. */
const props = defineProps<{ layers: OnionLayer[] }>();

const first = computed(() => props.layers[0]);
const rest = computed(() => props.layers.slice(1));

const KIND_LABELS: Record<OnionLayer["kind"], string> = {
  wire: "wire",
  forward: "routing · forward",
  anoncrypt: "anoncrypt · sealed, sender hidden",
  authcrypt: "authcrypt · sealed + authenticated",
  signed: "signed · not sealed",
  plain: "plaintext envelope",
  unknown: "unread",
  plaintext: "plaintext",
};

function pretty(raw: unknown): string {
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}
</script>

<template>
  <section v-if="first" class="layer" :class="first.kind">
    <div class="layer-head">
      <span class="layer-title">{{ first.title }}</span>
      <span class="layer-kind" :class="first.kind">{{ KIND_LABELS[first.kind] }}</span>
    </div>
    <p class="layer-visible">visible to: {{ first.visibleTo }}</p>
    <p class="layer-note">{{ first.note }}</p>
    <details>
      <summary>raw</summary>
      <pre>{{ pretty(first.raw) }}</pre>
    </details>
    <LayerOnion v-if="rest.length" :layers="rest" />
  </section>
</template>
