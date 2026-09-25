<script setup lang="ts">
import { computed, ref } from "vue";

import { cancel, completeNotification, completeResponse, retry } from "../core/store.js";
import type { PendingWork } from "../core/types.js";
import { shortDid } from "./util.js";

/**
 * What the vault has left for a hand to do. Opening a vault sends
 * nothing: a message a transport was never called for, a reply an input
 * still earns, a rotation the peer was never told of, each waits here
 * for the step named beside it. What has no step is shown with what it
 * waits for.
 */
const props = defineProps<{ pending: PendingWork; closed: boolean }>();

const count = computed(
  () => props.pending.pendingOutbounds.length + props.pending.missingResponses.length + props.pending.missingNotifications.length + props.pending.notificationConflicts.length + props.pending.pendingProofs.length
);

const busy = ref(false);
const failure = ref<string | null>(null);

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
</script>

<template>
  <div v-if="count > 0" class="rail-section" data-pending>
    <div class="eyebrow">Left to do by hand ({{ count }})</div>
    <p v-for="outbound in pending.pendingOutbounds" :key="outbound.messageId" class="status-line" :title="outbound.messageId">
      a message {{ outbound.outcome === "queued" ? "not sealed yet" : "sealed, not handed over" }}<template v-if="outbound.channel"> to {{ shortDid(outbound.channel.peerDid) }}</template
      ><template v-if="outbound.because">: {{ outbound.because }}</template>
      <button v-if="outbound.entries.includes('retry')" class="link-quiet" :disabled="busy || closed" @click="act(() => retry(outbound.messageId))">send</button>
      <button v-if="outbound.entries.includes('cancel')" class="link-quiet danger" :disabled="busy" @click="act(() => cancel(outbound.messageId))">cancel</button>
    </p>
    <p v-for="response in pending.missingResponses" :key="response.executionId + response.effectType" class="status-line" :title="response.messageId">
      a reply ({{ response.effectType }}) to {{ shortDid(response.channel.peerDid) }}
      <button v-if="response.entries.includes('completeResponse')" class="link-quiet" :disabled="busy || closed" @click="act(() => completeResponse(response.executionId, response.effectType))">give it</button>
    </p>
    <p v-for="notification in pending.missingNotifications" :key="notification.rotationEventCid" class="status-line" data-missing-notification>
      {{ shortDid(notification.channel.peerDid) }} was never told of your new DID
      <button v-if="notification.entries.includes('completeNotification')" class="link-quiet" :disabled="busy || closed" @click="act(() => completeNotification(notification.rotationEventCid))">tell them</button>
    </p>
    <p v-for="conflict in pending.notificationConflicts" :key="conflict.rotationEventCid" class="status-line error">
      {{ conflict.messageIds.length }} notices announce one rotation and disagree: none is sent
    </p>
    <p v-for="proof in pending.pendingProofs" :key="proof.sourceEventCid" class="status-line" :title="proof.messageId">
      a new address<template v-if="proof.channel"> of {{ shortDid(proof.channel.peerDid) }}</template> waits for the document that proves it
    </p>
    <p v-if="failure" class="status-line error">{{ failure }}</p>
  </div>
</template>
