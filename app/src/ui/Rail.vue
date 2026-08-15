<script setup lang="ts">
import { computed, ref } from "vue";

import { MEDIATOR_CHOICES, mediatorLabel } from "../core/mediators.js";
import {
  chooseMediator,
  downloadBackup,
  forgetIdentity,
  lock,
  mergeBackup,
  state,
} from "../core/store.js";
import type { AgentStatus } from "../core/types.js";
import { CUSTOM, useMediatorInput } from "./mediator-input.js";
import { bytesOf, shortDid } from "./util.js";

const identity = computed(() => state.identity);

// reachability: an identity is minted without a mediator; this is where one is named
const { choice, pasted, resolving, error: mediatorError, resolveChoice } = useMediatorInput();
const choosing = ref(false);
const chooseError = ref<string | null>(null);

async function pickMediator() {
  chooseError.value = null;
  const did = await resolveChoice();
  if (did === null) {
    return;
  }
  choosing.value = true;
  try {
    await chooseMediator(did);
  } catch (err) {
    chooseError.value = err instanceof Error ? err.message : String(err);
  } finally {
    choosing.value = false;
  }
}

const copied = ref(false);

async function copyDid() {
  if (identity.value?.did == null) {
    return;
  }
  await navigator.clipboard.writeText(identity.value.did);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

function lampClass(status: AgentStatus): string {
  switch (status.state) {
    case "live":
      return "live";
    case "connecting":
      return "connecting";
    case "error":
      return "error";
    default:
      return "";
  }
}

function statusText(status: AgentStatus): string {
  switch (status.state) {
    case "live":
      return "live delivery on";
    case "unmediated":
      return "not reachable yet — no mediator";
    case "connecting":
      return status.detail;
    case "error":
      return status.detail;
    default:
      return "starting";
  }
}

// backup
const exporting = ref(false);
async function exportZip() {
  exporting.value = true;
  try {
    await downloadBackup();
  } finally {
    exporting.value = false;
  }
}

const importInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const importNote = ref<string | null>(null);

async function importZip(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file === undefined) {
    return;
  }
  importing.value = true;
  importNote.value = null;
  try {
    const outcome = await mergeBackup(await bytesOf(file));
    if (outcome.kind === "merged") {
      importNote.value =
        outcome.messagesAdded === 0 && outcome.contactsAdded === 0 && outcome.contactsUpdated === 0
          ? "nothing new in that backup"
          : `merged: ${outcome.messagesAdded} messages, ${outcome.contactsAdded + outcome.contactsUpdated} contacts`;
    }
  } catch (err) {
    importNote.value = err instanceof Error ? err.message : String(err);
  } finally {
    importing.value = false;
    if (importInput.value !== null) {
      importInput.value.value = "";
    }
  }
}

function forget() {
  if (
    confirm(
      "Delete this identity from this browser? Keys, contacts and messages here are gone for good — export a backup first if you want them back."
    )
  ) {
    void forgetIdentity();
  }
}
</script>

<template>
  <aside class="rail">
    <div class="wordmark">
      <div class="name">Estoc</div>
      <div class="sub">messenger</div>
    </div>

    <div v-if="identity" class="rail-section">
      <div class="eyebrow">You</div>
      <div class="profile-row you">
        <span class="lamp" :class="lampClass(state.status)"></span>
        <span class="profile-name">{{ identity.name }}</span>
      </div>
      <p class="status-line" :class="{ error: state.status.state === 'error' }">
        {{ statusText(state.status) }}
      </p>
    </div>

    <div v-if="identity && identity.mediatorDid === null" class="rail-section">
      <div class="eyebrow">Choose a mediator to be reached</div>
      <form class="rail-form" @submit.prevent="pickMediator">
        <select v-model="choice" class="field">
          <option v-for="c in MEDIATOR_CHOICES" :key="c.value" :value="c.value">
            via {{ c.label }}
          </option>
          <option :value="CUSTOM">via a pasted invitation…</option>
        </select>
        <input
          v-if="choice === CUSTOM"
          v-model="pasted"
          class="field"
          placeholder="invitation URL, mediator URL, or DID"
        />
        <p v-if="chooseError || mediatorError" class="status-line error" style="margin: 0">
          {{ chooseError ?? mediatorError }}
        </p>
        <button class="btn" type="submit" :disabled="choosing || resolving">
          {{ choosing ? "Mediating…" : "Use this mediator" }}
        </button>
      </form>
      <p class="status-line">
        A mediator holds sealed envelopes until you pick them up, and its
        address rides in the DID you hand out.
      </p>
    </div>

    <div v-else-if="identity" class="rail-section">
      <div class="eyebrow">Your public DID — share it to be reached</div>
      <button
        class="did-chip"
        :title="identity.did ?? 'not minted yet'"
        :disabled="identity.did === null"
        @click="copyDid"
      >
        {{ copied ? "copied" : identity.did === null ? "minting…" : shortDid(identity.did) }}
      </button>
      <p class="status-line">
        via {{ mediatorLabel(identity.mediatorDid ?? "") }} · a business card:
        each conversation gets a DID of its own
      </p>
    </div>

    <div class="rail-section">
      <div class="eyebrow">Your vault</div>
      <p class="status-line">
        <template v-if="state.persisted">stored persistently in this browser</template>
        <template v-else>storage is best-effort here — keep a backup</template>
      </p>
      <div class="rail-actions">
        <button class="btn-quiet" :disabled="exporting" @click="exportZip">
          {{ exporting ? "zipping…" : "Export backup" }}
        </button>
        <label class="btn-quiet file-btn">
          {{ importing ? "merging…" : "Import backup" }}
          <input
            ref="importInput"
            type="file"
            accept=".zip,application/zip"
            :disabled="importing"
            @change="importZip"
          />
        </label>
      </div>
      <p v-if="importNote" class="status-line">{{ importNote }}</p>
      <div class="rail-actions">
        <button v-if="state.install" class="btn-quiet" @click="state.install?.()">
          Install app
        </button>
        <button class="btn-quiet" @click="lock">Lock</button>
        <button class="btn-quiet danger" @click="forget">Forget identity</button>
      </div>
      <p v-if="state.offlineReady && !state.installed" class="status-line">
        ready to work offline
      </p>
    </div>

    <div v-if="state.log.length" class="rail-log">
      <p v-for="(line, i) in state.log" :key="i">{{ line }}</p>
    </div>
  </aside>
</template>
