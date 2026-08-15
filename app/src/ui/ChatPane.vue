<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { addContact, sendMessage } from "../core/store.js";
import type { Identity } from "../core/types.js";
import { shortDid, timeOf } from "./util.js";

const props = defineProps<{
  identity: Identity;
  selectedContactCid: string | null;
}>();

const emit = defineEmits<{
  selectContact: [cid: string];
}>();

const contact = computed(
  () => props.identity.contacts.find((c) => c.cid === props.selectedContactCid) ?? null
);

// A thread is everything homed to the contact — across every DID either
// side has used with the other.
const thread = computed(() =>
  props.identity.messages.filter((m) => m.contactCid === props.selectedContactCid)
);

// A displayName arriving over user-profile/1.0 is only ever a claim; the
// head says so instead of presenting it as fact.
const claimNote = computed(() => {
  const c = contact.value;
  if (c === null || c.claimedName === undefined) {
    return null;
  }
  return c.claimedName === c.label
    ? "a self-styled name"
    : `calls themself “${c.claimedName}”`;
});

function profileLine(direction: "sent" | "received", name: string): string {
  return direction === "sent"
    ? `you introduced yourself as “${name}”`
    : `introduced themself as “${name}”`;
}

const showAddForm = ref(false);
const newLabel = ref("");
const newDid = ref("");
const addError = ref("");

async function add() {
  const did = newDid.value.trim();
  const label = newLabel.value.trim() || shortDid(did);
  if (!did.startsWith("did:")) {
    addError.value = "That is not a DID — it should start with did:";
    return;
  }
  const added = await addContact(did, label);
  if (added !== null) {
    emit("selectContact", added.cid);
  }
  newLabel.value = "";
  newDid.value = "";
  addError.value = "";
  showAddForm.value = false;
}

const draft = ref("");
const sending = ref(false);
const sendError = ref("");

async function send() {
  const text = draft.value.trim();
  if (text === "" || contact.value === null || sending.value) {
    return;
  }
  sending.value = true;
  sendError.value = "";
  try {
    await sendMessage(contact.value.did, text);
    draft.value = "";
  } catch (err) {
    sendError.value = err instanceof Error ? err.message : String(err);
  } finally {
    sending.value = false;
  }
}

const threadEl = ref<HTMLElement | null>(null);

watch(
  () => thread.value.length,
  async () => {
    await nextTick();
    threadEl.value?.scrollTo({ top: threadEl.value.scrollHeight });
  }
);
</script>

<template>
  <main class="chat">
    <div class="chat-head">
      <h2>{{ contact?.label ?? "Conversations" }}</h2>
      <span v-if="claimNote" class="claim-note">{{ claimNote }}</span>
      <span v-if="contact" class="head-dids">
        <span class="eyebrow" :title="contact.did">{{ shortDid(contact.did) }}</span>
        <span
          v-if="contact.myDid"
          class="eyebrow"
          :title="`the DID you write to ${contact.label} from — theirs alone: ${contact.myDid}`"
        >you as {{ shortDid(contact.myDid) }}</span>
      </span>
    </div>

    <div class="contact-strip">
      <button
        v-for="c in identity.contacts"
        :key="c.cid"
        class="contact-chip"
        :class="{ active: c.cid === selectedContactCid }"
        @click="emit('selectContact', c.cid)"
      >
        {{ c.label }}
      </button>
      <button class="contact-chip" @click="showAddForm = !showAddForm">+ contact</button>
    </div>

    <div v-if="showAddForm || identity.contacts.length === 0" class="hollow" style="flex: none">
      <div class="hollow-card" style="width: 100%">
        <p v-if="identity.contacts.length === 0">
          To talk to someone, add them as a contact: they copy their DID from
          their own rail and send it to you any way they like. Anyone who has
          yours can write to you the same way — a stranger's first message
          opens a conversation here on its own.
        </p>
        <form @submit.prevent="add">
          <input v-model="newLabel" class="field" placeholder="name, e.g. Bob" />
          <input v-model="newDid" class="field" placeholder="paste their DID (did:peer:4… or did:web:…)" />
          <p v-if="addError" class="compose-error" style="padding: 0">{{ addError }}</p>
          <button class="btn" type="submit">Add contact</button>
        </form>
      </div>
    </div>

    <div ref="threadEl" class="thread">
      <p v-if="contact && identity.mediatorDid === null" class="hop-note">
        No mediator yet — choose one in the rail before writing to
        {{ contact.label }}; without one, nothing leaves and nothing arrives.
      </p>
      <p v-else-if="contact && thread.length === 0" class="hop-note">
        No messages yet. Your first message mints a DID of yours for
        {{ contact.label }} alone — nobody else ever sees it — and whatever
        you write crosses the mediator sealed to them.
      </p>
      <div
        v-for="m in thread"
        :key="m.id"
        class="bubble"
        :class="[m.direction, { system: m.kind === 'profile' }]"
      >
        <div>{{ m.kind === "profile" ? profileLine(m.direction, m.content) : m.content }}</div>
        <div class="meta">
          <span>{{ timeOf(m.time) }}</span>
        </div>
      </div>
    </div>

    <p v-if="sendError" class="compose-error">{{ sendError }}</p>
    <form v-if="contact" class="composer" @submit.prevent="send">
      <input
        v-model="draft"
        class="field"
        :placeholder="`Write to ${contact.label}`"
        :disabled="sending"
      />
      <button class="btn" type="submit" :disabled="sending || draft.trim() === ''">
        {{ sending ? "Sealing…" : "Send" }}
      </button>
    </form>
  </main>
</template>
