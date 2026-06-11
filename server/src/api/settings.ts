/**
 * /api/settings — admin-only key/value store.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getAllSettings, getSetting, setSetting, type SettingKey } from '../db/settings.js';
import {
  loadExternalMaterialsSettingsPublic,
  patchExternalMaterialsSettings,
} from '../settings/externalMaterials.js';
import { requireAdmin } from '../auth/middleware.js';

const SECRET_KEYS = new Set<SettingKey>([
  'orbit_token',
  'orbit_dev_token',
  'gdtf_share_password',
  'fab_epic_refresh_token',
]);

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  // GET /api/settings — list everything (secrets masked)
  app.get('/', async () => {
    const all = await getAllSettings();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) {
      out[k] = SECRET_KEYS.has(k as SettingKey) ? mask(v) : v;
    }
    return { settings: out };
  });

  const externalMaterialsPatchSchema = z.object({
    fab: z.object({
      enabled: z.boolean().optional(),
      epicRefreshToken: z.string().optional(),
      httpProxy: z.string().optional(),
    }).optional(),
    polyhaven: z.object({ enabled: z.boolean().optional() }).optional(),
    ambientcg: z.object({ enabled: z.boolean().optional() }).optional(),
  });

  // GET /api/settings/external-materials — structured provider config (secrets masked)
  app.get('/external-materials', async () => {
    return { settings: await loadExternalMaterialsSettingsPublic() };
  });

  // PATCH /api/settings/external-materials
  app.patch('/external-materials', async (req, reply) => {
    const body = externalMaterialsPatchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body', details: body.error.flatten() });
    const settings = await patchExternalMaterialsSettings(body.data);
    return { ok: true, settings };
  });

  // GET /api/settings/:key
  app.get<{ Params: { key: string } }>('/:key', async (req, reply) => {
    const v = await getSetting(req.params.key as SettingKey);
    if (v === undefined) return reply.code(404).send({ error: 'not set' });
    return { key: req.params.key, value: SECRET_KEYS.has(req.params.key as SettingKey) ? mask(v) : v };
  });

  // PUT /api/settings/:key  body: { value }
  app.put<{ Params: { key: string }; Body: { value: string } }>('/:key', async (req, reply) => {
    const body = z.object({ value: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body' });
    await setSetting(req.params.key as SettingKey, body.data.value);
    return { ok: true };
  });
};

function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 6) return '••••••';
  return value.slice(0, 3) + '••••' + value.slice(-2);
}

export default plugin;
