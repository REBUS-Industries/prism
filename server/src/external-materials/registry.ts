/**
 * Registry of configured external material providers.
 */
import type { ExternalMaterialProvider, ExternalMaterialSource } from './types.js';
import { ambientcgProvider } from './ambientcg.js';
import { fabProvider } from './fab.js';
import { polyhavenProvider } from './polyhaven.js';

const providers: ExternalMaterialProvider[] = [fabProvider, polyhavenProvider, ambientcgProvider];

/** Sync runtime `enabled` flags from admin settings (DB + env fallbacks). */
export function applyProviderEnabledFromSettings(enabled: Record<ExternalMaterialSource, boolean>): void {
  fabProvider.enabled = enabled.fab;
  polyhavenProvider.enabled = enabled.polyhaven;
  ambientcgProvider.enabled = enabled.ambientcg;
}

export function listExternalMaterialProviders(): ExternalMaterialProvider[] {
  return providers;
}

export function getExternalMaterialProvider(source: string): ExternalMaterialProvider | null {
  return providers.find((p) => p.id === source) ?? null;
}

export function enabledExternalMaterialSources(): ExternalMaterialSource[] {
  return providers.filter((p) => p.enabled).map((p) => p.id);
}

export function providerLabels(): Record<ExternalMaterialSource, string> {
  return Object.fromEntries(providers.map((p) => [p.id, p.label])) as Record<ExternalMaterialSource, string>;
}
