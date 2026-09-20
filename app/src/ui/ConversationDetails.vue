<script setup lang="ts">
import { computed, ref } from "vue";

import { blockChannels, deleteContact, introduce, nameConversation, renameContact, rotate, state } from "../core/store.js";
import type { Conversation, ConversationChannel, DidId } from "../core/types.js";
import { shortDid, shortFormOf } from "./util.js";

/**
 * A conversation as the vault has it: the channels it shows, each a
 * pair of one DID of ours and one of theirs, with what stands in the
 * way of writing in it; and the name we give it. Rotating a channel
 * mints a DID of ours for this peer alone and tells them.
 */
const props = defineProps<{ conversation: Conversation }>();
const emit = defineEmits<{ named: [key: string] }>();

const petname = ref(props.conversation.petname ?? props.conversation.claimedName ?? "");
const busy = ref(false);
const failure = ref<string | null>(null);
const alsoBlock = ref(false);
const alsoErase = ref(false);

async function act(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  failure.value = null;
  try {
    await action();
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

function localDidIdOf(channel: ConversationChannel): DidId | null {
  return state.snapshot?.dids.find((did) => did.did !== null && shortFormOf(did.did) === channel.channel.localDid)?.didId ?? null;
}

const isHead = (channel: ConversationChannel) => channel.head !== null && channel.head.localDid === channel.channel.localDid && channel.head.peerDid === channel.channel.peerDid;

function flagsOf(channel: ConversationChannel): string[] {
  return [
    channel.selected ? "selected" : "history",
    ...(isHead(channel) ? ["current"] : []),
    ...(channel.superseded ? ["the peer moved on"] : []),
    ...(channel.blocked ? ["blocked"] : []),
    ...(channel.conflicted ? ["conflict"] : []),
  ];
}

const name = () =>
  act(async () => {
    const chosen = petname.value.trim();
    if (chosen === "") {
      throw new Error("Give them a name first.");
    }
    if (props.conversation.contactId === null) {
      const heads = props.conversation.channels.filter(isHead);
      emit("named", await nameConversation((heads.length > 0 ? heads : props.conversation.channels).map(({ channel }) => channel), chosen));
    } else {
      await renameContact(props.conversation.contactId, chosen);
    }
  });

function remove() {
  const contactId = props.conversation.contactId;
  if (contactId !== null && confirm("Delete this contact? Its channels stay in the vault unless you also erase their messages.")) {
    void act(() => deleteContact(contactId, { block: alsoBlock.value, erase: alsoErase.value }));
  }
}

const sendsClosed = computed(() => state.snapshot?.restoreUnexplained ?? false);
const selectedChannels = computed(() => props.conversation.channels.filter(({ selected }) => selected));
</script>

<template>
  <div class="details chat-block" data-details>
    <form class="details-name" @submit.prevent="name">
      <input v-model="petname" class="field" placeholder="what you call them" />
      <button class="btn-quiet" type="submit" :disabled="busy">{{ conversation.contactId === null ? "Name this conversation" : "Rename" }}</button>
    </form>
    <p v-for="(line, i) in conversation.diagnostics" :key="i" class="status-line error">{{ line }}</p>

    <div v-for="channel in conversation.channels" :key="channel.channel.localDid + channel.channel.peerDid" class="channel" data-channel>
      <div class="channel-pair">
        <span :title="channel.channel.localDid">you as {{ shortDid(channel.channel.localDid) }}</span>
        <span :title="channel.channel.peerDid">them as {{ shortDid(channel.channel.peerDid) }}</span>
      </div>
      <p class="status-line">
        {{ flagsOf(channel).join(" · ") }}
        <template v-if="channel.send.status === 'closed'"> · cannot write here: {{ channel.send.because }}</template>
        <template v-if="channel.peerName"> · they call themself “{{ channel.peerName.name }}”</template>
      </p>
      <div v-if="channel.send.status === 'open'" class="rail-actions">
        <button v-if="localDidIdOf(channel)" class="btn-quiet" type="button" :disabled="busy || sendsClosed" data-rotate @click="act(() => rotate(localDidIdOf(channel)!, channel.channel.peerDid))">
          Rotate my DID
        </button>
        <button v-if="channel.profileSubmitted === null" class="btn-quiet" type="button" :disabled="busy || sendsClosed" @click="act(() => introduce(channel.channel))">Introduce yourself</button>
        <button class="btn-quiet danger" type="button" :disabled="busy" @click="act(() => blockChannels([channel.channel]))">Block</button>
      </div>
    </div>

    <div v-if="conversation.contactId !== null" class="rail-actions">
      <label><input v-model="alsoBlock" type="checkbox" /> block {{ selectedChannels.length === 1 ? "its channel" : "its channels" }}</label>
      <label><input v-model="alsoErase" type="checkbox" /> erase their messages</label>
      <button class="btn-quiet danger" type="button" :disabled="busy" @click="remove">Delete contact</button>
    </div>
    <p v-if="failure" class="status-line error">{{ failure }}</p>
  </div>
</template>
