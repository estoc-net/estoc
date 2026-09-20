<script setup lang="ts">
import { computed } from "vue";

import type { MessageRecord } from "../core/types.js";
import Bubble from "./Bubble.vue";

/** basicmessage/2.0: the text in `body.content`, and nothing else. */
const props = defineProps<{ message: MessageRecord }>();

const content = computed(() => (props.message.body.state === "available" ? String(props.message.body.body["content"] ?? "") : ""));
</script>

<template>
  <Bubble :message="message">{{ content }}</Bubble>
</template>
