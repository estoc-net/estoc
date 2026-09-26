<script setup lang="ts">
import { ref } from "vue";

import { forgetIdentity, state, unlock } from "../core/store.js";
import { useRemoval } from "./removal.js";

const passphrase = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const { failed: removalFailed, remove } = useRemoval();

async function submit() {
  if (passphrase.value === "" || busy.value) {
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await unlock(passphrase.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function forget() {
  const hold = state.hold;
  return remove("Delete this identity from this browser? Its keys and messages here are gone for good — only a backup could bring them back.", () => forgetIdentity(hold));
}
</script>

<template>
  <div class="hollow" style="height: 100%">
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Locked</h1>
      <p>Your vault is here; its seed is sealed. The passphrase opens it.</p>
      <form @submit.prevent="submit">
        <input
          v-model="passphrase"
          class="field"
          type="password"
          placeholder="passphrase"
          autocomplete="current-password"
          autofocus
        />
        <p v-if="error" class="status-line error">{{ error }}</p>
        <button class="btn" type="submit" :disabled="busy || passphrase === ''">
          {{ busy ? "Opening…" : "Unlock" }}
        </button>
      </form>
      <p class="fine">
        Forgot it? There is no reset — the passphrase is the only thing that opens
        the seed. You can <button class="link" data-start-over @click="forget">start over</button>
        with a new identity.
      </p>
      <p v-if="removalFailed" class="status-line error" data-removal-failed>{{ removalFailed }}</p>
    </div>
  </div>
</template>
