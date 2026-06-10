<script setup lang="ts">
import { computed, ref } from 'vue';

const props = defineProps<{
  dmxMapping: Record<string, unknown>;
  fixtureName?: string;
  manufacturer?: string;
  /** Hide the page-level title block when embedded in the detail panel. */
  compact?: boolean;
}>();

interface DmxChannel {
  name?: string;
  offset?: string;
  highlight?: string;
  geometry?: string;
  functions?: string;
}

interface DmxMode {
  modeId?: string;
  name?: string;
  footprint?: number;
  channels?: DmxChannel[];
}

const activeModeIdx = ref(0);

const modes = computed<DmxMode[]>(() => {
  const raw = props.dmxMapping?.modes;
  if (!Array.isArray(raw)) return [];
  return raw as DmxMode[];
});

const activeMode = computed(() => modes.value[activeModeIdx.value] ?? null);

const totalChannels = computed(() =>
  modes.value.reduce((sum, m) => sum + (m.footprint ?? m.channels?.length ?? 0), 0),
);

function modeLabel(mode: DmxMode, idx: number): string {
  return mode.name?.trim() || `Mode ${idx + 1}`;
}

function channelRows(mode: DmxMode): Array<{ offset: string; name: string; functions: string; geometry: string }> {
  const channels = mode.channels ?? [];
  return channels.map((ch) => ({
    offset: ch.offset ?? '—',
    name: ch.name ?? '—',
    functions: ch.functions ?? ch.highlight ?? '—',
    geometry: ch.geometry ?? ch.highlight ?? '—',
  }));
}
</script>

<template>
  <div class="dmx-charts">
    <header v-if="fixtureName && !compact" class="dmx-header">
      <h2 class="dmx-title">
        DMX charts
        <span class="dmx-fixture">· {{ manufacturer }} {{ fixtureName }}</span>
      </h2>
      <p v-if="modes.length" class="dmx-sub">
        {{ manufacturer }} · {{ modes.length }} mode{{ modes.length === 1 ? '' : 's' }}
        · {{ totalChannels }} channels total
      </p>
    </header>

    <div v-if="!modes.length" class="muted">No DMX modes parsed.</div>

    <template v-else>
      <div class="mode-tabs-wrap">
        <div class="mode-tabs" role="tablist">
          <button
            v-for="(mode, idx) in modes"
            :key="mode.modeId ?? idx"
            type="button"
            role="tab"
            class="mode-tab"
            :class="{ active: activeModeIdx === idx }"
            :aria-selected="activeModeIdx === idx"
            @click="activeModeIdx = idx"
          >
            <span>{{ modeLabel(mode, idx) }}</span>
            <span class="mode-footprint">{{ mode.footprint ?? mode.channels?.length ?? 0 }}CH</span>
          </button>
        </div>
      </div>

      <div v-if="activeMode" class="mode-panel">
        <div class="mode-panel-head">
          <span>
            {{ modeLabel(activeMode, activeModeIdx) }}
            <span class="muted">· geometry Base</span>
          </span>
          <span class="pill">{{ activeMode.footprint ?? activeMode.channels?.length ?? 0 }} channels</span>
        </div>

        <div class="table-wrap">
          <table class="dmx-table">
            <thead>
              <tr>
                <th>Offset</th>
                <th>Attribute / channel</th>
                <th>Functions / DMX range</th>
                <th>Geometry</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in channelRows(activeMode)" :key="i">
                <td class="mono">{{ row.offset }}</td>
                <td>{{ row.name }}</td>
                <td class="functions">{{ row.functions }}</td>
                <td class="muted">{{ row.geometry }}</td>
              </tr>
              <tr v-if="!channelRows(activeMode).length">
                <td colspan="4" class="muted empty-row">
                  {{ activeMode.footprint ?? 0 }} channels — detailed mapping not extracted from GDTF.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dmx-charts { display: flex; flex-direction: column; gap: 12px; }
.dmx-header { margin-bottom: 4px; }
.dmx-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.dmx-fixture { font-weight: 500; color: var(--color-text-muted); }
.dmx-sub { margin: 4px 0 0; font-size: 13px; color: var(--color-text-muted); }

.mode-tabs-wrap {
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-elevated);
}
.mode-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mode-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.mode-tab:hover:not(.active) { background: var(--color-bg-hover); }
.mode-tab.active {
  background: var(--orbit-primary);
  border-color: var(--orbit-primary);
  color: #fff;
}
.mode-footprint {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.1);
  font-size: 11px;
  font-weight: 600;
}
.mode-tab.active .mode-footprint { background: rgba(255, 255, 255, 0.25); }

.mode-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--color-bg);
  box-shadow: var(--shadow-1);
}
.mode-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
  font-weight: 600;
}
.table-wrap { overflow-x: auto; }
.dmx-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.dmx-table th {
  text-align: left;
  padding: 10px 14px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-subtle);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
}
.dmx-table td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}
.dmx-table tbody tr:nth-child(even) td { background: var(--color-bg-elevated); }
.dmx-table tr:last-child td { border-bottom: none; }
.mono { font-family: var(--font-mono); font-size: 12px; }
.functions { font-size: 12px; color: var(--color-text-muted); line-height: 1.45; }
.empty-row { text-align: center; padding: 24px !important; }
</style>
