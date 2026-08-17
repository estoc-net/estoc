<script setup lang="ts">
import { computed } from "vue";

import type { Entry } from "../core/entries.js";
import type { Contact } from "../core/types.js";
import Bubble from "./Bubble.vue";

/**
 * A message of a type this app has no renderer for. It is still a fact in
 * the log, and still something the other side said — so the thread shows
 * that it arrived, names the protocol, and lets you look at the body
 * rather than pretending nothing happened.
 */
const props = defineProps<{ entry: Entry; contact: Contact | null }>();

// "https://didcomm.org/poll/1.0/question" → "poll/1.0 · question"
const label = computed(() => {
  const parts = props.entry.type.replace(/^https?:\/\/[^/]+\//, "").split("/");
  const name = parts.pop() ?? props.entry.type;
  return parts.length === 0 ? name : `${parts.join("/")} · ${name}`;
});

const body = computed(() => JSON.stringify(props.entry.record.msg.body ?? {}, null, 2));
</script>

<template>
  <Bubble :entry="entry" system>
    <details class="generic-message">
      <summary>
        {{ entry.direction === "sent" ? "you sent" : "received" }} a
        <code>{{ label }}</code> message
      </summary>
      <pre>{{ body }}</pre>
    </details>
  </Bubble>
</template>
