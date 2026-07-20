/**
 * /api/files — File Library (native CAD / DCC source archives).
 *
 * Separate from Orbit convert / Model Library. Same filename stacks as
 * immutable versions under a **per-project folder** on the LAN share.
 * On-disk layout: `{root}/{projectRel}/{stem}/{filename}` (tip), with prior
 * versions under `{stem}/v{n}/`. Deletes move bytes to `{projectRel}/archive/`.
 * Storage root from Settings `file_library_root` or `${DATA_DIR}/files`.
 * Uploads require `projectId` with a configured relative folder.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  constants,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { requireAuth, requireScope, requireTool } from '../auth/middleware.js';
import { db } from '../db/client.js';
import { fileDocuments, fileLibraryProjectFolders, fileVersions } from '../db/schema.js';
import { getSetting } from '../db/settings.js';

const DATA_DIR = process.env.PRISM_DATA_DIR ?? process.env.DATA_DIR ?? '/data/prism';
const DEFAULT_ROOT = resolve(DATA_DIR, 'files');
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const DEFAULT_EXTS = ['.3dm', '.vwx', '.dwg', '.rvt', '.skp', '.fbx', '.obj', '.zip', '.3ds', '.dae'];
const MAX_NOTES_CHARS = 8000;
/** Reserved folder name under each project File Library root for soft-deleted bytes. */
const ARCHIVE_DIR_NAME = 'archive';

async function resolveLibraryRoot(): Promise<string> {
  const fromSettings = (await getSetting('file_library_root'))?.trim();
  const fromEnv = process.env.FILE_LIBRARY_ROOT?.trim();
  const raw = fromSettings || fromEnv || DEFAULT_ROOT;
  return resolve(raw);
}

async function resolveMaxBytes(): Promise<number> {
  const raw = (await getSetting('file_library_max_bytes'))?.trim()
    || process.env.FILE_LIBRARY_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

async function resolveAllowedExts(): Promise<Set<string>> {
  const raw = (await getSetting('file_library_allowed_exts'))?.trim()
    || process.env.FILE_LIBRARY_ALLOWED_EXTS?.trim();
  const list = (raw ? raw.split(',') : DEFAULT_EXTS)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : `.${s}`));
  return new Set(list.length ? list : DEFAULT_EXTS);
}

function normalizeFilename(name: string): string {
  return basename(name).trim().toLowerCase();
}

/** ASCII-safe name for Content-Disposition headers. */
function sanitiseFilename(input: string): string {
  const base = basename(input).replace(/[\\/]+/g, '_');
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200) || 'file';
}

/**
 * On-disk filename that preserves spaces and common punctuation
 * (e.g. `Test File.3dm`), while stripping path separators and Windows-illegal chars.
 */
function sanitiseDiskName(input: string): string {
  let base = basename(input).replace(/[\\/]+/g, '_').replace(/\0/g, '');
  base = base.replace(/[<>:"|?*\u0000-\u001f]+/g, '_').trim();
  // Windows disallows trailing dots/spaces in final path segment.
  base = base.replace(/[. ]+$/g, '').slice(0, 200);
  return base || 'file';
}

/** Document folder under the project File Library root — stem of the filename. */
function documentFolderName(filename: string): string {
  const disk = sanitiseDiskName(filename);
  let stem = basename(disk, extname(disk)).trim() || 'file';
  stem = stem.slice(0, 200);
  if (stem.toLowerCase() === ARCHIVE_DIR_NAME) {
    stem = `${stem}_file`;
  }
  return stem || 'file';
}

function assertUnderRoot(root: string, candidate: string): string {
  const resolved = resolve(candidate);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error('storage path escapes library root');
  }
  return resolved;
}

/** Normalise a relative folder path (POSIX, no leading slash, no `..`). */
function normaliseRelativePath(input: string): string {
  const raw = input.replace(/\\/g, '/').trim();
  if (!raw || raw === '.') return '';
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new Error('relative path must not contain ..');
  }
  if (parts.some((p) => p.includes('\0'))) {
    throw new Error('invalid path segment');
  }
  return parts.join('/');
}

async function getProjectFolder(projectId: string) {
  const rows = await db
    .select()
    .from(fileLibraryProjectFolders)
    .where(eq(fileLibraryProjectFolders.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

function notesSidecarPath(storagePath: string): string {
  const stem = basename(storagePath, extname(storagePath)) || 'notes';
  return join(dirname(storagePath), `${stem}.txt`);
}

async function resolveProjectRelForDoc(
  doc: typeof fileDocuments.$inferSelect,
): Promise<string | null> {
  if (!doc.projectId) return null;
  const folder = await getProjectFolder(doc.projectId);
  if (!folder?.relativePath) return null;
  try {
    return normaliseRelativePath(folder.relativePath) || null;
  } catch {
    return null;
  }
}

function projectAbs(root: string, projectRel: string | null): string {
  if (!projectRel) return root;
  return assertUnderRoot(root, join(root, ...projectRel.split('/')));
}

async function moveFile(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch {
    // Cross-device / SMB rename can fail — copy then remove.
    await copyFile(src, dest);
    await unlink(src);
  }
}

/**
 * Move a version's on-disk bytes (and optional notes sidecar) into
 * `{projectRoot}/archive/{stem}/v{n}/…`. Updates `storagePath` in DB.
 */
async function archiveVersionFiles(opts: {
  root: string;
  projectRel: string | null;
  version: typeof fileVersions.$inferSelect;
  documentName: string;
}): Promise<string | null> {
  const { root, projectRel, version, documentName } = opts;
  const src = version.storagePath;
  if (!src) return null;

  let srcExists = true;
  try {
    await access(src, constants.F_OK);
  } catch {
    srcExists = false;
  }
  if (!srcExists) return null;

  // Skip if already under an archive folder.
  const normalisedSrc = src.replace(/\\/g, '/').toLowerCase();
  if (normalisedSrc.includes(`/${ARCHIVE_DIR_NAME}/`)) {
    return src;
  }

  const stem = documentFolderName(documentName || version.originalFilename);
  const diskName = sanitiseDiskName(basename(src) || version.originalFilename);
  const projectRoot = projectAbs(root, projectRel);
  const archiveDir = assertUnderRoot(
    root,
    join(projectRoot, ARCHIVE_DIR_NAME, stem, `v${version.versionNumber}`),
  );
  let finalDest = assertUnderRoot(root, join(archiveDir, diskName));
  if (finalDest !== src) {
    try {
      await access(finalDest);
      const stamped = `${basename(diskName, extname(diskName))}_${Date.now()}${extname(diskName)}`;
      finalDest = assertUnderRoot(root, join(archiveDir, stamped));
    } catch {
      /* destination free */
    }
  }

  await moveFile(src, finalDest);

  const sidecarSrc = notesSidecarPath(src);
  try {
    await access(sidecarSrc, constants.F_OK);
    const sidecarDest = assertUnderRoot(root, notesSidecarPath(finalDest));
    await moveFile(sidecarSrc, sidecarDest);
  } catch {
    /* no sidecar */
  }

  await db.update(fileVersions)
    .set({ storagePath: finalDest })
    .where(eq(fileVersions.id, version.id));

  // Best-effort cleanup of empty version / document folders.
  try {
    const verDir = dirname(src);
    const entries = await readdir(verDir);
    if (entries.length === 0) await rm(verDir, { recursive: false }).catch(() => undefined);
    const docDir = dirname(verDir);
    // Only remove if it looks like a document folder (not project root / archive).
    if (basename(docDir).toLowerCase() !== ARCHIVE_DIR_NAME) {
      const left = await readdir(docDir);
      if (left.length === 0) await rm(docDir, { recursive: false }).catch(() => undefined);
    }
  } catch {
    /* ignore */
  }

  return finalDest;
}

/**
 * Move the current tip file aside under `{stem}/v{n}/` before writing a new
 * tip at `{stem}/{filename}`. Keeps prior versions browsable until delete.
 */
/**
 * Move the whole live document folder `{stem}/` into
 * `{projectRoot}/archive/{stem}/` (timestamp suffix on collision).
 * Rewrites `storagePath` for any versions that lived under that folder.
 */
async function archiveDocumentFolder(opts: {
  root: string;
  projectRel: string | null;
  documentName: string;
  versions: Array<typeof fileVersions.$inferSelect>;
}): Promise<boolean> {
  const { root, projectRel, documentName, versions } = opts;
  if (!projectRel) return false;
  const stem = documentFolderName(documentName);
  const projectRoot = projectAbs(root, projectRel);
  const liveDir = assertUnderRoot(root, join(projectRoot, stem));
  try {
    await access(liveDir, constants.F_OK);
  } catch {
    return false;
  }
  const st = await stat(liveDir);
  if (!st.isDirectory()) return false;

  let dest = assertUnderRoot(root, join(projectRoot, ARCHIVE_DIR_NAME, stem));
  try {
    await access(dest);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    dest = assertUnderRoot(root, join(projectRoot, ARCHIVE_DIR_NAME, `${stem}_${stamp}`));
  } catch {
    /* free */
  }

  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(liveDir, dest);
  } catch {
    // Fallback: archive each known version file individually.
    return false;
  }

  const livePrefix = liveDir.endsWith(sep) ? liveDir : liveDir + sep;
  for (const version of versions) {
    const src = version.storagePath;
    if (!src) continue;
    const resolved = resolve(src);
    if (resolved === liveDir || resolved.startsWith(livePrefix)) {
      const relative = resolved.slice(liveDir.length).replace(/^[/\\]+/, '');
      const next = assertUnderRoot(
        root,
        relative ? join(dest, ...relative.split(/[/\\]+/)) : dest,
      );
      await db.update(fileVersions)
        .set({ storagePath: next })
        .where(eq(fileVersions.id, version.id));
    }
  }
  return true;
}

async function retireTipVersion(opts: {
  root: string;
  projectRel: string;
  version: typeof fileVersions.$inferSelect;
  documentName: string;
}): Promise<void> {
  const { root, projectRel, version, documentName } = opts;
  const src = version.storagePath;
  if (!src) return;
  try {
    await access(src, constants.F_OK);
  } catch {
    return;
  }

  const stem = documentFolderName(documentName || version.originalFilename);
  const diskName = sanitiseDiskName(basename(src) || version.originalFilename);
  const liveTipDir = assertUnderRoot(root, join(root, ...projectRel.split('/'), stem));
  const liveTipPath = assertUnderRoot(root, join(liveTipDir, diskName));

  // Only retire when the tip still sits at the human-browsable path.
  if (resolve(src) !== resolve(liveTipPath)) return;

  const histDir = assertUnderRoot(root, join(liveTipDir, `v${version.versionNumber}`));
  let dest = assertUnderRoot(root, join(histDir, diskName));
  try {
    await access(dest);
    dest = assertUnderRoot(
      root,
      join(histDir, `${basename(diskName, extname(diskName))}_${Date.now()}${extname(diskName)}`),
    );
  } catch {
    /* free */
  }

  await moveFile(src, dest);
  const sidecarSrc = notesSidecarPath(src);
  try {
    await access(sidecarSrc, constants.F_OK);
    await moveFile(sidecarSrc, assertUnderRoot(root, notesSidecarPath(dest)));
  } catch {
    /* no sidecar */
  }
  await db.update(fileVersions)
    .set({ storagePath: dest })
    .where(eq(fileVersions.id, version.id));
}

function fieldString(fields: Record<string, unknown>, key: string): string | undefined {
  const raw = fields[key];
  if (!raw || typeof raw !== 'object') return undefined;
  const v = (raw as { value?: unknown }).value;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

async function resolveUploaderLabel(req: FastifyRequest, uploadedBy?: string): Promise<{
  label: string;
  apiKeyId: string | null;
  adminId: string | null;
  source: string;
}> {
  if (uploadedBy) {
    const p = req.principal;
    return {
      label: uploadedBy.slice(0, 256),
      apiKeyId: p?.kind === 'apiKey' ? p.apiKeyId : null,
      adminId: p?.kind === 'adminSession' ? p.adminUserId : null,
      source: p?.kind === 'adminSession' ? 'admin' : 'connector',
    };
  }
  const p = req.principal;
  if (p?.kind === 'adminSession') {
    return { label: p.username, apiKeyId: null, adminId: p.adminUserId, source: 'admin' };
  }
  if (p?.kind === 'apiKey') {
    const name = p.apiKeyName?.trim();
    return {
      label: name || `api:${p.apiKeyId.slice(0, 8)}`,
      apiKeyId: p.apiKeyId,
      adminId: null,
      source: 'connector',
    };
  }
  return { label: 'unknown', apiKeyId: null, adminId: null, source: 'api' };
}

function toVersionPublic(row: typeof fileVersions.$inferSelect) {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    originalFilename: row.originalFilename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    contentHash: row.contentHash,
    source: row.source,
    sourceApp: row.sourceApp,
    uploadedBy: row.uploadedByLabel,
    notes: row.notes ?? null,
    createdAt: row.createdAt.toISOString(),
    downloadUrl: `/api/files/${row.documentId}/versions/${row.id}/download`,
  };
}

function toDocumentSummary(
  doc: typeof fileDocuments.$inferSelect,
  latest: typeof fileVersions.$inferSelect | null,
) {
  return {
    id: doc.id,
    name: doc.name,
    extension: doc.extension,
    projectId: doc.projectId,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    versionCount: doc.versionCount,
    latestVersion: latest ? toVersionPublic(latest) : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.addHook('preHandler', requireTool('files'));

  app.get('/status', { preHandler: [requireScope('files:read')] }, async () => {
    const root = await resolveLibraryRoot();
    let writable = false;
    try {
      await mkdir(root, { recursive: true });
      await access(root, constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    const fromSettings = !!(await getSetting('file_library_root'))?.trim();
    const folderCount = (await db.select().from(fileLibraryProjectFolders)).length;
    return {
      configured: true,
      root,
      writable,
      usingSettingsPath: fromSettings,
      maxBytes: await resolveMaxBytes(),
      allowedExts: [...(await resolveAllowedExts())],
      projectFolderCount: folderCount,
    };
  });

  // ── Browse directories under library root (folder picker) ──────────────
  app.get('/browse', { preHandler: [requireScope('files:read')] }, async (req, reply) => {
    const q = req.query as { path?: string };
    let rel = '';
    try {
      rel = normaliseRelativePath(q.path ?? '');
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const root = await resolveLibraryRoot();
    let abs: string;
    try {
      abs = assertUnderRoot(root, rel ? join(root, ...rel.split('/')) : root);
    } catch {
      return reply.code(400).send({ error: 'path escapes library root' });
    }
    try {
      await access(abs, constants.R_OK);
    } catch {
      return reply.code(404).send({ error: 'path not found', path: rel || '/' });
    }
    const st = await stat(abs);
    if (!st.isDirectory()) {
      return reply.code(400).send({ error: 'path is not a directory' });
    }
    const entries = await readdir(abs, { withFileTypes: true });
    const directories = entries
      .filter((e) => (
        e.isDirectory()
        && !e.name.startsWith('.')
        && e.name.toLowerCase() !== ARCHIVE_DIR_NAME
      ))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map((name) => ({
        name,
        path: rel ? `${rel}/${name}` : name,
      }));
    const parentPath = rel.includes('/')
      ? rel.split('/').slice(0, -1).join('/')
      : (rel ? '' : null);
    return {
      root,
      path: rel,
      parentPath,
      directories,
    };
  });

  // ── Per-project folder mappings ─────────────────────────────────────
  app.get('/project-folders', { preHandler: [requireScope('files:read')] }, async () => {
    const rows = await db
      .select()
      .from(fileLibraryProjectFolders)
      .orderBy(asc(fileLibraryProjectFolders.projectName), asc(fileLibraryProjectFolders.projectId));
    return {
      folders: rows.map((r) => ({
        projectId: r.projectId,
        projectName: r.projectName,
        relativePath: r.relativePath,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });

  app.put<{ Params: { projectId: string } }>('/project-folders/:projectId', {
    preHandler: [requireScope('files:write')],
  }, async (req, reply) => {
    const projectId = decodeURIComponent(req.params.projectId).trim();
    if (!projectId || projectId.length > 128) {
      return reply.code(400).send({ error: 'invalid projectId' });
    }
    const body = z.object({
      relativePath: z.string().min(1).max(2048),
      projectName: z.string().max(512).nullable().optional(),
    }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', detail: body.error.flatten() });
    }
    let rel: string;
    try {
      rel = normaliseRelativePath(body.data.relativePath);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    if (!rel) {
      return reply.code(400).send({ error: 'relativePath required (select a project folder under the share root)' });
    }
    const root = await resolveLibraryRoot();
    let abs: string;
    try {
      abs = assertUnderRoot(root, join(root, ...rel.split('/')));
    } catch {
      return reply.code(400).send({ error: 'path escapes library root' });
    }
    try {
      const st = await stat(abs);
      if (!st.isDirectory()) return reply.code(400).send({ error: 'relativePath is not a directory' });
    } catch {
      return reply.code(400).send({ error: 'relativePath does not exist on the share', path: rel });
    }

    const now = new Date();
    const existing = await getProjectFolder(projectId);
    const row = existing
      ? (await db.update(fileLibraryProjectFolders).set({
          relativePath: rel,
          projectName: body.data.projectName ?? existing.projectName,
          updatedAt: now,
        }).where(eq(fileLibraryProjectFolders.projectId, projectId)).returning())[0]!
      : (await db.insert(fileLibraryProjectFolders).values({
          projectId,
          relativePath: rel,
          projectName: body.data.projectName ?? null,
          createdAt: now,
          updatedAt: now,
        }).returning())[0]!;

    return {
      folder: {
        projectId: row.projectId,
        projectName: row.projectName,
        relativePath: row.relativePath,
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  });

  app.delete<{ Params: { projectId: string } }>('/project-folders/:projectId', {
    preHandler: [requireScope('files:write')],
  }, async (req, reply) => {
    const projectId = decodeURIComponent(req.params.projectId).trim();
    if (!projectId) return reply.code(400).send({ error: 'invalid projectId' });
    await db.delete(fileLibraryProjectFolders).where(eq(fileLibraryProjectFolders.projectId, projectId));
    return reply.code(204).send();
  });

  app.get('/', { preHandler: [requireScope('files:read')] }, async (req) => {
    const q = req.query as { q?: string; ext?: string; projectId?: string; limit?: string; cursor?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const offset = q.cursor ? Math.max(Number(q.cursor) || 0, 0) : 0;

    const conditions = [isNull(fileDocuments.deletedAt)];
    if (q.q?.trim()) conditions.push(ilike(fileDocuments.name, `%${q.q.trim()}%`));
    if (q.ext?.trim()) {
      const ext = q.ext.trim().toLowerCase();
      conditions.push(eq(fileDocuments.extension, ext.startsWith('.') ? ext : `.${ext}`));
    }
    if (q.projectId?.trim()) conditions.push(eq(fileDocuments.projectId, q.projectId.trim()));

    const rows = await db
      .select()
      .from(fileDocuments)
      .where(and(...conditions))
      .orderBy(desc(fileDocuments.updatedAt))
      .limit(limit + 1)
      .offset(offset);

    const page = rows.slice(0, limit);
    const latestIds = page.map((d) => d.latestVersionId).filter((id): id is string => !!id);
    const latestRows = latestIds.length
      ? await db.select().from(fileVersions).where(inArray(fileVersions.id, latestIds))
      : [];
    const latestById = new Map(latestRows.map((v) => [v.id, v]));

    const documents = page.map((d) => toDocumentSummary(d, d.latestVersionId ? latestById.get(d.latestVersionId) ?? null : null));
    return {
      documents,
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  });

  app.get<{ Params: { id: string } }>('/:id', {
    preHandler: [requireScope('files:read')],
  }, async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid id' });
    const docs = await db.select().from(fileDocuments).where(and(eq(fileDocuments.id, id.data), isNull(fileDocuments.deletedAt))).limit(1);
    const doc = docs[0];
    if (!doc) return reply.code(404).send({ error: 'not found' });
    const versions = await db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.documentId, doc.id), isNull(fileVersions.deletedAt)))
      .orderBy(desc(fileVersions.versionNumber));
    return {
      document: {
        ...toDocumentSummary(doc, versions[0] ?? null),
        versions: versions.map(toVersionPublic),
      },
    };
  });

  app.get<{ Params: { id: string; versionId: string } }>('/:id/versions/:versionId/download', {
    preHandler: [requireScope('files:read')],
  }, async (req, reply) => {
    const docId = z.string().uuid().safeParse(req.params.id);
    const verId = z.string().uuid().safeParse(req.params.versionId);
    if (!docId.success || !verId.success) return reply.code(400).send({ error: 'invalid id' });
    const rows = await db.select().from(fileVersions).where(and(
      eq(fileVersions.id, verId.data),
      eq(fileVersions.documentId, docId.data),
      isNull(fileVersions.deletedAt),
    )).limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'not found' });
    try {
      await access(row.storagePath, constants.R_OK);
    } catch {
      return reply.code(404).send({ error: 'file missing on disk' });
    }
    reply.header('Content-Type', row.contentType || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${sanitiseFilename(row.originalFilename)}"`);
    return reply.send(createReadStream(row.storagePath));
  });

  app.get<{ Params: { id: string } }>('/:id/download', {
    preHandler: [requireScope('files:read')],
  }, async (req, reply) => {
    const docId = z.string().uuid().safeParse(req.params.id);
    if (!docId.success) return reply.code(400).send({ error: 'invalid id' });
    const docs = await db.select().from(fileDocuments).where(and(eq(fileDocuments.id, docId.data), isNull(fileDocuments.deletedAt))).limit(1);
    const doc = docs[0];
    if (!doc?.latestVersionId) return reply.code(404).send({ error: 'not found' });
    const rows = await db.select().from(fileVersions).where(and(
      eq(fileVersions.id, doc.latestVersionId),
      isNull(fileVersions.deletedAt),
    )).limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'not found' });
    try {
      await access(row.storagePath, constants.R_OK);
    } catch {
      return reply.code(404).send({ error: 'file missing on disk' });
    }
    reply.header('Content-Type', row.contentType || 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${sanitiseFilename(row.originalFilename)}"`);
    return reply.send(createReadStream(row.storagePath));
  });

  app.post('/', { preHandler: [requireScope('files:write')] }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(415).send({ error: 'multipart/form-data required' });
    const maxBytes = await resolveMaxBytes();
    const allowed = await resolveAllowedExts();
    const root = await resolveLibraryRoot();
    await mkdir(root, { recursive: true });

    const data = await req.file({ limits: { fileSize: maxBytes } });
    if (!data) return reply.code(400).send({ error: 'file required' });

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of data.file) {
      size += chunk.length;
      if (size > maxBytes) {
        return reply.code(413).send({ error: `file exceeds max size (${maxBytes} bytes)` });
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (body.length === 0) return reply.code(400).send({ error: 'empty file' });

    const fields = data.fields as Record<string, unknown>;
    const originalFilename = (fieldString(fields, 'name') || data.filename || 'upload').slice(0, 512);
    const displayName = originalFilename;
    const normalized = normalizeFilename(originalFilename);
    const ext = extname(normalized).toLowerCase() || extname(originalFilename).toLowerCase();
    if (!ext || !allowed.has(ext)) {
      return reply.code(400).send({
        error: `extension not allowed (${ext || 'none'}); allowed: ${[...allowed].join(', ')}`,
      });
    }

    const projectId = fieldString(fields, 'projectId') ?? null;
    if (!projectId) {
      return reply.code(400).send({
        error: 'projectId required — assign a File Library folder for the Orbit project in Admin → Settings → File Library',
      });
    }
    const projectFolder = await getProjectFolder(projectId);
    if (!projectFolder?.relativePath) {
      return reply.code(400).send({
        error: `no File Library folder configured for project ${projectId}`,
        code: 'project_folder_required',
        projectId,
      });
    }
    let projectRel: string;
    try {
      projectRel = normaliseRelativePath(projectFolder.relativePath);
    } catch (err) {
      return reply.code(500).send({ error: `invalid stored project folder: ${(err as Error).message}` });
    }
    if (!projectRel) {
      return reply.code(400).send({
        error: `no File Library folder configured for project ${projectId}`,
        code: 'project_folder_required',
        projectId,
      });
    }

    const sourceApp = fieldString(fields, 'sourceApp') ?? null;
    const uploadedBy = fieldString(fields, 'uploadedBy');
    const notesRaw = fieldString(fields, 'notes');
    const notes = notesRaw ? notesRaw.slice(0, MAX_NOTES_CHARS) : null;
    const tagsRaw = fieldString(fields, 'tags');
    const tags = tagsRaw
      ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 32)
      : [];

    const uploader = await resolveUploaderLabel(req, uploadedBy);
    const contentHash = createHash('sha256').update(body).digest('hex');
    const contentType = data.mimetype || 'application/octet-stream';

    // Find or create document by (projectId, normalised filename).
    let docs = await db.select().from(fileDocuments).where(and(
      eq(fileDocuments.normalizedName, normalized),
      eq(fileDocuments.projectId, projectId),
      isNull(fileDocuments.deletedAt),
    )).limit(1);
    let doc = docs[0];
    if (!doc) {
      const inserted = await db.insert(fileDocuments).values({
        name: displayName,
        normalizedName: normalized,
        extension: ext,
        projectId,
        tags,
        versionCount: 0,
      }).returning();
      doc = inserted[0]!;
    }

    const nextVersion = (doc.versionCount || 0) + 1;
    const versionId = randomUUID();
    const stem = documentFolderName(originalFilename);
    const diskName = sanitiseDiskName(originalFilename);

    // Keep a human-browsable tip at `{stem}/{filename}` (e.g. Test File/Test File.3dm).
    // Prior tip versions move to `{stem}/v{n}/` under the same document folder.
    if (doc.latestVersionId) {
      const prevRows = await db.select().from(fileVersions).where(and(
        eq(fileVersions.id, doc.latestVersionId),
        isNull(fileVersions.deletedAt),
      )).limit(1);
      const prev = prevRows[0];
      if (prev) {
        await retireTipVersion({
          root,
          projectRel,
          version: prev,
          documentName: doc.name || originalFilename,
        });
      }
    }

    // {root}/{projectRel}/{stem}/{filename}
    const absDir = assertUnderRoot(root, join(root, ...projectRel.split('/'), stem));
    await mkdir(absDir, { recursive: true });
    const absPath = assertUnderRoot(root, join(absDir, diskName));
    await writeFile(absPath, body);
    if (notes) {
      const notesPath = assertUnderRoot(root, notesSidecarPath(absPath));
      await writeFile(notesPath, notes, 'utf8');
    }

    const versionRows = await db.insert(fileVersions).values({
      id: versionId,
      documentId: doc.id,
      versionNumber: nextVersion,
      originalFilename,
      contentType,
      sizeBytes: body.length,
      contentHash,
      storagePath: absPath,
      source: uploader.source,
      sourceApp,
      uploadedByLabel: uploader.label,
      notes,
      createdByApiKeyId: uploader.apiKeyId,
      createdByAdminId: uploader.adminId,
    }).returning();
    const version = versionRows[0]!;

    const updatedDocs = await db.update(fileDocuments).set({
      latestVersionId: version.id,
      versionCount: nextVersion,
      name: displayName,
      projectId: projectId ?? doc.projectId,
      tags: tags.length ? tags : doc.tags,
      updatedAt: new Date(),
    }).where(eq(fileDocuments.id, doc.id)).returning();
    const updated = updatedDocs[0]!;

    return reply.code(201).send({
      document: toDocumentSummary(updated, version),
      version: toVersionPublic(version),
    });
  });

  app.patch<{ Params: { id: string } }>('/:id', {
    preHandler: [requireScope('files:write')],
  }, async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid id' });
    const body = z.object({
      name: z.string().min(1).max(512).optional(),
      tags: z.array(z.string()).optional(),
      projectId: z.string().nullable().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body', detail: body.error.flatten() });

    const docs = await db.select().from(fileDocuments).where(and(eq(fileDocuments.id, id.data), isNull(fileDocuments.deletedAt))).limit(1);
    if (!docs[0]) return reply.code(404).send({ error: 'not found' });

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.tags !== undefined) patch.tags = body.data.tags;
    if (body.data.projectId !== undefined) patch.projectId = body.data.projectId;

    const updated = await db.update(fileDocuments).set(patch).where(eq(fileDocuments.id, id.data)).returning();
    const doc = updated[0]!;
    let latest = null;
    if (doc.latestVersionId) {
      const v = await db.select().from(fileVersions).where(eq(fileVersions.id, doc.latestVersionId)).limit(1);
      latest = v[0] ?? null;
    }
    return { document: toDocumentSummary(doc, latest) };
  });

  app.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [requireScope('files:delete')],
  }, async (req, reply) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ error: 'invalid id' });
    const docs = await db.select().from(fileDocuments).where(and(eq(fileDocuments.id, id.data), isNull(fileDocuments.deletedAt))).limit(1);
    const doc = docs[0];
    if (!doc) return reply.code(404).send({ error: 'not found' });

    const root = await resolveLibraryRoot();
    const projectRel = await resolveProjectRelForDoc(doc);
    const versions = await db.select().from(fileVersions).where(and(
      eq(fileVersions.documentId, id.data),
      isNull(fileVersions.deletedAt),
    ));
    let folderArchived = false;
    try {
      folderArchived = await archiveDocumentFolder({
        root,
        projectRel,
        documentName: doc.name,
        versions,
      });
    } catch {
      folderArchived = false;
    }
    // Legacy UUID paths (or rename failure): archive each version file.
    if (!folderArchived) {
      for (const version of versions) {
        try {
          await archiveVersionFiles({
            root,
            projectRel,
            version,
            documentName: doc.name,
          });
        } catch {
          /* best effort — still soft-delete */
        }
      }
    } else {
      // Any versions still outside the moved folder (e.g. old UUID layout).
      const refreshed = await db.select().from(fileVersions).where(and(
        eq(fileVersions.documentId, id.data),
        isNull(fileVersions.deletedAt),
      ));
      for (const version of refreshed) {
        const path = version.storagePath?.replace(/\\/g, '/').toLowerCase() ?? '';
        if (path.includes(`/${ARCHIVE_DIR_NAME}/`)) continue;
        try {
          await archiveVersionFiles({
            root,
            projectRel,
            version,
            documentName: doc.name,
          });
        } catch {
          /* best effort */
        }
      }
    }

    const now = new Date();
    await db.update(fileDocuments).set({ deletedAt: now, updatedAt: now }).where(eq(fileDocuments.id, id.data));
    await db.update(fileVersions).set({ deletedAt: now }).where(and(eq(fileVersions.documentId, id.data), isNull(fileVersions.deletedAt)));
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string; versionId: string } }>('/:id/versions/:versionId', {
    preHandler: [requireScope('files:delete')],
  }, async (req, reply) => {
    const docId = z.string().uuid().safeParse(req.params.id);
    const verId = z.string().uuid().safeParse(req.params.versionId);
    if (!docId.success || !verId.success) return reply.code(400).send({ error: 'invalid id' });
    const docs = await db.select().from(fileDocuments).where(and(
      eq(fileDocuments.id, docId.data),
      isNull(fileDocuments.deletedAt),
    )).limit(1);
    const doc = docs[0];
    if (!doc) return reply.code(404).send({ error: 'not found' });

    const rows = await db.select().from(fileVersions).where(and(
      eq(fileVersions.id, verId.data),
      eq(fileVersions.documentId, docId.data),
      isNull(fileVersions.deletedAt),
    )).limit(1);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'not found' });

    const root = await resolveLibraryRoot();
    const projectRel = await resolveProjectRelForDoc(doc);
    try {
      await archiveVersionFiles({
        root,
        projectRel,
        version: row,
        documentName: doc.name,
      });
    } catch {
      /* best effort */
    }
    await db.update(fileVersions).set({ deletedAt: new Date() }).where(eq(fileVersions.id, row.id));

    const remaining = await db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.documentId, docId.data), isNull(fileVersions.deletedAt)))
      .orderBy(desc(fileVersions.versionNumber));
    const tip = remaining[0] ?? null;
    await db.update(fileDocuments).set({
      latestVersionId: tip?.id ?? null,
      versionCount: remaining.length,
      updatedAt: new Date(),
      deletedAt: remaining.length === 0 ? new Date() : null,
    }).where(eq(fileDocuments.id, docId.data));
    return reply.code(204).send();
  });
};

export default plugin;
