/**
 * /api/admin/workstations/downloads — node provisioning artifacts.
 *
 * Surfaces everything an admin needs to bring a new Rhino workstation
 * online: the prebuilt PRISM.Agent payload (zip from .github/workflows/agent.yml),
 * the helper PowerShell install scripts (bundled into the server image
 * from agent/install/), and a per-node `agent-config.json` template
 * pre-filled with the right WSS endpoint.
 *
 * The MSI/zip itself is not checked into the repo — it's produced as an
 * artifact / GitHub Release asset by the agent.yml workflow. The admin
 * pastes the URL into Settings -> Workstation agent -> Download URL once
 * a build is published. Until that's done, the /agent endpoint responds
 * with a structured 404 + remediation hint so the UI can render a
 * "build pending" state instead of a hard error.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../auth/middleware.js';
import { getSetting } from '../db/settings.js';

const INSTALL_DIR = resolve(process.env.AGENT_INSTALL_DIR ?? './agent-install');

/** Bytes of a static asset under AGENT_INSTALL_DIR, or null if missing. */
async function readInstallAsset(name: string): Promise<Buffer | null> {
  const path = resolve(INSTALL_DIR, name);
  if (!path.startsWith(INSTALL_DIR + (process.platform === 'win32' ? '\\' : '/')) && path !== INSTALL_DIR) {
    return null;
  }
  if (!existsSync(path)) return null;
  return readFile(path);
}

/** Compute the WSS URL the agent should use for this server, honouring the
 *  admin override and falling back to the request's host. */
async function resolveAgentWsUrl(reqHost: string | undefined, reqProto: string | undefined): Promise<string> {
  const override = (await getSetting('workstation_agent_ws_url'))?.trim();
  if (override) return override;
  const host = reqHost && reqHost.trim() ? reqHost : 'prism.rebus.industries';
  const scheme = reqProto === 'http' ? 'ws' : 'wss';
  return `${scheme}://${host}/ws/agent`;
}

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  /**
   * GET /agent — meta JSON describing the latest agent build the admin
   * has registered. Returned even when no build URL is set so the UI can
   * render the "build pending" state without a special-case error path.
   */
  app.get('/agent', async (req) => {
    const downloadUrl = (await getSetting('workstation_agent_download_url'))?.trim() || null;
    const version     = (await getSetting('workstation_agent_version'))?.trim()      || null;
    const wsUrl       = await resolveAgentWsUrl(req.hostname, req.protocol);
    return {
      downloadUrl,
      version,
      wsUrl,
      available: !!downloadUrl,
      // Stable hints the UI can surface in the "build pending" state.
      buildSource: {
        workflow: '.github/workflows/agent.yml',
        artifact: 'PRISM.Agent-<tag>.zip',
        howTo: 'Tag a release (vX.Y.Z) or trigger the agent-msi workflow manually, '
             + 'then paste the resulting Release / artifact URL into Settings -> '
             + 'workstation_agent_download_url.',
      },
    };
  });

  /**
   * GET /agent/download — 302 redirect to the configured zip URL. We
   * could proxy the bytes here, but a redirect keeps PRISM out of the
   * upload path and lets GitHub serve at its full bandwidth.
   */
  app.get('/agent/download', async (_req, reply) => {
    const url = (await getSetting('workstation_agent_download_url'))?.trim();
    if (!url) {
      return reply.code(404).send({
        error: 'no agent build configured',
        hint: 'set workstation_agent_download_url in Settings',
      });
    }
    return reply.redirect(url, 302);
  });

  /**
   * GET /install-script[?which=install|uninstall] — returns the bundled
   * PowerShell installer as text/plain; the UI links to it directly with
   * the right Content-Disposition so the browser saves it as install.ps1.
   */
  app.get<{ Querystring: { which?: string } }>('/install-script', async (req, reply) => {
    const which = req.query.which === 'uninstall' ? 'uninstall.ps1' : 'install.ps1';
    const bytes = await readInstallAsset(which);
    if (!bytes) {
      return reply.code(404).send({ error: `${which} not bundled in this server image` });
    }
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${which}"`);
    return bytes;
  });

  /**
   * GET /agent-config?nodeName=...&slots=...&roles=conversion,layering
   * Returns a JSON config the admin can drop into
   * `C:\Program Files\PRISM.Agent\agent-config.json`. We do NOT mint an
   * API key here — the agent currently authenticates by machineId on
   * first connect (see ws/gateway.ts) and the phase-8 enrollment-token
   * flow is still pending. A `TODO: enrollment token` is surfaced in the
   * response so callers know the format will grow a `token` field once
   * that lands.
   */
  app.get<{ Querystring: { nodeName?: string; slots?: string; roles?: string } }>(
    '/agent-config',
    async (req, reply) => {
      const nodeName = (req.query.nodeName ?? '').trim() || 'RB-NEW-NODE';
      const slotsRaw = Number(req.query.slots ?? '2');
      const slots = Number.isFinite(slotsRaw) && slotsRaw > 0 ? Math.floor(slotsRaw) : 2;
      const rolesParam = (req.query.roles ?? 'conversion,layering,receive')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const validRoles = new Set(['conversion', 'layering', 'receive']);
      const roles = rolesParam.filter((r) => validRoles.has(r));
      if (roles.length === 0) roles.push('conversion', 'layering');

      const wsUrl = await resolveAgentWsUrl(req.hostname, req.protocol);

      const config = {
        prismUrl: wsUrl,
        nodeName,
        machineId: 'auto',
        slots,
        roles,
        rhinoExecutablePath: 'C:\\Program Files\\Rhino 8\\System\\Rhino.exe',
        logDir: 'C:\\ProgramData\\PRISM.Agent\\logs',
        // TODO(phase-8): when agent enrollment tokens land, surface
        // a freshly-minted token here so the agent can auth on connect.
      };

      reply.header('content-type', 'application/json; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="agent-config-${nodeName}.json"`);
      return config;
    },
  );
};

export default plugin;
