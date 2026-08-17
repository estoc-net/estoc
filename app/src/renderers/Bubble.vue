<script setup lang="ts">
import { computed, ref } from "vue";

import type { Entry } from "../core/entries.js";
import { retry, state } from "../core/store.js";
import { timeOf } from "../ui/util.js";

/**
 * The frame every renderer sits in: sent to the right, received to the
 * left, or a system aside in the middle; the time underneath. Renderers
 * put their reading of the message in the slot.
 *
 * A sent entry also shows what became of it — the delivery log's word,
 * not the renderer's: nothing once it went, "sending" while no try has
 * ended, and otherwise why it did not go, with a retry. The record is a
 * fact either way; delivery is a separate one (see agent-core's
 * `vault/deliveries.ts`).
 */
const props = defineProps<{
  entry: Entry;
  /** a protocol aside — centered, quieter than chat */
  system?: boolean;
}>();

const delivery = computed(() => {
  if (props.entry.direction !== "sent") {
    return null;
  }
  return state.identity?.deliveries[props.entry.mid] ?? { status: "pending" as const };
});

const retrying = ref(false);
async function tryAgain() {
  if (retrying.value) return;
  retrying.value = true;
  try {
    await retry(props.entry.mid);
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <div class="bubble" :class="[entry.direction, { system }]">
    <div><slot /></div>
    <div class="meta">
      <span>{{ timeOf(entry.time) }}</span>
      <slot name="meta" />
      <template v-if="delivery && delivery.status !== 'sent'">
        <span v-if="delivery.status === 'pending'" class="delivery pending">sending…</span>
        <span
          v-else
          class="delivery"
          :class="delivery.status"
          :title="'error' in delivery ? delivery.error : undefined"
        >
          {{ delivery.status === "held" ? "not sent — from a backup" : "not sent" }}
          <button type="button" class="link-quiet" :disabled="retrying" @click="tryAgain">
            {{ retrying ? "retrying…" : "retry" }}
          </button>
        </span>
      </template>
    </div>
  </div>
</template>
