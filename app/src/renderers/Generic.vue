<script setup lang="ts">
import { computed } from "vue";

import type { MessageRecord } from "../core/types.js";
import Bubble from "./Bubble.vue";
import { typeOf } from "./registry.js";

/**
 * A message of a type this app has no renderer for. It is still a fact in
 * the vault, and still something the other side said — so the thread shows
 * that it arrived, names the protocol, and lets you look at the body
 * rather than pretending nothing happened.
 */
const props = defineProps<{ message: MessageRecord }>();

// "https://didcomm.org/poll/1.0/question" → "poll/1.0 · question"
const label = computed(() => {
  const type = typeOf(props.message);
  if (type === "") {
    return "message whose type is not agreed on";
  }
  const parts = type.replace(/^https?:\/\/[^/]+\//, "").split("/");
  const name = parts.pop() ?? type;
  return parts.length === 0 ? name : `${parts.join("/")} · ${name}`;
});

const body = computed(() => (props.message.body.state === "available" ? JSON.stringify(props.message.body.body, null, 2) : null));
</script>

<template>
  <Bubble :message="message" system>
    <details class="generic-message">
      <summary>
        {{ message.direction === "out" ? "you sent" : "received" }} a
        <code>{{ label }}</code> message
      </summary>
      <pre v-if="body !== null">{{ body }}</pre>
    </details>
  </Bubble>
</template>
