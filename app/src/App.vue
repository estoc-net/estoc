<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { pairKey, successorOf } from "./core/conversations.js";
import { discardFolderVault, state } from "./core/store.js";
import ChatPane from "./ui/ChatPane.vue";
import Onboarding from "./ui/Onboarding.vue";
import Rail from "./ui/Rail.vue";
import Unlock from "./ui/Unlock.vue";

function startOver() {
  if (confirm("Delete the old vault from this browser? There is no way back except a backup made by the version that wrote it.")) {
    void discardFolderVault();
  }
}

// A conversation is selected by its key: a contact's ID, or for one not
// named yet the pair it leads to. That pair moves when either side
// rotates, so the conversation last open is remembered by the channels
// it showed, and followed to whichever conversation shows them next.
const selected = ref<string | null>(null);
let lastShown: Set<string> | null = null;

function select(key: string | null) {
  selected.value = key;
  const conversation = state.conversations.find((c) => c.key === key);
  lastShown = conversation === undefined ? null : new Set(conversation.channels.map(({ channel }) => pairKey(channel)));
}

// The first conversation, opened by an invitation either way, becomes the
// open one while nothing has been. One that was open and is gone is
// followed; while nothing says which conversation it became, none is
// open until the person opens one. A key selected ahead of the snapshot
// that brings its conversation is waited for. Following is display
// only: what is being written goes its own way, by channel.
watch(
  () => state.conversations,
  (conversations) => {
    if (conversations.some((c) => c.key === selected.value)) return select(selected.value);
    if (lastShown === null) {
      if (selected.value === null) select(conversations[0]?.key ?? null);
      return;
    }
    selected.value = null;
    const successor = successorOf(lastShown, conversations);
    if (successor !== null) select(successor.key);
  },
  { immediate: true }
);

const mediated = computed(() => state.snapshot?.mediations.some((m) => m.selected) ?? false);
const daemonHost = computed(() => (state.daemonAt === null ? "its origin" : new URL(state.daemonAt).host));
</script>

<template>
  <div v-if="state.phase === 'booting'" class="hollow" style="height: 100%"></div>

  <div v-else-if="state.phase === 'elsewhere'" class="hollow" style="height: 100%">
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Open in another tab</h1>
      <p>
        Your vault is in use by another tab or window of this browser. One
        agent at a time holds the vault: close the other one and this tab
        takes over on its own.
      </p>
    </div>
  </div>

  <Onboarding v-else-if="state.phase === 'onboarding'" />

  <div v-else-if="state.phase === 'unreadable'" class="hollow" style="height: 100%">
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Vault not readable</h1>
      <p>This version of the app cannot open what is here{{ state.phaseDetail === null ? "." : `: ${state.phaseDetail}` }}</p>
      <p class="fine">
        Nothing has been changed. If it came from a newer version, update the
        app. A vault of the earlier folder format is not read or converted:
        export a backup with the app version that wrote it if you want to keep
        it<template v-if="state.daemonAt === null"
          >, then <button class="link" @click="startOver">start over</button> to delete it and begin a new identity</template
        >.
      </p>
    </div>
  </div>

  <Unlock v-else-if="state.phase === 'locked'" />

  <div v-else-if="state.phase === 'unreachable'" class="hollow" style="height: 100%">
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>No daemon is answering</h1>
      <p>
        This page expects a daemon at {{ daemonHost }}
        and nothing there answers it. It keeps trying.
      </p>
      <p class="fine">
        If <code>estoc serve</code> is running, open the link it printed — the
        link carries the key this page needs, and this page remembers it once
        opened that way. <code>?_daemon=off</code> returns this page to a vault
        of its own in the browser.
      </p>
    </div>
  </div>

  <div v-else class="frame">
    <Rail />
    <ChatPane
      v-if="state.snapshot"
      :conversations="state.conversations"
      :selected="selected"
      :mediated="mediated"
      :sends-closed="state.snapshot.restoreUnexplained"
      @select="select"
    />
  </div>

  <div v-if="state.applyUpdate" class="update-chip">
    <span>A new version of Estoc is ready.</span>
    <button class="btn" @click="state.applyUpdate?.()">Reload</button>
  </div>
</template>
