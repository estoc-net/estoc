<script setup lang="ts">
import type { Entry } from "../core/entries.js";
import { timeOf } from "../ui/util.js";

/**
 * The frame every renderer sits in: sent to the right, received to the
 * left, or a system aside in the middle; the time underneath. Renderers
 * put their reading of the message in the slot.
 */
defineProps<{
  entry: Entry;
  /** a protocol aside — centered, quieter than chat */
  system?: boolean;
}>();
</script>

<template>
  <div class="bubble" :class="[entry.direction, { system }]">
    <div><slot /></div>
    <div class="meta">
      <span>{{ timeOf(entry.time) }}</span>
      <slot name="meta" />
    </div>
  </div>
</template>
