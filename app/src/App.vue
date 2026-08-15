<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { state } from "./core/store.js";
import ChatPane from "./ui/ChatPane.vue";
import Onboarding from "./ui/Onboarding.vue";
import Rail from "./ui/Rail.vue";
import Unlock from "./ui/Unlock.vue";

const identity = computed(() => state.identity);

const selectedContactDid = ref<string | null>(null);

// The first contact (added by hand or auto-created by an incoming message)
// becomes the open conversation if none is.
watch(
  () => identity.value?.contacts.length ?? 0,
  () => {
    if (
      selectedContactDid.value === null ||
      !identity.value?.contacts.some((c) => c.did === selectedContactDid.value)
    ) {
      selectedContactDid.value = identity.value?.contacts[0]?.did ?? null;
    }
  },
  { immediate: true }
);
</script>

<template>
  <div v-if="state.phase === 'booting'" class="hollow" style="height: 100%"></div>

  <div v-else-if="state.phase === 'elsewhere'" class="hollow" style="height: 100%">
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Open in another tab</h1>
      <p>
        Your vault is in use by another tab or window of this browser. One
        agent at a time keeps the message log honest — close the other one
        and this tab takes over on its own.
      </p>
    </div>
  </div>

  <Onboarding v-else-if="state.phase === 'onboarding'" />

  <Unlock v-else-if="state.phase === 'locked'" />

  <div v-else class="frame">
    <Rail />
    <ChatPane
      v-if="identity"
      :identity="identity"
      :selected-contact-did="selectedContactDid"
      @select-contact="(did) => (selectedContactDid = did)"
    />
  </div>

  <div v-if="state.applyUpdate" class="update-chip">
    <span>A new version of Estoc is ready.</span>
    <button class="btn" @click="state.applyUpdate?.()">Reload</button>
  </div>
</template>
