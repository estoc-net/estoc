<script setup lang="ts">
import { ref } from "vue";

import { explainedRestore } from "../core/store.js";

/**
 * Shown over a vault restored from a backup until the person says they
 * have read it. Until then the daemon refuses what the person would
 * send: a message, accepting an invitation, a rotation, and sending
 * again or completing by hand. Receiving goes on underneath, with the
 * acknowledgements it answers by itself, and steps that send nothing,
 * such as cancelling, stay open.
 */
const busy = ref(false);
const failure = ref<string | null>(null);

async function understood() {
  busy.value = true;
  try {
    await explainedRestore();
  } catch (err) {
    failure.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="hollow invited chat-block" data-restore-notice>
    <div class="hollow-card" style="width: 100%">
      <div class="eyebrow">Restored from a backup</div>
      <p>
        This vault is the backup as it was taken, and nothing after. The DIDs
        you minted since, the addresses your contacts moved to since, and what
        tied old addresses to new ones are not in it, and the seed alone does
        not bring them back.
      </p>
      <p>
        So mail sent to an address of yours this vault has never heard of, or
        from a contact under an address it cannot trace, is discarded on
        arrival, even where that address was confirmed before. The rail lists
        what was turned away and why. If this vault and another copy both
        rotate a DID from here, your contact sees two successors and the
        conversation has no current channel until one of you starts a fresh
        one. Importing a newer backup closes the gap; failing that, a new
        invitation does.
      </p>
      <p class="fine">
        Messages the backup holds as unsent are not sent on their own: each
        waits under “Left to do by hand”. The backup file itself is readable
        by anyone who has it: the passphrase seals the seed, not the history.
      </p>
      <p v-if="failure" class="status-line error">{{ failure }}</p>
      <button class="btn" :disabled="busy" data-restore-understood @click="understood">I understand, open sending</button>
    </div>
  </div>
</template>
