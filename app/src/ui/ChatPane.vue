<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { readBundle, unzipMapping } from "@estoc/folder-object";

import { acceptInvitation, addContactFrom, dismissPendingInvitation, sendMessage, shareObject, state } from "../core/store.js";
import type { Identity } from "../core/types.js";
import { rendererFor, showsInThread } from "../renderers/index.js";
import { shortDid } from "./util.js";

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
// side has used with the other — that its renderer wants shown. Every
// record is in the log; which of them take a line is the renderers' call.
const thread = computed(() =>
  props.selectedContactCid === null
    ? []
    : props.identity.messages.filter(
        (e) => e.contactCid === props.selectedContactCid && showsInThread(e)
      )
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

const showAddForm = ref(false);
const newLabel = ref("");
const newDid = ref("");
const addError = ref("");
const adding = ref(false);

// The page may have been opened with someone's invitation link: it is
// offered here, under the name the person adding it chooses.
const pending = computed(() => state.pendingInvitation);
const pendingLabel = ref("");
const pendingError = ref("");

async function add() {
  const input = newDid.value.trim();
  const label = newLabel.value.trim() || (input.startsWith("did:") ? shortDid(input) : "invited");
  if (input === "") {
    addError.value = "Paste their DID, or an invitation link.";
    return;
  }
  adding.value = true;
  try {
    const added = await addContactFrom(input, label);
    if (added !== null) {
      emit("selectContact", added.cid);
    }
    newLabel.value = "";
    newDid.value = "";
    addError.value = "";
    showAddForm.value = false;
  } catch (err) {
    addError.value = err instanceof Error ? err.message : String(err);
  } finally {
    adding.value = false;
  }
}

async function acceptPending() {
  if (pending.value === null) {
    return;
  }
  const label = pendingLabel.value.trim();
  if (label === "") {
    pendingError.value = "Give them a name first.";
    return;
  }
  adding.value = true;
  try {
    const added = await acceptInvitation(pending.value, label);
    if (added !== null) {
      emit("selectContact", added.cid);
    }
    pendingLabel.value = "";
    pendingError.value = "";
  } catch (err) {
    pendingError.value = err instanceof Error ? err.message : String(err);
  } finally {
    adding.value = false;
  }
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
    void toFoot();
  } catch (err) {
    sendError.value = err instanceof Error ? err.message : String(err);
  } finally {
    sending.value = false;
  }
}

// An object goes over whole (object-share/1.0): a bundle zip — `object/…`
// plus its author's `card.jws` — is passed on under that card; a bare
// object zip (index.json at the root) is ours, and the anchor signs it.
const objectInput = ref<HTMLInputElement | null>(null);

async function shareFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file === undefined || contact.value === null || sending.value) {
    return;
  }
  sending.value = true;
  sendError.value = "";
  try {
    const bundle = readBundle(unzipMapping(new Uint8Array(await file.arrayBuffer())));
    await shareObject(contact.value.did, bundle.object.tree, bundle.card);
    void toFoot();
  } catch (err) {
    sendError.value = err instanceof Error ? err.message : String(err);
  } finally {
    sending.value = false;
  }
}

const threadEl = ref<HTMLElement | null>(null);

// The thread rests at its foot: the newest message is the one you want in
// view. Someone scrolled up reading history is left where they are — an
// arriving message does not yank the page out from under them — but
// opening a conversation, and writing in one, always come back to the end.
let resting = true;

function atFoot(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
}

function noteScroll() {
  const el = threadEl.value;
  if (el !== null) {
    resting = atFoot(el);
  }
}

async function toFoot() {
  await nextTick();
  const el = threadEl.value;
  if (el !== null) {
    el.scrollTop = el.scrollHeight;
    resting = true;
  }
}

watch(() => props.selectedContactCid, toFoot, { immediate: true });

watch(() => thread.value.length, () => {
  if (resting) {
    void toFoot();
  }
});

// A window that shrinks — or a phone keyboard opening — must not lift the
// newest message off the foot and leave it floating in the middle.
onMounted(() => {
  const el = threadEl.value;
  if (el === null) {
    return;
  }
  const observer = new ResizeObserver(() => {
    if (resting) {
      el.scrollTop = el.scrollHeight;
    }
  });
  observer.observe(el);
  onUnmounted(() => observer.disconnect());
});
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

    <div v-if="pending" class="hollow invited chat-block">
      <div class="hollow-card" style="width: 100%">
        <div class="eyebrow">You were handed an invitation</div>
        <p>
          <em v-if="pending.body.goal">“{{ pending.body.goal }}”</em>
          <template v-else>Someone made a link for one person to write to them.</template>
          Name them and add them: they will see you arrive, and the two of you
          write from DIDs minted for each other alone.
        </p>
        <form @submit.prevent="acceptPending">
          <input v-model="pendingLabel" class="field" placeholder="what you call them, e.g. Alice" />
          <p v-if="pendingError" class="compose-error" style="padding: 0">{{ pendingError }}</p>
          <div class="rail-actions" style="gap: 8px">
            <button class="btn" type="submit" :disabled="adding">Accept invitation</button>
            <button class="btn-quiet" type="button" @click="dismissPendingInvitation">Not now</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="showAddForm || (identity.contacts.length === 0 && !pending)" class="hollow chat-block">
      <div class="hollow-card" style="width: 100%">
        <p v-if="identity.contacts.length === 0">
          To talk to someone, add them as a contact: paste an invitation link
          they made for you (the rail makes yours), or the DID from their
          rail, sent any way they like. Anyone who has your public DID can
          write to you too — a stranger's first message opens a conversation
          here on its own.
        </p>
        <form @submit.prevent="add">
          <input v-model="newLabel" class="field" placeholder="name, e.g. Bob" />
          <input v-model="newDid" class="field" placeholder="paste their invitation link or DID" />
          <p v-if="addError" class="compose-error" style="padding: 0">{{ addError }}</p>
          <button class="btn" type="submit" :disabled="adding">
            {{ adding ? "Adding…" : "Add contact" }}
          </button>
        </form>
      </div>
    </div>

    <div ref="threadEl" class="thread" @scroll.passive="noteScroll">
      <p v-if="contact && identity.mediatorDid === null" class="hop-note">
        No mediator yet — choose one in the rail before writing to
        {{ contact.label }}; without one, nothing leaves and nothing arrives.
      </p>
      <p v-else-if="contact && thread.length === 0" class="hop-note">
        No messages yet. Your first message mints a DID of yours for
        {{ contact.label }} alone — nobody else ever sees it — and whatever
        you write crosses the mediator sealed to them.
      </p>
      <component
        :is="rendererFor(e.type).component"
        v-for="e in thread"
        :key="e.mid"
        :entry="e"
        :contact="contact"
      />
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
      <button
        class="btn btn-quiet"
        type="button"
        title="share an object: a bundle or object zip"
        :disabled="sending"
        @click="objectInput?.click()"
      >
        Object…
      </button>
      <input ref="objectInput" type="file" accept=".zip,application/zip" data-share="object" hidden @change="shareFile" />
    </form>
  </main>
</template>
