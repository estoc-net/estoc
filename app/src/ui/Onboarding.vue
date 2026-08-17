<script setup lang="ts">
import { ref } from "vue";

import { createIdentity, restoreIdentity, state } from "../core/store.js";
import { bytesOf } from "./util.js";

/**
 * First run: mint an identity here, or restore one from a backup zip. Both
 * end in the same place — a vault in this browser's private file system,
 * its seed sealed under the passphrase typed here. A mediator is not asked
 * for: an identity is a name and a seed; being reachable comes after, in
 * the rail.
 */

const mode = ref<"create" | "restore">("create");

// create
const name = ref("");
const passphrase = ref("");
const confirmPass = ref("");
const creating = ref(false);
const createError = ref<string | null>(null);

async function create() {
  createError.value = null;
  const label = name.value.trim();
  if (label === "") {
    createError.value = "Give yourself a name — it is what contacts will see.";
    return;
  }
  if (passphrase.value.length < 8) {
    createError.value = "Use a passphrase of at least 8 characters — it seals your seed.";
    return;
  }
  if (passphrase.value !== confirmPass.value) {
    createError.value = "The two passphrases differ.";
    return;
  }
  creating.value = true;
  try {
    await createIdentity(label, passphrase.value);
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err);
  } finally {
    creating.value = false;
  }
}

// restore
const zipFile = ref<File | null>(null);
const restorePass = ref("");
const restoring = ref(false);
const restoreError = ref<string | null>(null);

function pickZip(event: Event) {
  zipFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function restore() {
  restoreError.value = null;
  if (zipFile.value === null) {
    restoreError.value = "Choose the backup zip first.";
    return;
  }
  restoring.value = true;
  try {
    await restoreIdentity(await bytesOf(zipFile.value), restorePass.value);
  } catch (err) {
    restoreError.value = err instanceof Error ? err.message : String(err);
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div class="hollow" style="height: 100%">
    <div class="hollow-card">
      <div class="eyebrow">Estoc</div>
      <h1>Your messages, <em>your</em> keeping</h1>
      <p>
        Estoc is a messenger that runs on DIDComm through a mediator of your
        choosing. Your identity is minted here, in this browser, from a single
        seed; your messages stay here, in a vault you can zip up and walk away
        with. Nothing about you lives on our servers — a mediator only holds
        sealed envelopes until you pick them up.
      </p>
      <p v-if="state.status.state === 'error'" class="status-line error">
        {{ state.status.detail }}
      </p>

      <div class="tabs">
        <button class="tab" :class="{ active: mode === 'create' }" @click="mode = 'create'">
          New identity
        </button>
        <button class="tab" :class="{ active: mode === 'restore' }" @click="mode = 'restore'">
          Restore a backup
        </button>
      </div>

      <form v-if="mode === 'create'" @submit.prevent="create">
        <input v-model="name" class="field" placeholder="your name, e.g. Alice" autocomplete="nickname" />
        <input
          v-model="passphrase"
          class="field"
          type="password"
          placeholder="passphrase (seals your seed; backups carry it sealed)"
          autocomplete="new-password"
        />
        <input
          v-model="confirmPass"
          class="field"
          type="password"
          placeholder="passphrase again"
          autocomplete="new-password"
        />
        <p v-if="createError" class="status-line error">{{ createError }}</p>
        <button class="btn" type="submit" :disabled="creating">
          {{ creating ? "Minting…" : "Create identity" }}
        </button>
        <p class="fine">
          The passphrase is not recoverable: it is the only thing that opens the
          seed. You will rarely type it — this browser keeps the unlocked seed —
          but a backup on another device needs it. Which mediator carries your
          mail is chosen next, once you are in.
        </p>
      </form>

      <form v-else @submit.prevent="restore">
        <input class="field" type="file" accept=".zip,application/zip" @change="pickZip" />
        <input
          v-model="restorePass"
          class="field"
          type="password"
          placeholder="the backup's passphrase"
          autocomplete="current-password"
        />
        <p v-if="restoreError" class="status-line error">{{ restoreError }}</p>
        <button class="btn" type="submit" :disabled="restoring">
          {{ restoring ? "Restoring…" : "Restore" }}
        </button>
        <p class="fine">
          A backup is the vault as it was zipped: identity, contacts, message
          history. Restoring it here makes this browser that identity's home;
          if it is still open elsewhere, only one of the two receives at a time.
        </p>
      </form>
    </div>
  </div>
</template>
