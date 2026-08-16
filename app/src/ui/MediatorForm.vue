<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { MEDIATOR_CHOICES, mediatorLabel } from "../core/mediators.js";
import { state } from "../core/store.js";
import { CUSTOM, useMediatorInput } from "./mediator-input.js";

/**
 * The mediator picker: a dropdown of known mediators plus a paste field
 * that takes an OOB invitation URL, a bare mediator URL, or a DID. Used
 * once to name a mediator, and again to move to another — the caller says
 * what the button does; this resolves the choice to a DID and hands it
 * over, showing whatever went wrong.
 */
const props = defineProps<{
  submitLabel: string;
  busyLabel: string;
  /** the mediator in use, if any: marked in the list, not offered first */
  current?: string | null;
  pick: (did: string) => Promise<void>;
}>();

const { choice, pasted, resolving, error: inputError, resolveChoice } = useMediatorInput();
const busy = ref(false);
const pickError = ref<string | null>(null);

const currentLabel = computed(() => (props.current == null ? null : mediatorLabel(props.current)));
// moving: start the dropdown on something other than where we already are
if (currentLabel.value !== null) {
  const other = MEDIATOR_CHOICES.find((c) => c.label !== currentLabel.value);
  if (other !== undefined) {
    choice.value = other.value;
  }
}

// opened with a mediator's invitation link: offer it, do not pick it
watch(
  () => state.pendingMediatorInvitation,
  (url) => {
    if (url !== null) {
      choice.value = CUSTOM;
      pasted.value = url;
      state.pendingMediatorInvitation = null;
    }
  },
  { immediate: true }
);

async function submit() {
  pickError.value = null;
  const did = await resolveChoice();
  if (did === null) {
    return;
  }
  busy.value = true;
  try {
    await props.pick(did);
  } catch (err) {
    pickError.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="rail-form" @submit.prevent="submit">
    <select v-model="choice" class="field">
      <option v-for="c in MEDIATOR_CHOICES" :key="c.value" :value="c.value">
        via {{ c.label }}{{ c.label === currentLabel ? " (current)" : "" }}
      </option>
      <option :value="CUSTOM">via a pasted invitation…</option>
    </select>
    <input
      v-if="choice === CUSTOM"
      v-model="pasted"
      class="field"
      placeholder="invitation URL, mediator URL, or DID"
    />
    <p v-if="pickError || inputError" class="status-line error" style="margin: 0">
      {{ pickError ?? inputError }}
    </p>
    <button class="btn" type="submit" :disabled="busy || resolving">
      {{ busy ? busyLabel : submitLabel }}
    </button>
  </form>
</template>
