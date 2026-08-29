<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { Entry } from "../core/entries.js";
import { retry, state, traceOf } from "../core/store.js";
import { lensesFor, type Lens } from "../lenses/index.js";
import type { TraceEvent } from "../lenses/registry.js";
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
 *
 * And the lenses (src/lenses): the other way of looking at a record, by
 * what the vault's trace observed of it rather than by what it says. The
 * bubble is their host: it offers the entry point of every lens that has
 * something to say, and when one is opened fetches the record's trace
 * over the daemon and hands it in.
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

const lenses = computed(() => lensesFor(props.entry, { traceLevel: state.traceLevel }));
const open = ref<Lens | null>(null);
const events = ref<TraceEvent[]>([]);
const peeling = ref(false);

async function toggle(lens: Lens) {
  if (open.value?.id === lens.id) {
    open.value = null;
    events.value = [];
    return;
  }
  peeling.value = true;
  try {
    const fetched = await traceOf(props.entry.mid);
    // the trace may have been turned off while we asked: then there is nothing to open
    if (lenses.value.some((l) => l.id === lens.id)) {
      events.value = fetched;
      open.value = lens;
    }
  } finally {
    peeling.value = false;
  }
}

// a lens that is no longer offered (the trace turned off) closes with its events
watch(lenses, (offered) => {
  if (open.value !== null && !offered.some((l) => l.id === open.value?.id)) {
    open.value = null;
    events.value = [];
  }
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
      <button
        v-for="lens in lenses"
        :key="lens.id"
        type="button"
        class="link-quiet lens-entry"
        :class="{ active: open?.id === lens.id }"
        :data-lens="lens.id"
        :disabled="peeling"
        @click="toggle(lens)"
      >
        {{ open?.id === lens.id ? "close" : lens.label }}
      </button>
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
    <div v-if="open" class="lens" :data-lens-open="open.id">
      <component :is="open.component" :entry="entry" :events="events" />
    </div>
  </div>
</template>
