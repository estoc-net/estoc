<script setup lang="ts">
import { computed } from "vue";

import type { Entry } from "../core/entries.js";
import type { Contact } from "../core/types.js";
import Bubble from "./Bubble.vue";

/**
 * user-profile/1.0 profile: an introduction. The name in it is what the
 * sender calls themself — a claim, and the line says so by quoting it.
 */
const props = defineProps<{ entry: Entry; contact: Contact | null }>();

const line = computed(() => {
  const body = props.entry.record.msg.body as { profile?: { displayName?: unknown } };
  const name = typeof body.profile?.displayName === "string" ? body.profile.displayName : "";
  return props.entry.direction === "sent"
    ? `you introduced yourself as “${name}”`
    : `introduced themself as “${name}”`;
});
</script>

<template>
  <Bubble :entry="entry" system>{{ line }}</Bubble>
</template>
