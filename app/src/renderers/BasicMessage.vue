<script setup lang="ts">
import { computed } from "vue";

import type { Entry } from "../core/entries.js";
import type { Contact } from "../core/types.js";
import Bubble from "./Bubble.vue";

/** basicmessage/2.0: the text in `body.content`, and nothing else. */
const props = defineProps<{ entry: Entry; contact: Contact | null }>();

const content = computed(() => {
  const body = props.entry.record.msg.body as { content?: unknown };
  return String(body.content ?? "");
});
</script>

<template>
  <Bubble :entry="entry">{{ content }}</Bubble>
</template>
