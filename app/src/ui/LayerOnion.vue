<script setup lang="ts">
import { computed } from "vue";

import type { EnvelopeLayer } from "../core/types.js";

const props = defineProps<{ layers: EnvelopeLayer[] }>();

const first = computed(() => props.layers[0]);
const rest = computed(() => props.layers.slice(1));

const KIND_LABELS: Record<EnvelopeLayer["kind"], string> = {
  plaintext: "plaintext",
  authcrypt: "authcrypt · sealed + authenticated",
  anoncrypt: "anoncrypt · sealed, sender hidden",
  forward: "routing · forward",
};
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
      <pre>{{ first.payload }}</pre>
    </details>
    <LayerOnion v-if="rest.length" :layers="rest" />
  </section>
</template>
