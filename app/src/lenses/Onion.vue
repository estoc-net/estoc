<script setup lang="ts">
import { computed } from "vue";

import type { TraceEvent } from "@estoc/vault";

import type { Entry } from "../core/entries.js";
import LayerOnion from "./LayerOnion.vue";
import { foldOnion } from "./onion.js";

/**
 * The onion lens: the envelopes this message crossed, outermost first, as
 * the vault's trace observed them. Given the entry and its trace events,
 * and nothing else (see registry.ts).
 */
const props = defineProps<{ entry: Entry; events: TraceEvent[] }>();

const onion = computed(() => foldOnion(props.events, props.entry.mid, props.entry.record.msg));
</script>

<template>
  <div class="onion" :data-onion-layers="onion.layers.length">
    <template v-if="onion.layers.length">
      <p class="hop-note">
        <template v-if="onion.direction === 'sent'">What left this device, and what was inside it.</template>
        <template v-else>What reached this device, and what each layer gave up.</template>
        <template v-if="onion.attempts > 1"> Sealed {{ onion.attempts }} times (every delivery attempt seals afresh); the last is shown.</template>
      </p>
      <LayerOnion :layers="onion.layers" />
      <details v-if="onion.mediation.length" class="onion-mediation">
        <summary>the mediator's part on this frame ({{ onion.mediation.length }})</summary>
        <pre>{{ JSON.stringify(onion.mediation.map((e) => e.msg ?? e), null, 2) }}</pre>
      </details>
    </template>
    <p v-else class="hop-note">
      Nothing observed for this message: the trace keeps a message's envelopes
      for a while (the rail's trace level says how long), and this one's part is
      gone, or it was never observed here (a backup, or a device where the trace
      was off).
    </p>
  </div>
</template>
