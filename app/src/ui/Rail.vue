<script setup lang="ts">
import { computed, ref } from "vue";
import qrcode from "qrcode-generator";
import type { TraceLevel } from "@estoc/agent-core";

import { mediatorLabel } from "../core/mediators.js";
import { chooseMediator, createInvitation, downloadBackup, forgetIdentity, invitationLink, lock, mergeBackup, reconnect, setTraceLevel, state } from "../core/store.js";
import MediatorForm from "./MediatorForm.vue";
import PendingWork from "./PendingWork.vue";
import { useRemoval } from "./removal.js";
import { bytesOf, dispositionOf, shortDid } from "./util.js";

const snapshot = computed(() => state.snapshot);
const daemonHost = computed(() => (state.daemonAt === null ? "" : new URL(state.daemonAt).host));

// reachability: an identity is minted without a mediator; the rail is where
// one is named, and later where another is
const mediation = computed(() => snapshot.value?.mediations.find((m) => m.selected) ?? null);
const changingMediator = ref(false);

async function moveMediator(did: string) {
  await chooseMediator(did);
  changingMediator.value = false;
}

const unknownRegistrations = computed(() => (state.lines?.connections ?? []).flatMap((c) => c.unknownRegistrations));
// the line to the selected mediator, which only the running agent knows
const line = computed(() => state.lines?.connections.find((c) => c.mediationId === mediation.value?.mediationId) ?? null);

const lamp = computed(() => {
  if (state.away !== null || (line.value !== null && line.value.unreachable !== null)) return "error";
  if (line.value?.live === true) return "live";
  return mediation.value === null ? "" : "connecting";
});

const statusText = computed(() => {
  if (state.away !== null) return state.away;
  if (mediation.value === null) return "not reachable yet — no mediator";
  if (line.value === null) return "connecting";
  if (line.value.unreachable !== null) return line.value.unreachable;
  return line.value.live ? "live delivery on" : "connected, no live delivery";
});

const TRACE_NOTES: Record<TraceLevel, string> = {
  off: "nothing observed is kept",
  normal: "envelopes, frames and the mediator's rituals, for a month",
  verbose: "the same and the bytes on the wire, for four months",
};
const traceBusy = ref(false);

async function chooseTraceLevel(event: Event) {
  traceBusy.value = true;
  try {
    await setTraceLevel((event.target as HTMLSelectElement).value as TraceLevel);
  } finally {
    traceBusy.value = false;
  }
}

// invitations: a link for one person; the QR is the same link, for a phone
const openInvitations = computed(() => (snapshot.value?.invitations ?? []).filter((i) => i.uses === "one" && i.state.status === "available"));
const inviting = ref(false);
const inviteError = ref<string | null>(null);
const shownInvitation = ref<string | null>(null);
const invitationCopied = ref(false);

async function invite() {
  inviteError.value = null;
  inviting.value = true;
  try {
    shownInvitation.value = await createInvitation();
  } catch (err) {
    inviteError.value = err instanceof Error ? err.message : String(err);
  } finally {
    inviting.value = false;
  }
}

const shownRecord = computed(() => snapshot.value?.invitations.find((i) => i.oobId === shownInvitation.value) ?? null);
const shownUrl = computed(() => (shownRecord.value === null || shownRecord.value.state.status !== "available" ? null : invitationLink(shownRecord.value)));
// the link on screen was taken while it was showing
const shownTaken = computed(() => shownRecord.value?.state.status === "consumed");

// A link can outgrow what a QR code holds: its length follows the DID,
// and so the mediator's endpoints in it. The link is whole either way.
const qrSvg = computed(() => {
  if (shownUrl.value === null) {
    return null;
  }
  try {
    const qr = qrcode(0, "L");
    qr.addData(shownUrl.value, "Byte");
    qr.make();
    return qr.createSvgTag({ cellSize: 2, margin: 2, scalable: true });
  } catch {
    return null;
  }
});

async function copyInvitation(url: string) {
  await navigator.clipboard.writeText(url);
  invitationCopied.value = true;
  setTimeout(() => (invitationCopied.value = false), 1500);
}

const exporting = ref(false);
async function exportBackup() {
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
const { failed: removalFailed, remove } = useRemoval();

async function importBackup(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file === undefined) {
    return;
  }
  importing.value = true;
  importNote.value = null;
  try {
    const merged = await mergeBackup(await bytesOf(file));
    importNote.value =
      merged.added === 0 && merged.objects === 0
        ? "nothing new in that backup"
        : `merged: ${merged.added} new event${merged.added === 1 ? "" : "s"}, ${merged.objects} object${merged.objects === 1 ? "" : "s"}`;
    if (merged.renewed) importNote.value += ". That backup and this vault were copies of one another that both went on being written; this one now writes under a fresh ID of its own, its history unchanged.";
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
  const hold = state.hold;
  return remove("Delete this identity from this browser? Keys, contacts and messages here are gone for good — export a backup first if you want them back.", () => forgetIdentity(hold));
}
</script>

<template>
  <aside class="rail">
    <div class="wordmark">
      <div class="name">Estoc</div>
      <div class="sub">messenger</div>
    </div>

    <div v-if="snapshot" class="rail-section">
      <div class="eyebrow">You</div>
      <div class="profile-row you">
        <span class="lamp" :class="lamp"></span>
        <span class="profile-name">{{ snapshot.label }}</span>
      </div>
      <p class="status-line" :class="{ error: lamp === 'error' }" data-status>
        {{ statusText }}
        <button v-if="lamp === 'error' && state.away === null" class="link-quiet" @click="reconnect">try again</button>
      </p>
    </div>

    <div v-if="snapshot && mediation === null" class="rail-section">
      <div class="eyebrow">Choose a mediator to be reached</div>
      <MediatorForm submit-label="Use this mediator" busy-label="Mediating…" :pick="chooseMediator" />
      <p class="status-line">
        A mediator holds sealed envelopes until you pick them up, and its
        address rides in every DID you hand out.
      </p>
    </div>

    <div v-else-if="snapshot && mediation" class="rail-section">
      <div class="eyebrow">Reached through</div>
      <p class="status-line" :title="mediation.mediatorDid ?? ''" data-mediator>
        {{ mediatorLabel(mediation.mediatorDid ?? "") }} · each conversation gets a DID of its own ·
        <button class="link-quiet" data-change-mediator @click="changingMediator = !changingMediator">
          {{ changingMediator ? "keep it" : "change mediator" }}
        </button>
      </p>
      <p v-for="fault in mediation.faults" :key="fault" class="status-line error">{{ fault }}</p>
      <template v-if="changingMediator">
        <MediatorForm submit-label="Use this mediator" busy-label="Mediating…" :current="mediation.mediatorDid" :pick="moveMediator" />
        <p class="status-line">
          The DIDs you mint from here on, for an invitation or a rotation,
          are reached through the new mediator. The ones you have stay where
          they are until you rotate them, a conversation at a time.
        </p>
      </template>
    </div>

    <div v-if="snapshot && mediation" class="rail-section">
      <div class="eyebrow">Invite someone</div>
      <div class="rail-actions" style="margin-top: 0">
        <button class="btn-quiet" :disabled="inviting" @click="invite">
          {{ inviting ? "minting…" : "New invitation link" }}
        </button>
      </div>
      <p v-if="inviteError" class="status-line error">{{ inviteError }}</p>
      <div v-if="shownUrl" class="invitation">
        <button class="did-chip" :title="shownUrl" data-invitation-url @click="copyInvitation(shownUrl)">
          {{ invitationCopied ? "copied" : "copy the link" }}
        </button>
        <div v-if="qrSvg" class="qr" v-html="qrSvg"></div>
        <p v-else class="status-line" data-no-qr>This link is too long for a QR code; copy it instead.</p>
        <p class="status-line" style="margin-top: 4px">
          for one person: whoever opens it and writes first is the one it is
          for. Nothing public changes hands — you each get a DID minted for
          the other.
        </p>
      </div>
      <p v-if="shownTaken" class="status-line" data-invitation-taken>that link was taken: a new conversation is open</p>
      <p v-if="openInvitations.length" class="status-line">
        {{ openInvitations.length }} open link{{ openInvitations.length === 1 ? "" : "s" }}
        <template v-for="i in openInvitations" :key="i.oobId">
          ·
          <button class="link-quiet" @click="shownInvitation = i.oobId">show</button>
        </template>
      </p>
    </div>

    <PendingWork v-if="snapshot" :pending="snapshot.pending" :closed="snapshot.restoreUnexplained" />

    <div v-if="state.lines && (state.lines.discarded.length || state.lines.waiting.length)" class="rail-section" data-turned-away>
      <div class="eyebrow">Deliveries not taken in</div>
      <p v-for="(waiting, i) in state.lines.waiting" :key="`w${i}`" class="status-line">waiting: {{ waiting.reason }}</p>
      <p v-for="(discarded, i) in state.lines.discarded" :key="`d${i}`" class="status-line error">{{ discarded.reason }}</p>
    </div>

    <div v-if="unknownRegistrations.length" class="rail-section" data-unknown-registrations>
      <div class="eyebrow">Addresses this vault does not know</div>
      <p class="status-line error">
        The mediator was holding {{ unknownRegistrations.length }} address{{ unknownRegistrations.length === 1 ? "" : "es" }} for this account that this
        vault has no record of creating ({{ unknownRegistrations.map(shortDid).join(", ") }}). This vault registers only its own addresses, so
        it asked the mediator to take them off and created nothing for them. This vault and the mediator disagree about what was registered; a vault restored from a backup older
        than those addresses is one way that happens.
      </p>
    </div>

    <div v-if="snapshot && snapshot.unplaced.inputs.length + snapshot.unplaced.outputs.length > 0" class="rail-section">
      <div class="eyebrow">In no conversation</div>
      <p v-for="input in snapshot.unplaced.inputs" :key="input.sourceEventCid" class="status-line" :class="{ error: input.disposition.status === 'refused' }">received, {{ dispositionOf(input) }}</p>
      <p v-for="output in snapshot.unplaced.outputs" :key="output.message.messageId" class="status-line error">
        a message of yours names {{ output.candidates.length }} channels ({{ output.candidates.map((c) => shortDid(c.peerDid)).join(", ") }}) and goes out in none
      </p>
    </div>

    <div class="rail-section">
      <div class="eyebrow">Your vault</div>
      <p class="status-line">
        <template v-if="state.daemonAt !== null">a file on this machine, via estoc-daemon at {{ daemonHost }}</template>
        <template v-else-if="state.persisted">stored persistently in this browser</template>
        <template v-else>storage is best-effort here — keep a backup</template>
      </p>
      <div class="rail-actions">
        <button class="btn-quiet" :disabled="exporting" data-export @click="exportBackup">
          {{ exporting ? "exporting…" : "Export backup" }}
        </button>
        <label class="btn-quiet file-btn">
          {{ importing ? "merging…" : "Import backup" }}
          <input ref="importInput" type="file" accept=".sqlite,application/vnd.sqlite3" :disabled="importing" @change="importBackup" />
        </label>
      </div>
      <p class="status-line">
        A backup is one file holding everything here. The passphrase seals
        the seed in it and nothing else: whoever has the file reads the
        messages.
      </p>
      <p v-if="importNote" class="status-line" data-import-note>{{ importNote }}</p>
      <div class="rail-actions">
        <button v-if="state.install" class="btn-quiet" @click="state.install?.()">Install app</button>
        <button class="btn-quiet" @click="lock">Lock</button>
        <button class="btn-quiet danger" data-forget @click="forget">Forget identity</button>
      </div>
      <p v-if="removalFailed" class="status-line error" data-removal-failed>{{ removalFailed }}</p>
      <p v-if="state.offlineReady && !state.installed" class="status-line">ready to work offline</p>
    </div>

    <div v-if="snapshot" class="rail-section">
      <div class="eyebrow">Trace</div>
      <label class="trace-level">
        keep what this device observes
        <select :value="state.traceLevel" :disabled="traceBusy" data-trace-level @change="chooseTraceLevel">
          <option v-for="(_note, level) in TRACE_NOTES" :key="level" :value="level">{{ level }}</option>
        </select>
      </label>
      <p class="status-line">{{ TRACE_NOTES[state.traceLevel] }}. A device preference: it is in no backup.</p>
    </div>

    <div v-if="state.log.length" class="rail-log">
      <p v-for="(line, i) in state.log" :key="i">{{ line }}</p>
    </div>
  </aside>
</template>
