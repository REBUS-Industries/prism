import { ref } from 'vue';
import { accessApi, type PrismTool } from '../shared/api';

const allowedTools = ref<PrismTool[] | null>(null);
const isPrismAdmin = ref(false);
const loaded = ref(false);

export function useToolAccess() {
  async function refreshToolAccess() {
    try {
      const me = await accessApi.me();
      allowedTools.value = me.tools;
      isPrismAdmin.value = me.isPrismAdmin;
    } catch {
      allowedTools.value = null;
      isPrismAdmin.value = false;
    } finally {
      loaded.value = true;
    }
  }

  function canUseTool(tool: PrismTool): boolean {
    if (isPrismAdmin.value) return true;
    if (!allowedTools.value) return true;
    return allowedTools.value.includes(tool);
  }

  return { allowedTools, isPrismAdmin, loaded, refreshToolAccess, canUseTool };
}
