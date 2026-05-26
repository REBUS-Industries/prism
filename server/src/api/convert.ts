/**
 * /api/convert — submit a conversion job.
 *
 * Phase 1: accepts a multipart upload, persists the file under
 * UPLOAD_DIR, inserts a `jobs` row in `queued` state, enqueues into
 * BullMQ. The actual worker that dispatches to an agent comes in
 * Phase 2.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { enqueueConvert } from '../jobs/queue.js';
import { requireAuth } from '../auth/middleware.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/var/lib/prism/uploads';

// Mirror of `RhinoFileOpener.SupportedExtensions` on the agent side
// (PRISM/agent/src/PRISM.Agent/Rhino/RhinoFileOpener.cs). Keep these in
// sync — the server gates uploads, the agent gates the import path.
// `.skp` requires Rhino's SketchUp importer plug-in; we accept the upload
// and let the agent surface a clear `[OBJ-IMPORT]` error if the plug-in
// isn't loaded on the chosen workstation.
// `.dae` and `.3ds` are intentionally excluded: Rhino 8 ships only their
// EXPORT plug-ins (`Export_DAE.rhp`, `export_3DS.rhp`); there is no
// matching FileImport plug-in registered, so accepting the upload would
// just produce an `[OBJ-IMPORT] RhinoApp.RunScript returned false` error
// later in the pipeline.
// `.zip` is the bundle-ingestion format: callers upload an OBJ + .mtl +
// texture set (or any multi-file format) inside a single archive. The
// server stores the .zip untouched and dispatches it to the agent; the
// agent expands it via ZipBundleExtractor before invoking RhinoFileOpener
// so the .mtl / textures resolve relative to the primary geometry file.
const SUPPORTED_EXTS = new Set([
  '.3dm',
  '.dwg', '.dxf',
  '.fbx', '.obj', '.stl', '.ply',
  '.3mf', '.skp',
  '.step', '.stp', '.iges', '.igs',
  '.zip',
]);

// Form fields arrive as strings. `z.coerce.boolean()` is `Boolean(input)` —
// any non-empty string is truthy, so `"false"` coerces to `true`. This made
// every swapYZ submission from the convert UI silently true regardless of
// the checkbox state. Explicit preprocess handles the string forms correctly.
const formBool = () => z.preprocess(
  (v) => (typeof v === 'string' ? v.toLowerCase() === 'true' : v),
  z.boolean(),
);

const submitSchema = z.object({
  projectId:    z.string().min(1),
  modelId:      z.string().min(1),
  modelName:    z.string().optional(),
  orbitTarget:  z.enum(['prod', 'dev']).default('prod'),
  swapYZ:       formBool().optional(),
  quality:      z.enum(['sensible', 'extreme']).optional(),
  callbackUrl:  z.string().url().optional(),
  includedLayers:           z.string().optional(),  // CSV
  includeLayerDescendants:  formBool().optional(),
  // Two-phase flow: when true, the job is first dispatched to a `canLayer`
  // agent that returns the file's layer tree. The job lands in
  // `awaiting_selection`; the caller then POSTs the chosen layers to
  // `/api/jobs/:id/layers` which kicks off the real convert dispatch.
  selectLayers: formBool().optional(),
});

const plugin: FastifyPluginAsync = async (app) => {
  await mkdir(UPLOAD_DIR, { recursive: true }).catch(() => { /* container restart, dir may pre-exist */ });

  app.addHook('preHandler', requireAuth);

  // POST /api/convert/async  (multipart: file + fields)
  app.post('/async', async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: 'multipart/form-data required' });

    const parts = req.parts();
    const fields: Record<string, string> = {};
    let fileName = '';
    let savedPath = '';
    let fileSize = 0;

    for await (const part of parts) {
      if (part.type === 'file') {
        fileName = part.filename;
        const ext = extname(fileName).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) {
          return reply.code(415).send({ error: `unsupported format: ${ext}` });
        }
        const id = randomUUID();
        savedPath = resolve(join(UPLOAD_DIR, `${id}${ext}`));
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        const buf = Buffer.concat(chunks);
        await writeFile(savedPath, buf);
        fileSize = buf.length;
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }

    if (!savedPath) return reply.code(400).send({ error: 'file part missing' });

    const parsed = submitSchema.safeParse(fields);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid fields', issues: parsed.error.issues });

    const preSelectedLayers = parsed.data.includedLayers
      ? parsed.data.includedLayers.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const includeLayerDescendants = parsed.data.includeLayerDescendants ?? false;
    const selectLayers = !!parsed.data.selectLayers;

    const options = {
      swapYZ: !!parsed.data.swapYZ,
      quality: parsed.data.quality ?? 'sensible',
      includedLayers: preSelectedLayers,
      includeLayerDescendants,
    };

    const principal = req.principal!;  // requireAuth guarantees
    const submittedBy =
      principal.kind === 'apiKey'       ? `apikey:${principal.apiKeyId}` :
      principal.kind === 'orbitUser'    ? `orbit:${principal.userId}` :
      /* adminSession */                  `admin:${principal.adminUserId}`;

    const inserted = await db
      .insert(jobs)
      .values({
        format: extname(fileName).toLowerCase(),
        fileName,
        fileSize,
        filePath: savedPath,
        orbitTarget: parsed.data.orbitTarget,
        projectId:   parsed.data.projectId,
        modelId:     parsed.data.modelId,
        modelName:   parsed.data.modelName,
        options,
        selectLayers,
        includedLayers: preSelectedLayers.length ? preSelectedLayers : null,
        includeLayerDescendants,
        callbackUrl: parsed.data.callbackUrl,
        submittedBy,
      })
      .returning();

    const job = inserted[0]!;

    await enqueueConvert({
      jobId: job.id,
      format: job.format,
      fileName: job.fileName,
      filePath: job.filePath,
      orbitTarget: job.orbitTarget as 'prod' | 'dev',
      projectId: job.projectId,
      modelId: job.modelId,
      modelName: job.modelName ?? undefined,
      callbackUrl: job.callbackUrl ?? undefined,
      submittedBy: job.submittedBy ?? undefined,
    });

    return reply.code(202).send({ jobId: job.id, status: job.status });
  });
};

export default plugin;
