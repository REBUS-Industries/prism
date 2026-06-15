/**
 * Capture a flat swatch snapshot and upload it as the material list
 * thumbnail (persisted server-side).
 */
import { materialsApi } from '../../shared/api';
import type MaterialPreviewSwatch from '../components/MaterialPreviewSwatch.vue';

export async function uploadMaterialPreviewThumbnail(
  materialId: string,
  materialName: string,
  viewer: InstanceType<typeof MaterialPreviewSwatch> | null,
): Promise<string | null> {
  if (!viewer?.captureSnapshot) return null;
  const dataUrl = await viewer.captureSnapshot();
  if (!dataUrl) return null;

  const blob = await fetch(dataUrl).then((r) => r.blob());
  const safeName = materialName.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'material';
  const file = new File([blob], `${safeName}-preview.png`, { type: 'image/png' });
  const updated = await materialsApi.uploadThumbnail(materialId, file);
  return updated.thumbnailTextureId;
}
