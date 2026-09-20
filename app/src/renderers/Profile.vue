<script setup lang="ts">
import { computed } from "vue";
import { announcedName } from "@estoc/agent-core";

import type { MessageRecord } from "../core/types.js";
import Bubble from "./Bubble.vue";

/**
 * user-profile/1.0 profile: an introduction. The name in it is what the
 * sender calls themself — a claim, and the line says so by quoting it.
 */
const props = defineProps<{ message: MessageRecord }>();

const line = computed(() => {
  const name = props.message.body.state === "available" ? (announcedName(props.message.body) ?? "") : "";
  return props.message.direction === "out" ? `you introduced yourself as “${name}”` : `introduced themself as “${name}”`;
});
</script>

<template>
  <Bubble :message="message" system>{{ line }}</Bubble>
</template>
