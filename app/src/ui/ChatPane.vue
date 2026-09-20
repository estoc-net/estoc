<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import { pairKey } from "../core/conversations.js";
import { acceptInvitation, dismissPendingInvitation, sendMessage, state } from "../core/store.js";
import type { Conversation } from "../core/types.js";
import { rendererFor, showsInThread, typeOf } from "../renderers/index.js";
import ConversationDetails from "./ConversationDetails.vue";
import RestoreNotice from "./RestoreNotice.vue";
import { shortDid, timeOf } from "./util.js";

const props = defineProps<{
  conversations: Conversation[];
  selected: string | null;
  /** whether any arrangement with a mediator is selected: without one nothing leaves and nothing arrives */
  mediated: boolean;
  /** sends wait for the restore to be explained */
  sendsClosed: boolean;
}>();

const emit = defineEmits<{
  select: [key: string];
}>();

const conversation = computed(() => props.conversations.find((c) => c.key === props.selected) ?? null);

/** Our name for them; failing that what they call themself, quoted as the claim it is; failing that their DID. */
function labelOf(c: Conversation): string {
  if (c.petname !== null) return c.petname;
  if (c.claimedName !== null) return `“${c.claimedName}”`;
  return shortDid(c.channels[0]?.channel.peerDid ?? "");
}

// A thread is every message of every channel the conversation shows that
// its renderer wants shown. Everything is in the vault; which of it takes
// a line is the renderers' call, and what needs the person always does.
const thread = computed(() => conversation.value?.messages.filter(showsInThread) ?? []);

const claimNote = computed(() => {
  const c = conversation.value;
  if (c === null || c.claimedName === null || c.petname === null) {
    return c !== null && c.petname === null ? "not a contact yet" : null;
  }
  return c.claimedName === c.petname ? "a self-styled name" : `calls themself “${c.claimedName}”`;
});

const showDetails = ref(false);
const showAddForm = ref(false);
const newLabel = ref("");
const newLink = ref("");
const addError = ref("");
const adding = ref(false);

// The page may have been opened with someone's invitation link: it is
// offered here, under the name the person adding it chooses.
const pending = computed(() => state.pendingInvitation);
const pendingLabel = ref("");
const pendingError = ref("");

async function accept(input: Parameters<typeof acceptInvitation>[0], label: string, fail: (message: string) => void): Promise<boolean> {
  if (label === "") {
    fail("Give them a name first.");
    return false;
  }
  adding.value = true;
  try {
    emit("select", await acceptInvitation(input, label));
    fail("");
    return true;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    adding.value = false;
  }
}

async function add() {
  if (newLink.value.trim() === "") {
    addError.value = "Paste the invitation link they made for you.";
    return;
  }
  if (await accept(newLink.value, newLabel.value.trim(), (message) => (addError.value = message))) {
    newLabel.value = "";
    newLink.value = "";
    showAddForm.value = false;
  }
}

async function acceptPending() {
  if (pending.value !== null && (await accept(pending.value, pendingLabel.value.trim(), (message) => (pendingError.value = message)))) {
    pendingLabel.value = "";
  }
}

const draft = defineModel<string>("draft", { required: true });
const sending = ref(false);
const sendError = ref("");
/** the channel picked to write in, by pair; none while the conversation's own choice is taken */
const picked = ref<string | null>(null);

watch(
  () => props.selected,
  () => {
    picked.value = null;
    showDetails.value = false;
  }
);

const target = computed(() => {
  const c = conversation.value;
  if (c === null) return null;
  const channel = c.writeTo.find((candidate) => pairKey(candidate) === picked.value) ?? null;
  if (channel !== null) return { channel };
  if (c.defaultWriteTo === null) return null;
  return c.contactId === null ? { channel: c.defaultWriteTo } : { contactId: c.contactId };
});

// A contact that prefers a DID none of its open channels is under gets
// no default, even with one channel open: writing as another DID is the
// person's call, made here.
const mustPick = computed(() => {
  const c = conversation.value;
  if (c === null || c.writeTo.length === 0 || c.defaultWriteTo !== null || target.value !== null) return null;
  return c.writeTo.length === 1 ? "the only open channel is not under the DID you prefer for this contact: choose it to write in it" : "several channels take a send: choose the one this goes out in";
});

const closedBecause = computed(() => {
  const c = conversation.value;
  if (c === null || c.writeTo.length > 0) return null;
  const closed = c.channels.flatMap(({ send }) => (send.status === "closed" ? [send.because] : []));
  return closed[0] ?? "no channel of this conversation is open";
});

async function send() {
  const text = draft.value.trim();
  if (text === "" || target.value === null || sending.value) {
    return;
  }
  sending.value = true;
  sendError.value = "";
  try {
    await sendMessage(target.value, text);
    // the selection may have moved while this was sealed: only the draft that was sent is cleared
    if (draft.value.trim() === text) draft.value = "";
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

watch(() => props.selected, toFoot, { immediate: true });

watch(
  () => thread.value.length,
  () => {
    if (resting) {
      void toFoot();
    }
  }
);

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
      <h2>{{ conversation ? labelOf(conversation) : "Conversations" }}</h2>
      <span v-if="claimNote" class="claim-note">{{ claimNote }}</span>
      <span v-if="conversation" class="head-dids">
        <button class="link-quiet" data-details-toggle @click="showDetails = !showDetails">
          {{ showDetails ? "close" : `${conversation.channels.length} channel${conversation.channels.length === 1 ? "" : "s"}` }}
        </button>
      </span>
    </div>

    <div class="contact-strip">
      <button
        v-for="c in conversations"
        :key="c.key"
        class="contact-chip"
        :class="{ active: c.key === selected, nameless: c.contactId === null }"
        @click="emit('select', c.key)"
      >
        {{ labelOf(c) }}
      </button>
      <button class="contact-chip" @click="showAddForm = !showAddForm">+ contact</button>
    </div>

    <RestoreNotice v-if="sendsClosed" />

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
            <button class="btn" type="submit" :disabled="adding || !mediated || sendsClosed">Accept invitation</button>
            <button class="btn-quiet" type="button" @click="dismissPendingInvitation">Not now</button>
          </div>
          <p v-if="!mediated" class="fine">Choose a mediator in the rail first: accepting writes to them, and they answer to where you can be reached.</p>
        </form>
      </div>
    </div>

    <div v-if="showAddForm || (conversations.length === 0 && !pending)" class="hollow chat-block">
      <div class="hollow-card" style="width: 100%">
        <p v-if="conversations.length === 0">
          To talk to someone, paste an invitation link they made for you, or
          make one for them in the rail. Whoever opens a link of yours and
          writes first opens a conversation here on their own.
        </p>
        <form @submit.prevent="add">
          <input v-model="newLabel" class="field" placeholder="name, e.g. Bob" />
          <input v-model="newLink" class="field" placeholder="paste their invitation link" />
          <p v-if="addError" class="compose-error" style="padding: 0">{{ addError }}</p>
          <button class="btn" type="submit" :disabled="adding || !mediated || sendsClosed">
            {{ adding ? "Adding…" : "Add contact" }}
          </button>
        </form>
      </div>
    </div>

    <ConversationDetails v-if="conversation && showDetails" :key="conversation.key" :conversation="conversation" @named="(key) => emit('select', key)" />

    <div ref="threadEl" class="thread" @scroll.passive="noteScroll">
      <p v-if="conversation && !mediated" class="hop-note">
        No mediator yet — choose one in the rail; without one, nothing leaves and nothing arrives.
      </p>
      <p v-else-if="conversation && thread.length === 0 && conversation.unplaced.length === 0" class="hop-note">
        No messages yet. What you write crosses the mediator sealed to them,
        from a DID of yours nobody else ever sees.
      </p>
      <component :is="rendererFor(typeOf(m)).component" v-for="m in thread" :key="m.messageId" :message="m" />
      <p
        v-for="input in conversation?.unplaced ?? []"
        :key="input.sourceEventId"
        class="hop-note"
        :class="{ error: input.standing === 'conflict' }"
        :title="input.channel === null ? undefined : `${input.channel.peerDid} → ${input.channel.localDid}`"
        data-unplaced
      >
        {{ timeOf(Date.parse(input.at)) }} · received<template v-if="input.channel"> as {{ shortDid(input.channel.localDid) }}</template>, not taken in ({{ input.standing }}):
        {{ input.because }}. Nothing it carries is shown as theirs.
      </p>
    </div>

    <p v-if="sendError" class="compose-error">{{ sendError }}</p>
    <p v-if="mustPick" class="compose-error" data-must-pick>{{ mustPick }}</p>
    <p v-if="conversation && closedBecause" class="compose-error" data-closed>Nothing can be written here: {{ closedBecause }}</p>
    <form v-else-if="conversation" class="composer" @submit.prevent="send">
      <select
        v-if="conversation.writeTo.length > 1 || conversation.defaultWriteTo === null"
        v-model="picked"
        class="field channel-pick"
        title="the channel this goes out in"
        data-channel-pick
      >
        <option :value="null" :disabled="conversation.defaultWriteTo === null">{{ conversation.defaultWriteTo === null ? "choose a channel" : "the usual channel" }}</option>
        <option v-for="channel in conversation.writeTo" :key="pairKey(channel)" :value="pairKey(channel)" :title="`${channel.localDid} → ${channel.peerDid}`">
          as {{ shortDid(channel.localDid) }} → {{ shortDid(channel.peerDid) }}
        </option>
      </select>
      <input v-model="draft" class="field" :placeholder="`Write to ${labelOf(conversation)}`" :disabled="sending || sendsClosed" />
      <button class="btn" type="submit" :disabled="sending || sendsClosed || target === null || draft.trim() === ''">
        {{ sending ? "Sealing…" : "Send" }}
      </button>
    </form>
  </main>
</template>
