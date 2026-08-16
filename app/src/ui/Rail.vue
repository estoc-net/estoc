<script setup lang="ts">
import { computed, ref } from "vue";
import qrcode from "qrcode-generator";

import { mediatorLabel } from "../core/mediators.js";
import {
  chooseMediator,
  createInvitation,
  downloadBackup,
  forgetIdentity,
  lock,
  mergeBackup,
  revokeInvitation,
  state,
} from "../core/store.js";
import type { AgentStatus } from "../core/types.js";
import MediatorForm from "./MediatorForm.vue";
import { bytesOf, shortDid } from "./util.js";

const identity = computed(() => state.identity);

// reachability: an identity is minted without a mediator; the rail is where
// one is named — and, later, where it is changed (a rotation of every DID)
const changingMediator = ref(false);

async function moveMediator(did: string) {
  await chooseMediator(did);
  changingMediator.value = false;
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

// invitations: a link for one person; the QR is the same link, for a phone
const openInvitations = computed(() =>
  (identity.value?.invitations ?? []).filter((i) => i.takenBy === null)
);
const inviting = ref(false);
const inviteError = ref<string | null>(null);
const shownInvitation = ref<string | null>(null);
const invitationCopied = ref(false);

async function invite() {
  inviteError.value = null;
  inviting.value = true;
  try {
    const made = await createInvitation();
    shownInvitation.value = made.id;
  } catch (err) {
    inviteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    inviting.value = false;
  }
}

const shown = computed(
  () => openInvitations.value.find((i) => i.id === shownInvitation.value) ?? null
);
// the link on screen was taken while it was showing: say by whom
const shownTakenBy = computed(() => {
  const record = identity.value?.invitations.find((i) => i.id === shownInvitation.value);
  if (record === undefined || record.takenBy === null) {
    return null;
  }
  return identity.value?.contacts.find((c) => c.cid === record.takenBy)?.label ?? "someone";
});

const qrSvg = computed(() => {
  if (shown.value === null) {
    return "";
  }
  // a did:peer:4 invitation is ~1.6 KB: byte mode, low correction, auto size
  const qr = qrcode(0, "L");
  qr.addData(shown.value.url, "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize: 2, margin: 2, scalable: true });
});

async function copyInvitation(url: string) {
  await navigator.clipboard.writeText(url);
  invitationCopied.value = true;
  setTimeout(() => (invitationCopied.value = false), 1500);
}

async function revoke(id: string) {
  await revokeInvitation(id);
  if (shownInvitation.value === id) {
    shownInvitation.value = null;
  }
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
      <MediatorForm submit-label="Use this mediator" busy-label="Mediating…" :pick="chooseMediator" />
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
        each conversation gets a DID of its own ·
        <button class="link-quiet" data-change-mediator @click="changingMediator = !changingMediator">
          {{ changingMediator ? "keep it" : "change mediator" }}
        </button>
      </p>
      <template v-if="changingMediator">
        <MediatorForm
          submit-label="Move to this mediator"
          busy-label="Moving…"
          :current="identity.mediatorDid"
          :pick="moveMediator"
        />
        <p class="status-line">
          Moving mints every DID of yours anew on the new mediator. Contacts
          you have written to are told, and follow; the business card above
          is replaced — copies already handed out stop working; open
          invitation links are withdrawn.
        </p>
      </template>
    </div>

    <div v-if="identity && identity.mediatorDid !== null" class="rail-section">
      <div class="eyebrow">Invite someone</div>
      <div class="rail-actions" style="margin-top: 0">
        <button class="btn-quiet" :disabled="inviting || identity.did === null" @click="invite">
          {{ inviting ? "minting…" : "New invitation link" }}
        </button>
      </div>
      <p v-if="inviteError" class="status-line error">{{ inviteError }}</p>
      <div v-if="shown" class="invitation">
        <button
          class="did-chip"
          :title="shown.url"
          data-invitation-url
          @click="copyInvitation(shown.url)"
        >
          {{ invitationCopied ? "copied" : "copy the link" }}
        </button>
        <div class="qr" v-html="qrSvg"></div>
        <p class="status-line" style="margin-top: 4px">
          for one person: whoever opens it and writes first is the one it is
          for. Nothing public changes hands — you each get a DID minted for
          the other.
        </p>
      </div>
      <p v-if="shownTakenBy" class="status-line" data-invitation-taken>
        that link was taken — {{ shownTakenBy }} is a contact now
      </p>
      <p v-if="openInvitations.length" class="status-line">
        {{ openInvitations.length }} open link{{ openInvitations.length === 1 ? "" : "s" }}
        <template v-for="i in openInvitations" :key="i.id">
          ·
          <button class="link-quiet" :title="i.url" @click="shownInvitation = i.id">{{ i.ready ? "show" : "not registered yet" }}</button>
          <button class="link-quiet danger" @click="revoke(i.id)">revoke</button>
        </template>
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
