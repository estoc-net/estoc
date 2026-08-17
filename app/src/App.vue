<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { forgetIdentity, state } from "./core/store.js";
import ChatPane from "./ui/ChatPane.vue";
import Onboarding from "./ui/Onboarding.vue";
import Rail from "./ui/Rail.vue";
import Unlock from "./ui/Unlock.vue";

const identity = computed(() => state.identity);

function forget() {
  if (confirm("Delete this vault from this browser? There is no way back except a backup zip.")) {
    void forgetIdentity();
  }
}

// Conversations are selected by the contact's cid — their DID is a history
// that can move under a thread; the cid does not.
const selectedContactCid = ref<string | null>(null);

// The first contact (added by hand or auto-created by an incoming message)
// becomes the open conversation if none is.
watch(
  () => identity.value?.contacts.length ?? 0,
  () => {
    if (
      selectedContactCid.value === null ||
      !identity.value?.contacts.some((c) => c.cid === selectedContactCid.value)
    ) {
      selectedContactCid.value = identity.value?.contacts[0]?.cid ?? null;
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

  <div v-else-if="state.phase === 'unreadable'" class="hollow" style="height: 100%">
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Vault not readable</h1>
      <p>
        There is a vault in this browser, but this version of the app cannot
        open it{{ state.status.state === "error" ? `: ${state.status.detail}` : "." }}
      </p>
      <p class="fine">
        Nothing has been changed. If it came from a newer version, update the app.
        If it is from an older, pre-release format, there is no upgrade path:
        <button class="link" @click="forget">start over</button> deletes it and
        begins a new identity.
      </p>
    </div>
  </div>

  <Unlock v-else-if="state.phase === 'locked'" />

  <div v-else class="frame">
    <Rail />
    <ChatPane
      v-if="identity"
      :identity="identity"
      :selected-contact-cid="selectedContactCid"
      @select-contact="(cid) => (selectedContactCid = cid)"
    />
  </div>

  <div v-if="state.applyUpdate" class="update-chip">
    <span>A new version of Estoc is ready.</span>
    <button class="btn" @click="state.applyUpdate?.()">Reload</button>
  </div>
</template>
