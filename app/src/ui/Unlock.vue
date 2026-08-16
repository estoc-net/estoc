<script setup lang="ts">
import { ref } from "vue";

import { forgetIdentity, unlock } from "../core/store.js";

const passphrase = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

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
  if (
    confirm(
      "Delete this identity from this browser? Its keys and messages here are gone for good — only a backup zip could bring them back."
    )
  ) {
    void forgetIdentity();
  }
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
        the seed. You can <button class="link" @click="forget">start over</button>
        with a new identity.
      </p>
    </div>
  </div>
</template>
