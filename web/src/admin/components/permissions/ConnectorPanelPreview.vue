<script setup lang="ts">
/**
 * Live mock of the REBUS Connector action bar driven by invite-key
 * allowedFunctions — matches connector capability derivation.
 */
import { computed } from 'vue';
import type { ConnectorFunction } from '../../../shared/api';

const props = defineProps<{
  allowedFunctions: readonly ConnectorFunction[];
  /** Compact mode for the permissions inspector aside. */
  compact?: boolean;
}>();

const set = computed(() => new Set(props.allowedFunctions));

const canSend = computed(() => set.value.has('send'));
const canReceive = computed(() => set.value.has('receive'));
const canListProjects = computed(() => set.value.has('list_projects'));
/** Independent of receive — must be granted explicitly. */
const canUseLibrary = computed(() => set.value.has('use_library'));
const canUseInFile = computed(() => set.value.has('use_infile'));
const isSendOnly = computed(() => canSend.value && !canReceive.value);

const visibleButtons = computed(() => {
  const buttons: { id: string; label: string; kind: 'send' | 'recv' | 'neutral' | 'library' }[] = [];
  if (canSend.value) buttons.push({ id: 'send', label: '+ Send', kind: 'send' });
  if (canReceive.value) buttons.push({ id: 'recv', label: '+ Receive', kind: 'recv' });
  if (canUseInFile.value) buttons.push({ id: 'infile', label: 'In File', kind: 'neutral' });
  if (canUseLibrary.value) buttons.push({ id: 'library', label: 'Library', kind: 'library' });
  return buttons;
});

const emptyHint = computed(() => {
  if (canSend.value && canReceive.value) return 'Use + Send or + Receive to get started.';
  if (canReceive.value) return 'Use + Receive to get started.';
  if (canSend.value) return 'Use + Send to upload models.';
  if (visibleButtons.value.length) return 'Surfaces unlocked by granted functions.';
  return 'No panel actions for this function set.';
});
</script>

<template>
  <div
    class="connector-preview"
    :class="{
      'connector-preview--compact': compact,
      'connector-preview--lite': isSendOnly,
    }"
    role="img"
    :aria-label="`Connector preview: ${visibleButtons.map((b) => b.label).join(', ') || 'no actions'}`"
  >
    <div class="connector-preview__chrome">
      <div class="connector-preview__header">
        <div class="connector-preview__brand">
          <span class="connector-preview__mark" aria-hidden="true" />
          <div class="connector-preview__titles">
            <span class="connector-preview__wordmark">REBUS</span>
            <span class="connector-preview__sub">Connector</span>
          </div>
        </div>
        <span class="connector-preview__mode">
          {{ isSendOnly ? 'Send-only' : canReceive ? 'Send + Receive' : 'Custom' }}
        </span>
      </div>

      <div class="connector-preview__account">
        <span class="connector-preview__account-name">Collaborator session</span>
        <span class="connector-preview__pill">invite key</span>
      </div>

      <div class="connector-preview__actions">
        <span
          v-for="btn in visibleButtons"
          :key="btn.id"
          class="connector-preview__btn"
          :class="`connector-preview__btn--${btn.kind}`"
        >{{ btn.label }}</span>
        <span v-if="!visibleButtons.length" class="connector-preview__none">No action buttons</span>
      </div>

      <div class="connector-preview__body">
        <p>{{ emptyHint }}</p>
        <p class="connector-preview__meta">
          {{ canListProjects ? 'Project picker enabled' : 'Project picker hidden (no list_projects)' }}
        </p>
      </div>
    </div>
    <p class="connector-preview__caption">
      What the collaborator sees after signing in with this invite key.
    </p>
  </div>
</template>

<style scoped>
.connector-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.connector-preview__chrome {
  border: 1px solid color-mix(in srgb, var(--color-border, #334) 80%, #000);
  border-radius: 8px;
  overflow: hidden;
  background: #1a1d24;
  color: #e8eaed;
  font-family: ui-sans-serif, system-ui, sans-serif;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
.connector-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  background: linear-gradient(180deg, #22262f 0%, #1a1d24 100%);
  border-bottom: 1px solid #2c313c;
}
.connector-preview__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.connector-preview__mark {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: #f97316;
  flex-shrink: 0;
}
.connector-preview__titles {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  min-width: 0;
}
.connector-preview__wordmark {
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.06em;
}
.connector-preview__sub {
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #9aa3b2;
}
.connector-preview__mode {
  font-size: 10px;
  color: #9aa3b2;
  white-space: nowrap;
}
.connector-preview--lite .connector-preview__mode {
  color: #fb923c;
}
.connector-preview__account {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #2c313c;
  font-size: 11px;
}
.connector-preview__account-name { color: #c5cad3; }
.connector-preview__pill {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: 2px 6px;
  border-radius: 4px;
  background: #2c313c;
  color: #9aa3b2;
}
.connector-preview__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid #2c313c;
  background: #151820;
  min-height: 40px;
  align-items: center;
}
.connector-preview__btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 9px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
}
.connector-preview__btn--send {
  background: #2563eb;
  color: #fff;
}
.connector-preview__btn--recv {
  background: #059669;
  color: #fff;
}
.connector-preview__btn--neutral {
  background: #374151;
  color: #e5e7eb;
}
.connector-preview__btn--library {
  background: #7c3aed;
  color: #fff;
}
.connector-preview__none {
  font-size: 11px;
  color: #6b7280;
  font-style: italic;
}
.connector-preview__body {
  padding: 18px 12px;
  text-align: center;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
}
.connector-preview__body p {
  margin: 0;
  font-size: 11px;
  color: #8b93a2;
  line-height: 1.4;
}
.connector-preview__meta {
  font-size: 10px !important;
  color: #6b7280 !important;
}
.connector-preview__caption {
  margin: 0;
  font-size: 11px;
  color: var(--color-text-muted, #6b7280);
  line-height: 1.4;
}
.connector-preview__caption code {
  font-size: 10px;
}
.connector-preview--compact .connector-preview__body {
  padding: 12px;
  min-height: 44px;
}
.connector-preview--compact .connector-preview__mark {
  width: 22px;
  height: 22px;
}
</style>
