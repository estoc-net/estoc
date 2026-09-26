import { ref } from "vue";

/**
 * A removal a screen offers, made once the person has confirmed it and
 * one at a time. What is to be removed is settled by the caller before
 * the question is put, so that the answer removes what was asked about
 * and nothing that took its place while the question stood. A removal
 * that did not happen leaves its reason in `failed` for the screen to
 * show; the screen stays, and the person can try again.
 */
export function useRemoval() {
  const failed = ref<string | null>(null);
  const busy = ref(false);

  async function remove(question: string, removal: () => Promise<void>): Promise<void> {
    if (busy.value || !confirm(question)) return;
    busy.value = true;
    failed.value = null;
    try {
      await removal();
    } catch (err) {
      failed.value = err instanceof Error ? err.message : String(err);
    } finally {
      busy.value = false;
    }
  }

  return { failed, busy, remove };
}
