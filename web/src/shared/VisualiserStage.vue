<script setup lang="ts">
/**
 * Shared visualiser stage: a Pixel Streaming player plus the
 * single-controller lock UI. Used by both the admin debug viewer and the
 * login-free share-link viewer page.
 *
 * The same stable `viewerId` is used for the player's signalling JWT and
 * the control-channel JWT so the server lines up the seat and the lock.
 * `viewOnly` is driven by the authoritative controller state (you can
 * only drive the viewport while you hold control); the server gate is the
 * real enforcement, this just suppresses the local input wiring.
 */
import { computed, onMounted } from 'vue';
import PixelStreamingPlayer from '../admin/components/PixelStreamingPlayer.vue';
import { useVisualiserControl } from './useVisualiserControl';
import type { VisualiserTurnBundle } from './api';

const props = defineProps<{
  runId: string;
  signallingUrl: string;
  turn?: VisualiserTurnBundle | null;
  viewerId: string;
  /** Mints a signalling JWT with the same viewerId (admin or share-exchange). */
  tokenProvider: () => Promise<string>;
}>();

const control = useVisualiserControl({
  signallingUrl: props.signallingUrl,
  tokenProvider: props.tokenProvider,
});

// You may drive the viewport only while you hold the lock.
const viewOnly = computed(() => !control.youAreController.value);

const statusLabel = computed(() => {
  if (control.youAreController.value) return 'You have control';
  if (control.controllerViewerId.value) return 'Someone else has control';
  return 'No one is in control';
});

onMounted(() => { void control.connect().catch(() => {}); });
</script>

<template>
  <div class="stage">
    <div class="control-bar">
      <span class="ctl-status" :class="{ 'is-controller': control.youAreController.value }">
        {{ statusLabel }}
      </span>
      <template v-if="control.canControl.value">
        <button
          v-if="!control.youAreController.value"
          class="btn btn-primary"
          @click="control.take()"
        >Take control</button>
        <button
          v-else
          class="btn"
          @click="control.release()"
        >Release control</button>
      </template>
      <span v-else class="muted small">View only</span>
    </div>

    <div class="player-shell">
      <PixelStreamingPlayer
        :run-id="runId"
        :signalling-url="signallingUrl"
        :turn="turn ?? null"
        :viewer-id="viewerId"
        :view-only="viewOnly"
        :token-provider="tokenProvider"
      />
    </div>
  </div>
</template>

<style scoped>
.stage { display: flex; flex-direction: column; gap: 8px; flex: 1 1 0; min-height: 0; }
.control-bar {
  display: flex; align-items: center; gap: 12px;
  padding: 6px 10px; border: 1px solid var(--color-border, #ddd);
  border-radius: var(--radius, 8px); background: var(--color-bg-elevated, #f6f6f6);
}
.ctl-status { font-size: 13px; font-weight: 600; color: var(--color-text-muted, #666); }
.ctl-status.is-controller { color: rgb(64,160,96); }
.muted { color: var(--color-text-muted, #666); }
.small { font-size: 12px; }
.player-shell { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
.btn {
  padding: 5px 12px; border-radius: var(--radius, 8px); cursor: pointer;
  border: 1px solid var(--color-border, #ddd); background: var(--color-bg-elevated, #fff);
  color: var(--color-text, #111); font-size: 13px;
}
.btn:hover { background: var(--color-bg, #eee); }
.btn-primary { background: rgb(64,120,200); border-color: rgb(56,108,184); color: #fff; }
.btn-primary:hover { background: rgb(56,108,184); }
</style>
