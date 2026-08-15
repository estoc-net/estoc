<script setup lang="ts">
import { computed } from "vue";

import type { ChatMessage, Contact } from "../core/types.js";
import LayerOnion from "./LayerOnion.vue";

const props = defineProps<{
  message: ChatMessage | null;
  contacts: Contact[];
  profileName: string;
}>();

const emit = defineEmits<{ close: [] }>();

const contactLabel = computed(() => {
  if (props.message === null) {
    return "them";
  }
  return (
    props.contacts.find((c) => c.did === props.message?.contactDid)?.label ??
    "them"
  );
});

/** The onion renders outermost layer first; sent layers are captured inside-out. */
const ordered = computed(() => {
  if (props.message === null) {
    return [];
  }
  return props.message.direction === "sent"
    ? [...props.message.layers].reverse()
    : props.message.layers;
});

const hops = computed(() => {
  if (props.message === null) {
    return null;
  }
  const me = props.profileName;
  const them = contactLabel.value;
  if (props.message.direction === "sent") {
    // No forward layer means the contact's endpoint took the envelope
    // directly (e.g. a did:web contact) — there is no mediator on the path.
    const direct = !props.message.layers.some((layer) => layer.kind === "forward");
    return { from: me, via: direct ? null : `${them}'s mediator`, to: them };
  }
  return { from: them, via: "your mediator", to: me };
});
</script>

<template>
  <aside class="inspector" :class="{ hidden: message === null }">
    <div class="inspector-head">
      <div class="eyebrow" style="display: flex; justify-content: space-between">
        <span>The envelope</span>
        <button class="btn-quiet" @click="emit('close')">close</button>
      </div>
      <h2 v-if="message">
        <template v-if="message.kind === 'profile'">profile: “{{ message.content }}”</template>
        <template v-else>
          “{{ message.content.length > 40 ? message.content.slice(0, 40) + "…" : message.content }}”
        </template>
      </h2>
    </div>

    <div class="inspector-body">
      <template v-if="message && hops">
        <div class="hops">
          <span class="stop">{{ hops.from }}</span>
          <span class="leg"></span>
          <template v-if="hops.via !== null">
            <span class="stop blind">{{ hops.via }}</span>
            <span class="leg"></span>
          </template>
          <span class="stop">{{ hops.to }}</span>
        </div>
        <p class="hop-note">
          <template v-if="hops.via !== null">
            The mediator in the middle stores and forwards this message without
            being able to read it{{ message.direction === "sent" ? " or see who sent it" : "" }}.
          </template>
          <template v-else>
            This contact's DID names its own HTTPS endpoint, so the envelope
            went straight there — no mediator, no forward layer.
          </template>
          Outermost layer first — peel inward.
        </p>
        <LayerOnion :layers="ordered" />
      </template>

      <template v-else>
        <p class="hop-note">
          Select a message to peel it. Every message here is an onion: the
          plaintext is sealed to its recipient, wrapped in a forward request,
          and sealed again — anonymously — to the mediator that queues it. Each
          hop can open exactly one layer, and this panel shows what that
          leaves them knowing.
        </p>
      </template>
    </div>
  </aside>
</template>
