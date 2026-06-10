<script setup lang="ts">
/**
 * Create / edit / recolour / reorder / delete the fixture-category palette.
 * Rendered inside the Settings → "Fixture Types" modal. All mutations go
 * through the Pinia store so the library list stripes, the type dropdown, and
 * the detail panel pick up changes immediately.
 */
import { onMounted, ref } from 'vue';
import { useFixtureTypesStore } from '../stores/fixtureTypes';
import Icon from '../../shared/Icon.vue';
import type { ApiError, FixtureCategoryConfig } from '../../shared/api';

const store = useFixtureTypesStore();

const newLabel = ref('');
const newColor = ref('#3b82f6');
const adding = ref(false);
const busyId = ref<string | null>(null);
const error = ref<string | null>(null);

onMounted(() => { void store.reload().catch(() => { /* surfaced via store.error */ }); });

function clearError(): void { error.value = null; }

async function addCategory(): Promise<void> {
  const label = newLabel.value.trim();
  if (!label) return;
  adding.value = true;
  error.value = null;
  try {
    await store.create(label, newColor.value);
    newLabel.value = '';
  } catch (e) {
    error.value = (e as ApiError).message ?? 'failed to add fixture type';
  } finally {
    adding.value = false;
  }
}

async function commitColor(cat: FixtureCategoryConfig, value: string): Promise<void> {
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) || value === cat.color) return;
  busyId.value = cat.id;
  error.value = null;
  try {
    await store.update(cat.id, { color: value });
  } catch (e) {
    error.value = (e as ApiError).message ?? 'failed to update colour';
  } finally {
    busyId.value = null;
  }
}

async function commitLabel(cat: FixtureCategoryConfig, value: string): Promise<void> {
  const label = value.trim();
  if (!label || label === cat.label) return;
  busyId.value = cat.id;
  error.value = null;
  try {
    await store.update(cat.id, { label });
  } catch (e) {
    error.value = (e as ApiError).message ?? 'failed to rename fixture type';
  } finally {
    busyId.value = null;
  }
}

async function move(index: number, dir: -1 | 1): Promise<void> {
  const list = store.categories;
  const target = index + dir;
  if (target < 0 || target >= list.length) return;
  const ids = list.map((c) => c.id);
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  busyId.value = list[index]!.id;
  error.value = null;
  try {
    await store.reorder(ids);
  } catch (e) {
    error.value = (e as ApiError).message ?? 'failed to reorder';
  } finally {
    busyId.value = null;
  }
}

async function removeCategory(cat: FixtureCategoryConfig): Promise<void> {
  error.value = null;
  busyId.value = cat.id;
  try {
    await store.remove(cat.id, false);
  } catch (e) {
    const err = e as ApiError;
    if (err.status === 409) {
      const n = (err.body as { inUseCount?: number } | undefined)?.inUseCount ?? 0;
      const ok = window.confirm(
        `${n} fixture${n === 1 ? '' : 's'} still use "${cat.label}". ` +
        `Reassign them to Unassigned and delete this type?`,
      );
      if (ok) {
        try {
          await store.remove(cat.id, true);
        } catch (e2) {
          error.value = (e2 as ApiError).message ?? 'failed to delete fixture type';
        }
      }
    } else {
      error.value = err.message ?? 'failed to delete fixture type';
    }
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <div class="ftm">
    <p class="ftm-intro muted">
      These types drive the colour stripe in the fixture library, the type
      dropdown, and the detail panel. A fixture's type is stored as its first
      tag. <strong>Unassigned</strong> is the default and can't be removed.
    </p>

    <div v-if="error" class="error-box mb-sm">{{ error }}</div>
    <div v-else-if="store.error" class="error-box mb-sm">{{ store.error }}</div>

    <ul class="type-list">
      <li v-for="(cat, i) in store.categories" :key="cat.id" class="type-row" :class="{ busy: busyId === cat.id }">
        <div class="reorder">
          <button
            type="button"
            class="reorder-btn"
            title="Move up"
            :disabled="i === 0 || busyId !== null"
            @click="move(i, -1)"
          ><Icon name="keyboard_arrow_up" :size="14" /></button>
          <button
            type="button"
            class="reorder-btn"
            title="Move down"
            :disabled="i === store.categories.length - 1 || busyId !== null"
            @click="move(i, 1)"
          ><Icon name="keyboard_arrow_down" :size="14" /></button>
        </div>

        <label class="swatch" :style="{ background: cat.color }" :title="cat.color">
          <input
            type="color"
            class="swatch-input"
            :value="cat.color"
            :disabled="busyId !== null"
            @change="commitColor(cat, ($event.target as HTMLInputElement).value)"
          />
        </label>

        <input
          class="label-input"
          :value="cat.label"
          :disabled="cat.isDefault || busyId !== null"
          :title="cat.isDefault ? 'The default type cannot be renamed' : 'Rename'"
          @change="commitLabel(cat, ($event.target as HTMLInputElement).value)"
          @keyup.enter="($event.target as HTMLInputElement).blur()"
        />

        <span v-if="cat.isDefault" class="default-pill">Default</span>

        <button
          type="button"
          class="del-btn"
          :disabled="cat.isDefault || busyId !== null"
          :title="cat.isDefault ? 'The default type cannot be deleted' : 'Delete'"
          @click="removeCategory(cat)"
        ><Icon name="delete" :size="16" /></button>
      </li>
    </ul>

    <div class="add-row">
      <label class="swatch" :style="{ background: newColor }" :title="newColor">
        <input type="color" class="swatch-input" v-model="newColor" />
      </label>
      <input
        class="label-input"
        v-model="newLabel"
        placeholder="New type name (e.g. Mover)"
        maxlength="64"
        @input="clearError"
        @keyup.enter="addCategory"
      />
      <button class="primary add-btn" :disabled="!newLabel.trim() || adding" @click="addCategory">
        <Icon name="add" :size="16" />{{ adding ? 'Adding…' : 'Add type' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ftm { display: flex; flex-direction: column; gap: 12px; }
.ftm-intro { margin: 0; font-size: 12px; line-height: 1.45; }

.type-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.type-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg);
}
.type-row.busy { opacity: 0.6; }

.reorder { display: flex; flex-direction: column; gap: 1px; }
.reorder-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 17px;
  min-height: 0;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-bg-elevated);
  color: var(--color-text-muted);
  line-height: 1;
  cursor: pointer;
}
.reorder-btn:hover:not(:disabled) { color: var(--orbit-primary); border-color: var(--orbit-primary); }
.reorder-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.swatch {
  position: relative;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid rgba(0, 0, 0, 0.2);
  cursor: pointer;
  overflow: hidden;
}
.swatch-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 0;
  margin: 0;
  border: none;
  opacity: 0;
  cursor: pointer;
}

.label-input {
  flex: 1;
  min-width: 0;
  min-height: 34px;
  padding: 6px 10px;
  font-size: 13px;
}
.label-input:disabled { opacity: 0.7; cursor: default; }

.default-pill {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-bg-hover);
  color: var(--color-text-muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.del-btn {
  flex-shrink: 0;
  width: 32px;
  min-height: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 4px);
  background: var(--color-bg-elevated);
  font-size: 13px;
  cursor: pointer;
}
.del-btn:hover:not(:disabled) { border-color: var(--color-error); color: var(--color-error); }
.del-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.add-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border);
}
.add-btn { flex-shrink: 0; }
</style>
