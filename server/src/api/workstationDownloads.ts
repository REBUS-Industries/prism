/**
 * /api/admin/workstations/downloads — node provisioning artifacts.
 *
 * Surfaces the prebuilt PRISM.Agent installer that admins download to
 * bring a new Rhino workstation online. As of agent v0.1.30 the
 * canonical artifact is the Inno Setup wizard installer
 * (`PRISM.Agent-Setup-vX.Y.Z.exe`), which embeds `install.ps1` /
 * `uninstall.ps1` and prompts for `prismUrl` / `nodeName` / `slots`
 * during setup -- so the legacy per-node `agent-config.json` template
 * and standalone PowerShell script downloads are no longer needed.
 *
 * Agent version resolution queries every known release location on each
 * request (no server-side cache) and picks the highest semver:
 *   - REBUS-Industries/prism-agent (primary)
 *   - REBUS-Industries/prism (monorepo fallback when agent-msi cannot
 *     publish to prism-agent)
 *   - DB settings `workstation_agent_version` /
 *     `workstation_agent_download_url` (CI / admin pin — participates in
 *     the max-semver pick, not only when GitHub is unreachable)
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../auth/middleware.js';
import { getSetting } from '../db/settings.js';

/** Primary agent repo; legacy `REBUS-ORBIT/prism-agent` redirects here. */
const AGENT_RELEASE_REPOS = [
  'REBUS-Industries/prism-agent',
  'REBUS-Industries/prism',
] as const;

// Preference order: the Inno Setup wizard .exe is the user-facing
// install artifact; the multi-file zip is kept as a fallback for older
// agents whose in-app self-update path still grabs the .zip directly.
const SETUP_EXE_PATTERN = /^PRISM\.Agent-Setup-.+\.exe$/;
const ZIP_ASSET_PATTERN = /^PRISM\.Agent-.+\.zip$/;

interface AgentReleaseCandidate {
  version: string;
  downloadUrl: string;
  releasesPageUrl: string;
  source: string;
}

function parseSemver(tag: string): number[] {
  const core = tag.trim().replace(/^v/i, '').split('+')[0]?.split('-')[0] ?? '';
  const parts = core.split('.').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return [];
  return parts;
}

/** Returns -1 if a<b, 0 if equal, 1 if a>b. Unparseable tags sort last. */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.length === 0 && pb.length === 0) return 0;
  if (pa.length === 0) return -1;
  if (pb.length === 0) return 1;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

function pickInstallerAsset(assets: { name: string; browser_download_url: string }[]) {
  return (
    assets.find((a) => SETUP_EXE_PATTERN.test(a.name)) ??
    assets.find((a) => ZIP_ASSET_PATTERN.test(a.name))
  );
}

async function fetchAgentReleaseFromRepo(repo: string): Promise<AgentReleaseCandidate | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'PRISM-Server/1.0',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(8000),
        redirect: 'follow',
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      tag_name: string;
      html_url?: string;
      assets: { name: string; browser_download_url: string }[];
    };
    const asset = pickInstallerAsset(json.assets ?? []);
    if (!asset) return null;
    const tag = json.tag_name.trim();
    return {
      version: tag,
      downloadUrl: asset.browser_download_url,
      releasesPageUrl: json.html_url ?? `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
      source: `github:${repo}`,
    };
  } catch {
    return null;
  }
}

async function fetchDbAgentRelease(): Promise<AgentReleaseCandidate | null> {
  const version = (await getSetting('workstation_agent_version'))?.trim();
  const downloadUrl = (await getSetting('workstation_agent_download_url'))?.trim();
  if (!version || !downloadUrl) return null;
  let releasesPageUrl = `https://github.com/REBUS-Industries/prism-agent/releases/tag/${encodeURIComponent(version)}`;
  try {
    const parsed = new URL(downloadUrl);
    const match = parsed.pathname.match(
      /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\//,
    );
    if (match?.[1] && match[2] && match[3]) {
      releasesPageUrl = `https://github.com/${match[1]}/${match[2]}/releases/tag/${encodeURIComponent(match[3])}`;
    }
  } catch {
    // Keep default releasesPageUrl.
  }
  return {
    version,
    downloadUrl,
    releasesPageUrl,
    source: 'db',
  };
}

/** Query GitHub + DB and return the highest semver with a download URL. */
async function resolveLatestAgentRelease(): Promise<AgentReleaseCandidate | null> {
  const candidates: AgentReleaseCandidate[] = [];
  for (const repo of AGENT_RELEASE_REPOS) {
    const info = await fetchAgentReleaseFromRepo(repo);
    if (info) candidates.push(info);
  }
  const dbInfo = await fetchDbAgentRelease();
  if (dbInfo) candidates.push(dbInfo);

  let best: AgentReleaseCandidate | null = null;
  for (const c of candidates) {
    if (!best || compareSemver(c.version, best.version) > 0) best = c;
  }
  return best;
}

/** Compute the WSS URL the agent should use for this server, honouring the
 *  admin override and falling back to the request's host. Caddy fronts the
 *  prod deployment and terminates TLS, so we must look at x-forwarded-proto
 *  (and x-forwarded-host) before falling back to Fastify's direct values. */
async function resolveAgentWsUrl(req: {
  hostname?: string;
  protocol?: string;
  headers: Record<string, string | string[] | undefined>;
}): Promise<string> {
  const override = (await getSetting('workstation_agent_ws_url'))?.trim();
  if (override) return override;
  const xfHost  = pickFirstHeader(req.headers['x-forwarded-host']);
  const xfProto = pickFirstHeader(req.headers['x-forwarded-proto']);
  const host = (xfHost ?? req.hostname ?? '').trim() || 'prism.rebus.industries';
  const proto = (xfProto ?? req.protocol ?? '').trim();
  const scheme = proto === 'http' ? 'ws' : 'wss';
  return `${scheme}://${host}/ws/agent`;
}

function pickFirstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  if (typeof value === 'string') return value.split(',')[0]?.trim();
  return undefined;
}

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  /**
   * GET /agent — meta JSON describing the latest agent build.
   *
   * Queries REBUS-Industries/prism-agent, REBUS-Industries/prism, and DB
   * settings; picks the highest semver. Prefers the `.exe` setup wrapper;
   * `.zip` is used only when a release has no `.exe` yet.
   */
  app.get('/agent', async (req) => {
    const latest = await resolveLatestAgentRelease();
    const wsUrl = await resolveAgentWsUrl(req);
    return {
      downloadUrl: latest?.downloadUrl ?? null,
      version: latest?.version ?? null,
      releasesPageUrl: latest?.releasesPageUrl ?? null,
      wsUrl,
      available: !!latest?.downloadUrl,
      buildSource: {
        workflow: '.github/workflows/agent.yml',
        artifact: 'PRISM.Agent-Setup-<tag>.exe',
        howTo: 'Tag a release (vX.Y.Z) or trigger the agent-msi workflow manually.',
      },
    };
  });

  /**
   * GET /agent/download — 302 redirect to the latest installer URL.
   * Uses the same multi-source max-semver resolution as `/agent`.
   */
  app.get('/agent/download', async (_req, reply) => {
    const latest = await resolveLatestAgentRelease();
    const url = latest?.downloadUrl ?? null;
    if (!url) {
      return reply.code(404).send({
        error: 'no agent build available',
        hint: 'push a vX.Y.Z tag to trigger the agent-msi workflow',
      });
    }
    return reply.redirect(url, 302);
  });
};

export default plugin;
