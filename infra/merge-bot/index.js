/**
 * PRISM Merge Bot
 *
 * /prism-merge          → opens modal with live repo dropdown + open PR list
 * /prism-merge check    → opens modal to check PR status (no merge)
 * /prism-merge check 42 → report mergeability + CI for a PR (open or merged)
 * /prism-merge 42       → direct merge (agent shorthand)
 * /prism-merge repo#42  → direct merge in another REBUS-Industries repo
 * /prism-merge pin      → post a pinned Merge button to the channel
 *

 * /portal-app-promote   -> merge portal-app dev -> master (Firebase prod)
 * Interactions handled at POST /slack/interact.
 * Events (App Home) handled at POST /slack/events.
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs/promises');
const path    = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const { SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GITHUB_TOKEN } = process.env;

const DEFAULT_REPO = 'REBUS-Industries/prism';

const PORTAL_APP_REPO = 'REBUS-Industries/portal-app';
let portalPromoteBusy = false;
const PORT = 3456;
const STATE_FILE = process.env.STATE_FILE || '/data/state.json';
const CI_WATCH_MINUTES = 20;
// If none of a repo's watched deploy workflows have started within this window
// after merge, the changed paths didn't trigger a deploy (e.g. agent-only,
// infra-only, or ci-only PRs). Report "merged, nothing to deploy" instead of
// waiting the full CI_WATCH_MINUTES and posting a misleading timeout.
const NO_DEPLOY_GRACE_MS = 150_000;

// --- Network + worker safety -------------------------------------------------
// A merge must never be blocked forever by a stalled network call. Every GitHub /
// Slack request is bounded by a timeout, and each active job is bounded by an
// absolute ceiling, so the single FIFO worker always advances the queue. This
// guards against undici leaving fetch() permanently unsettled when a keep-alive
// socket is silently dropped (no error, no resolution) - which wedged the queue.
const GH_REQUEST_TIMEOUT_MS = Number(process.env.GH_REQUEST_TIMEOUT_MS ?? 30_000);
const SLACK_REQUEST_TIMEOUT_MS = Number(process.env.SLACK_REQUEST_TIMEOUT_MS ?? 15_000);
const JOB_HARD_TIMEOUT_MS = Number(process.env.JOB_HARD_TIMEOUT_MINUTES ?? 45) * 60_000;

// ── Auto-update / rebase-before-merge ──────────────────────────────────────────
// Before merging we bring the PR branch up to date with its base (main) so a
// merge can never land stale code or silently drop concurrent commits that
// reached main since the PR was opened/approved. We use GitHub's "Update branch"
// API (it merges the latest base INTO the head branch) rather than a
// force-pushed rebase: it never rewrites the contributor's history, never drops
// commits, and lets required CI re-run against the real merged result before we
// merge. If the update can't be done cleanly (conflict) or post-update checks
// fail / time out, we ABORT and ask a human to resolve it — we never force.
const AUTO_UPDATE_ENABLED = (process.env.AUTO_UPDATE_BRANCH ?? 'true').toLowerCase() !== 'false';
// Final merge method GitHub uses once the branch is up to date and green.
// 'merge' (default) keeps current behaviour; 'squash' / 'rebase' also valid.
const MERGE_METHOD = (process.env.MERGE_METHOD ?? 'merge').toLowerCase();
// How long to wait for required checks to pass after updating the branch.
const UPDATE_CHECKS_TIMEOUT_MINUTES = Number(process.env.UPDATE_CHECKS_TIMEOUT_MINUTES ?? 15);
const UPDATE_CHECKS_POLL_SECONDS = Number(process.env.UPDATE_CHECKS_POLL_SECONDS ?? 15);
// Cap re-updates when main keeps moving under us so a busy main can't loop the
// bot forever; after this we abort and ask for a retry.
const UPDATE_MAX_CYCLES = Number(process.env.UPDATE_MAX_CYCLES ?? 5);
const UPDATE_CHECKS_TIMEOUT_MS = UPDATE_CHECKS_TIMEOUT_MINUTES * 60_000;
const UPDATE_CHECKS_POLL_MS = UPDATE_CHECKS_POLL_SECONDS * 1_000;
// After the head moves to a fresh commit, give required checks this long to
// register before treating a "blocked" state as a (non-check) protection block.
const BLOCKED_CHECKS_GRACE_MS = 60_000;

const REPOS = [
  { label: 'prism (web / server)',      value: 'REBUS-Industries/prism' },
  { label: 'prism-fixtures-service',    value: 'REBUS-Industries/prism-fixtures-service' },
  { label: 'prism-models-service',      value: 'REBUS-Industries/prism-models-service' },
  { label: 'prism-permissions-service', value: 'REBUS-Industries/prism-permissions-service' },
  { label: 'prism-materials-service',   value: 'REBUS-Industries/prism-materials-service' },
  { label: 'prism-visualiser-service',  value: 'REBUS-Industries/prism-visualiser-service' },
  { label: 'prism-agent-service',       value: 'REBUS-Industries/prism-agent-service' },
  { label: 'prism-agent',               value: 'REBUS-Industries/prism-agent' },
  { label: 'prism-server-polyrepo',     value: 'REBUS-Industries/prism-server-polyrepo' },
  { label: 'orbit-connectors',          value: 'REBUS-Industries/orbit-connectors' },
  { label: 'orbit-ue-template',         value: 'REBUS-Industries/orbit-ue-template' },
  { label: 'orbit-server',              value: 'REBUS-Industries/orbit-server' },
  { label: 'orbit-sdk',                 value: 'REBUS-Industries/orbit-sdk' },
  { label: 'portal-app',                value: 'REBUS-Industries/portal-app' },
];

/** Per-repo CI workflows to watch after merge. crossRepo = deploy step on another repo. */
const REPO_CI = {
  'REBUS-Industries/prism': {
    workflows: ['web-image', 'server-image'],
    deploysToDev: true,
  },
  'REBUS-Industries/prism-fixtures-service': {
    workflows: ['fixtures-image'],
    crossRepo: [{ repo: 'REBUS-Industries/prism', workflows: ['deploy-dev-service'] }],
    deploysToDev: true,
    requiresPrCi: false,
  },
  'REBUS-Industries/prism-models-service': {
    workflows: ['models-image'],
    crossRepo: [{ repo: 'REBUS-Industries/prism', workflows: ['deploy-dev-service'] }],
    deploysToDev: true,
    requiresPrCi: false,
  },
  'REBUS-Industries/prism-permissions-service': {
    workflows: ['permissions-image'],
    crossRepo: [{ repo: 'REBUS-Industries/prism', workflows: ['deploy-dev-service'] }],
    deploysToDev: true,
    requiresPrCi: false,
  },
  'REBUS-Industries/prism-materials-service': {
    workflows: ['materials-image'],
    crossRepo: [{ repo: 'REBUS-Industries/prism', workflows: ['deploy-dev-service'] }],
    deploysToDev: true,
    requiresPrCi: false,
  },
  'REBUS-Industries/prism-visualiser-service': {
    workflows: ['visualiser-image'],
    crossRepo: [{ repo: 'REBUS-Industries/prism', workflows: ['deploy-dev-service'] }],
    deploysToDev: true,
  },
  'REBUS-Industries/prism-agent-service': {
    workflows: ['agent-image'],
    crossRepo: [{ repo: 'REBUS-Industries/prism', workflows: ['deploy-dev-service'] }],
    deploysToDev: true,
  },
  'REBUS-Industries/prism-server-polyrepo': {
    workflows: ['server-image'],
    crossRepo: [{ repo: 'REBUS-Industries/prism', workflows: ['deploy-dev-service'] }],
    deploysToDev: true,
  },
  'REBUS-Industries/orbit-connectors': {
    workflows: ['Build & Test'],
    deploysToDev: false,
  },
  'REBUS-Industries/orbit-ue-template': {
    workflows: ['release'],
    deploysToDev: false,
  },
  'REBUS-Industries/orbit-server': {
    workflows: ['Deploy ORBIT Server'],
    deploysToDev: false,
  },
  'REBUS-Industries/orbit-sdk': {
    workflows: ['Build & Test SDK'],
    deploysToDev: false,
  },
  'REBUS-Industries/portal-app': {
    workflows: ['Deploy portal-dev VM'],
    deployBranch: 'dev',
    deploysToDev: true,
    deployTarget: 'portal-dev',
  },
};

function repoCiConfig(repo) {
  return REPO_CI[repo] ?? { workflows: [], crossRepo: [], deploysToDev: false };
}

// ─── Merge queue (one active merge, rest FIFO) ────────────────────────────────

const queue = [];
let active = null;
let workerBusy = false;

function serializeJob(job) {
  if (!job) return null;
  return {
    repo: job.repo,
    prNumber: job.prNumber,
    userName: job.userName,
    channelId: job.channelId,
    label: job.label,
    title: job.title,
    startedAt: job.startedAt,
    enqueuedAt: job.enqueuedAt,
    phase: job.phase ?? 'merging',
    ciStartIso: job.ciStartIso ?? null,
    mergedPosted: !!job.mergedPosted,
  };
}

async function persistState() {
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    active: serializeJob(active),
    queue: queue.map(serializeJob),
  };
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.rename(tmp, STATE_FILE);
  } catch (err) {
    console.error('persistState failed:', err);
  }
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.active) active = data.active;
    if (Array.isArray(data.queue)) queue.splice(0, queue.length, ...data.queue);
    console.log(`Loaded state: active=${active?.label ?? 'none'} queue=${queue.length}`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('loadState failed:', err);
  }
}

async function resumeOnStartup() {
  if (!active && queue.length === 0) return;
  console.log(`Resuming interrupted work: active=${active?.label ?? 'none'} queue=${queue.length}`);
  if (active?.channelId) {
    await postToSlack(
      active.channelId,
      `:arrows_counterclockwise: Merge bot restarted — resuming *${active.label}* (${active.phase ?? 'merging'})…`,
    );
  }
  runWorker().catch(err => console.error('resume worker error:', err));
}

async function runWorker() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    while (active) {
      try {
        await withHardTimeout(runActiveJob(active), JOB_HARD_TIMEOUT_MS, `job ${active.label}`);
      } catch (err) {
        console.error(`runActiveJob abandoned (${active?.label}):`, err?.message || err);
        try {
          await postToSlack(active.channelId, `:warning: Stopped waiting on *${active.label}* (${err?.message || 'internal timeout'}). Advancing the merge queue.`);
        } catch (postErr) {
          console.error('advance-notice post failed:', postErr?.message || postErr);
        }
      }
      active = null;
      await persistState();

      if (queue.length === 0) break;

      const next = queue.shift();
      active = { ...next, startedAt: Date.now(), phase: 'merging', ciStartIso: null, mergedPosted: false };
      await persistState();
      console.log(`Starting queued merge: ${next.label} by ${next.userName}`);
      await postToSlack(
        next.channelId,
        `:arrow_forward: Starting queued merge ${next.label}: _${next.title}_ (${next.userName})`,
      );
    }
  } finally {
    workerBusy = false;
  }
}

function isReserved(repo, prNumber) {
  if (active?.repo === repo && active?.prNumber === prNumber) return true;
  return queue.some(j => j.repo === repo && j.prNumber === prNumber);
}

function isDuplicate(repo, prNumber) {
  return isReserved(repo, prNumber);
}

function filterSelectablePRs(allPRs) {
  return allPRs.filter(pr => !isReserved(pr._repo, pr.number));
}

function queueStatusText() {
  if (active && queue.length > 0) {
    const age = Math.round((Date.now() - active.startedAt) / 1000 / 60);
    return `:hourglass: Merging *${active.label}* by ${active.userName} (${age}m ago) — *${queue.length}* queued behind it.`;
  }
  if (active) {
    const age = Math.round((Date.now() - active.startedAt) / 1000 / 60);
    return `:hourglass: Merging *${active.label}* by ${active.userName} (${age}m ago).`;
  }
  if (queue.length > 0) {
    return `:clipboard: *${queue.length}* merge(s) queued — ready to start.`;
  }
  return ':white_check_mark: Idle — ready to merge.';
}

// ─── Slack API helpers ────────────────────────────────────────────────────────

// Resolve or reject within `ms`, so a stuck await (e.g. a fetch whose socket was
// silently dropped) can never block the caller - or the merge worker - forever.
function withHardTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s hard timeout`)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// fetch() bounded by an AbortSignal timeout. On any failure/timeout we resolve to
// a non-ok, Response-like shim so callers that branch on `res.ok` treat it as a
// transient miss (retry/continue) instead of throwing or hanging.
async function fetchJsonSafe(url, opts, timeoutMs, label) {
  try {
    return await fetch(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    console.error(`${label} request failed:`, err?.message || err);
    return { ok: false, status: 0, _failed: true, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
  }
}

async function slackApi(method, body) {
  const res = await fetchJsonSafe(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, SLACK_REQUEST_TIMEOUT_MS, `Slack ${method}`);
  const data = await res.json().catch(() => ({ ok: false, error: 'bad_json' }));
  if (!data.ok) console.error(`Slack ${method} failed:`, JSON.stringify(data));
  return data;
}

const postToSlack = (channel, text) => slackApi('chat.postMessage', { channel, text });

// ─── GitHub API helpers ───────────────────────────────────────────────────────

const GH = (path, opts = {}) => fetchJsonSafe(`https://api.github.com${path}`, {
  ...opts,
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers ?? {}),
  },
}, GH_REQUEST_TIMEOUT_MS, `GitHub ${path}`);

async function getOpenPRs(repo) {
  const res = await GH(`/repos/${repo}/pulls?state=open&per_page=50&sort=updated&direction=desc`);
  if (!res.ok) return [];
  return res.json();
}

async function getPRInfo(repo, prNumber) {
  const res = await GH(`/repos/${repo}/pulls/${prNumber}`);
  if (!res.ok) return null;
  return res.json();
}

async function mergePR(repo, prNumber, mergeMethod = MERGE_METHOD) {
  const res = await GH(`/repos/${repo}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: mergeMethod }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    message: body.message ?? '',
    errors: body.errors ?? [],
  };
}

/** How many commits the PR head is behind its base (0 = up to date with base). */
async function getBehindBy(repo, pr) {
  const base = pr?.base?.ref;
  const headSha = pr?.head?.sha;
  if (!base || !headSha) return 0;
  const res = await GH(`/repos/${repo}/compare/${encodeURIComponent(base)}...${headSha}`);
  if (!res.ok) {
    // Compare can fail for cross-fork heads — fall back to GitHub's own signal.
    return pr.mergeable_state === 'behind' ? 1 : 0;
  }
  const body = await res.json().catch(() => ({}));
  return body.behind_by ?? 0;
}

/**
 * Merge the latest base into the PR head branch — the "Update branch" button.
 * Non-destructive: adds a merge commit, never rewrites or force-pushes history.
 * Returns 202 on success (the update runs asynchronously), 422 on conflict or
 * stale expected_head_sha.
 */
async function updatePrBranch(repo, prNumber, expectedHeadSha) {
  const res = await GH(`/repos/${repo}/pulls/${prNumber}/update-branch`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(expectedHeadSha ? { expected_head_sha: expectedHeadSha } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, message: body.message ?? '' };
}

/**
 * Convert a draft PR to "ready for review" via the GitHub GraphQL API.
 * The REST PATCH /pulls/:number does not officially support toggling draft
 * status, so we use the markPullRequestReadyForReview GraphQL mutation.
 */
async function markPRReady(repo, prNumber) {
  // Fetch the node_id required by the GraphQL mutation.
  const prRes = await GH(`/repos/${repo}/pulls/${prNumber}`);
  const pr = await prRes.json().catch(() => ({}));
  const nodeId = pr.node_id;
  if (!nodeId) return { ok: false, message: 'Could not fetch PR node_id for GraphQL call' };

  const gqlRes = await fetchJsonSafe('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}',
      variables: { id: nodeId },
    }),
  }, GH_REQUEST_TIMEOUT_MS, 'GitHub GraphQL markPRReady');

  const body = await gqlRes.json().catch(() => ({}));
  if (body.errors?.length) return { ok: false, message: body.errors.map(e => e.message).join('; ') };
  if (!gqlRes.ok) return { ok: false, message: `GraphQL HTTP ${gqlRes.status}` };
  return { ok: true };
}

const MERGE_STATE_HELP = {
  dirty: 'Merge conflicts with the base branch — rebase onto origin/main, resolve conflicts, push, then retry.',
  blocked: 'Blocked by branch protection (required reviews, status checks, or other rules).',
  behind: 'Head branch is behind the base branch — update the branch or rebase onto origin/main.',
  unknown: 'GitHub has not finished computing mergeability — wait a minute and retry.',
};

async function getMergeFailureDetails(repo, prNumber, mergeAttempt = {}) {
  const lines = [];

  if (mergeAttempt.message) lines.push(`GitHub: ${mergeAttempt.message}`);
  if (mergeAttempt.status) lines.push(`HTTP ${mergeAttempt.status}`);
  for (const err of mergeAttempt.errors ?? []) {
    if (typeof err === 'string') lines.push(err);
    else if (err?.message) lines.push(err.message);
    else lines.push(JSON.stringify(err));
  }

  const pr = await getPRInfo(repo, prNumber);
  if (!pr) {
    lines.push(`Could not load PR #${prNumber} from ${repo}.`);
    return lines.join('\n');
  }

  lines.push(`title: ${pr.title}`);
  lines.push(`head: ${pr.head?.ref ?? '?'} (${pr.head?.sha?.slice(0, 7) ?? '?'})`);
  lines.push(`mergeable: ${pr.mergeable}`);
  lines.push(`mergeable_state: ${pr.mergeable_state}`);
  if (MERGE_STATE_HELP[pr.mergeable_state]) lines.push(MERGE_STATE_HELP[pr.mergeable_state]);

  if (pr.mergeable_state === 'dirty' && repo === DEFAULT_REPO) {
    lines.push('Common PRISM conflict zones: web/src/shared/api.ts, web/src/admin/App.vue');
  }

  const checkLines = await getCommitCheckFailures(repo, pr.head?.sha);
  lines.push(...checkLines);

  return lines.filter(Boolean).join('\n');
}

async function getCommitCheckFailures(repo, sha) {
  if (!sha) return [];
  const lines = [];

  const checksRes = await GH(`/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=30`);
  if (checksRes.ok) {
    const body = await checksRes.json().catch(() => ({}));
    const checks = body.check_runs ?? [];
    for (const check of checks.filter(c => c.conclusion === 'failure' || c.conclusion === 'cancelled' || c.conclusion === 'timed_out')) {
      lines.push(`check ${check.conclusion}: ${check.name}`);
      if (check.output?.title) lines.push(`  ${check.output.title}`);
      if (check.output?.summary) lines.push(`  ${check.output.summary.split('\n').slice(0, 3).join('\n  ')}`);
    }
    for (const check of checks.filter(c => c.status !== 'completed')) {
      lines.push(`check pending: ${check.name}`);
    }
  }

  const statusRes = await GH(`/repos/${repo}/commits/${sha}/status`);
  if (statusRes.ok) {
    const status = await statusRes.json();
    if (status.state !== 'success') lines.push(`combined status: ${status.state}`);
    for (const s of (status.statuses ?? []).filter(s => s.state === 'failure' || s.state === 'error')) {
      lines.push(`status ${s.state}: ${s.context}${s.description ? ` — ${s.description}` : ''}`);
    }
  }

  return lines;
}

/** Tally check-runs + commit statuses on a SHA into pending / failed / total counts. */
async function getHeadCheckSummary(repo, sha) {
  const summary = { total: 0, pending: 0, failed: [] };
  if (!sha) return summary;

  const checksRes = await GH(`/repos/${repo}/commits/${sha}/check-runs?filter=latest&per_page=100`);
  if (checksRes.ok) {
    const body = await checksRes.json().catch(() => ({}));
    for (const c of body.check_runs ?? []) {
      summary.total++;
      if (c.status !== 'completed') summary.pending++;
      else if (['failure', 'cancelled', 'timed_out', 'action_required', 'stale'].includes(c.conclusion)) summary.failed.push(`${c.name}=${c.conclusion}`);
    }
  }

  const statusRes = await GH(`/repos/${repo}/commits/${sha}/status`);
  if (statusRes.ok) {
    const status = await statusRes.json().catch(() => ({}));
    for (const s of status.statuses ?? []) {
      summary.total++;
      if (s.state === 'pending') summary.pending++;
      else if (s.state === 'failure' || s.state === 'error') summary.failed.push(`${s.context}=${s.state}`);
    }
  }

  return summary;
}

async function getDeployCiSnapshot(repo, afterIso) {
  const config = repoCiConfig(repo);
  const lines = [];
  const watchList = config.workflows?.length ? config.workflows.join(', ') : 'none configured';
  const deployBranch = config.deployBranch ?? 'main';

  const primary = await getWorkflowBatch(repo, afterIso, config.workflows, deployBranch);
  lines.push(`*${repo.replace('REBUS-Industries/', '')}* workflows (${watchList}): ${primary.detail || 'no runs yet'}`);

  if (!primary.started) {
    lines.push('_No matching workflow runs since merge._');
  } else if (primary.pending) {
    lines.push(':hourglass: Deploy CI still running.');
  } else if (primary.failedRun) {
    lines.push(':x: Deploy CI failed.');
    const errors = await safeGetRunFailureSummary(repo, primary.failedRun);
    if (errors) lines.push(formatErrorBlock(errors));
    if (primary.failedRun.html_url) lines.push(`<${primary.failedRun.html_url}|View failed run>`);
  } else {
    lines.push(':white_check_mark: Deploy CI passed.');
    if (primary.runs[0]?.html_url) lines.push(`<${primary.runs[0].html_url}|View CI run>`);
  }

  for (const cross of config.crossRepo ?? []) {
    const crossBranch = repoCiConfig(cross.repo).deployBranch ?? 'main';
    const crossBatch = await getWorkflowBatch(cross.repo, afterIso, cross.workflows, crossBranch);
    const crossWatch = cross.workflows.join(', ');
    lines.push(`${cross.repo.replace('REBUS-Industries/', '')} (${crossWatch}): ${crossBatch.detail || 'no runs yet'}`);
    if (crossBatch.pending) lines.push(':hourglass: Cross-repo deploy still running.');
    else if (crossBatch.failedRun) lines.push(':x: Cross-repo deploy failed.');
    else if (crossBatch.started) lines.push(':white_check_mark: Cross-repo deploy passed.');
  }

  return lines.join('\n');
}

async function buildPrCheckReport(repo, prNumber) {
  const pr = await getPRInfo(repo, prNumber);
  if (!pr) {
    return { ok: false, text: `:x: PR ${prLabel(repo, prNumber)} not found in ${repo}.` };
  }

  const label = prLabel(repo, prNumber);
  const url = prUrl(repo, prNumber);
  const lines = [
    `*${label}* — _${pr.title}_`,
    `@${pr.user?.login ?? '?'} · \`${pr.head?.ref ?? '?'}\` → \`${pr.base?.ref ?? 'main'}\``,
    `State: *${pr.state}* · mergeable: \`${pr.mergeable}\` · \`${pr.mergeable_state}\``,
    `<${url}|View PR>`,
  ];

  if (pr.state === 'open') {
    if (MERGE_STATE_HELP[pr.mergeable_state]) lines.push(MERGE_STATE_HELP[pr.mergeable_state]);
    const checkLines = await getCommitCheckFailures(repo, pr.head?.sha);
    lines.push('', '*Checks on head:*');
    if (checkLines.length) lines.push(...checkLines);
    else lines.push('_No failing or pending checks on head._');
    if (isReserved(repo, prNumber)) {
      const slot = active?.repo === repo && active?.prNumber === prNumber ? 'merging' : 'queued';
      lines.push('', `:information_source: This PR is currently ${slot} in the merge bot.`);
    }
  }

  if (pr.merged_at) {
    lines.push('', '*Post-merge deploy CI:*');
    lines.push(await getDeployCiSnapshot(repo, pr.merged_at));
  } else if (pr.state === 'closed') {
    lines.push('', '_PR was closed without merging._');
  }

  return { ok: true, text: lines.join('\n') };
}

async function checkPR(repo, prNumber, userName, channelId, res, isModal = false) {
  const label = prLabel(repo, prNumber);
  const report = await buildPrCheckReport(repo, prNumber);
  const text = report.ok
    ? `:mag: *@${userName}* checked ${label}:\n${report.text}`
    : report.text;

  if (isModal) {
    res.json({ response_action: 'clear' });
    await postToSlack(channelId, text);
  } else {
    res.json({ response_type: 'in_channel', text });
  }
}

async function pollDeploys(repo, afterIso, maxMinutes = CI_WATCH_MINUTES) {
  const config = repoCiConfig(repo);
  const deployBranch = config.deployBranch ?? 'main';
  const elapsedMs = Date.now() - new Date(afterIso).getTime();
  const remainingMs = Math.max(0, maxMinutes * 60_000 - elapsedMs);
  const deadline = Date.now() + remainingMs;
  let firstPass = true;

  while (firstPass || Date.now() < deadline) {
    if (!firstPass && Date.now() < deadline) await sleep(15_000);
    firstPass = false;

    const primary = await getWorkflowBatch(repo, afterIso, config.workflows, deployBranch);
    if (!primary.started) {
      // No watched workflow has appeared. Triggered runs register within
      // seconds, so after the grace window this means the merge's changed paths
      // didn't trigger any deploy workflow — report success rather than hang.
      if (config.workflows?.length && Date.now() - new Date(afterIso).getTime() > NO_DEPLOY_GRACE_MS) {
        return { conclusion: 'no_deploy', url: null, detail: 'no deploy workflow triggered for changed files', errors: '' };
      }
      continue;
    }
    if (primary.pending) continue;
    if (primary.failedRun) {
      const errors = await safeGetRunFailureSummary(repo, primary.failedRun);
      return failResult(primary.failedRun, primary.detail, errors);
    }

    let crossPending = false;
    for (const cross of config.crossRepo ?? []) {
      const crossBranch = repoCiConfig(cross.repo).deployBranch ?? 'main';
      const crossBatch = await getWorkflowBatch(cross.repo, afterIso, cross.workflows, crossBranch);
      if (!crossBatch.started) {
        // Cross-repo deploy has not appeared. After the grace window, accept that
        // repository_dispatch did not fire (broken or not configured) and skip.
        const elapsed = Date.now() - new Date(afterIso).getTime();
        if (elapsed > NO_DEPLOY_GRACE_MS) continue; // skip this cross-repo requirement
        crossPending = true;
        break;
      }
      if (crossBatch.pending) {
        crossPending = true;
        break;
      }
      if (crossBatch.failedRun) {
        const errors = await safeGetRunFailureSummary(cross.repo, crossBatch.failedRun);
        return failResult(crossBatch.failedRun, crossBatch.detail, errors);
      }
    }
    if (crossPending) continue;

    return {
      conclusion: 'success',
      url: primary.runs[0]?.html_url ?? null,
      detail: primary.detail,
      errors: '',
    };
  }

  // On timeout, report anything we can see in-flight or failed.
  const primary = await getWorkflowBatch(repo, afterIso, config.workflows, deployBranch);
  if (primary.failedRun) {
    const errors = await safeGetRunFailureSummary(repo, primary.failedRun);
    return failResult(primary.failedRun, primary.detail, errors);
  }
  return { conclusion: 'timeout', url: primary.runs[0]?.html_url ?? null, detail: primary.detail, errors: buildTimeoutHelp(repo, config) };
}

function buildTimeoutHelp(repo, config) {
  const lines = [`Repo: ${repo}`];
  if (config.workflows?.length) lines.push(`Watching workflows: ${config.workflows.join(', ')}`);
  else lines.push('No CI workflows configured for this repo.');
  for (const cross of config.crossRepo ?? []) {
    lines.push(`Also watching ${cross.repo}: ${cross.workflows.join(', ')}`);
  }
  lines.push('CI may still be running, or workflow names may need updating in the merge bot.');
  return lines.join('\n');
}

async function getWorkflowBatch(repo, afterIso, workflowNames, deployBranch = 'main') {
  const watch = new Set(workflowNames);
  if (watch.size === 0) {
    return { started: true, pending: false, runs: [], failedRun: null, detail: 'no workflows configured' };
  }

  const res = await GH(`/repos/${repo}/actions/runs?per_page=30&branch=${encodeURIComponent(deployBranch)}`);
  if (!res.ok) return { started: false, pending: true, runs: [], failedRun: null, detail: '' };

  const body = await res.json().catch(() => ({}));
  const runs = body.workflow_runs ?? [];
  const recent = runs.filter(r => r.created_at >= afterIso && watch.has(r.name));
  if (recent.length === 0) return { started: false, pending: true, runs: [], failedRun: null, detail: '' };

  if (recent.some(r => r.status !== 'completed')) {
    return { started: true, pending: true, runs: recent, failedRun: null, detail: summarizeRuns(recent) };
  }

  const latestByName = new Map();
  for (const r of recent) latestByName.set(r.name, r);
  const latest = [...latestByName.values()];
  const failedRun = latest.find(r => r.conclusion !== 'success') ?? null;
  return {
    started: true,
    pending: false,
    runs: latest,
    failedRun,
    detail: summarizeRuns(latest),
  };
}

function summarizeRuns(runs) {
  return runs.map(r => `${r.name}=${r.conclusion ?? r.status}`).join(', ');
}

function failResult(run, detail, errors) {
  return {
    conclusion: 'failure',
    url: run.html_url,
    detail,
    errors,
  };
}

/** Pull annotation + check-run output for agent-friendly CI failure text. */
async function getRunFailureSummary(repo, run) {
  if (!run?.id) return 'CI failed (no run details available).';

  const lines = [];

  if (run.name) lines.push(`${run.name} (${run.conclusion ?? 'failed'})`);

  const jobsRes = await GH(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=20`);
  if (jobsRes.ok) {
    const body = await jobsRes.json().catch(() => ({}));
    for (const job of (body.jobs ?? []).filter(j => j.conclusion === 'failure')) {
      lines.push(`job: ${job.name}`);
      for (const step of (job.steps ?? []).filter(s => s.conclusion === 'failure')) {
        lines.push(`  step failed: ${step.name}`);
      }
    }
  }

  if (run.head_sha) {
    const checksRes = await GH(`/repos/${repo}/commits/${run.head_sha}/check-runs?filter=latest&per_page=20`);
    if (checksRes.ok) {
      const body = await checksRes.json().catch(() => ({}));
      for (const check of (body.check_runs ?? []).filter(c => c.conclusion === 'failure')) {
        if (check.output?.title) lines.push(check.output.title);
        if (check.output?.summary) lines.push(check.output.summary.split('\n').slice(0, 5).join('\n'));
        const annRes = await GH(`/repos/${repo}/check-runs/${check.id}/annotations`);
        if (annRes.ok) {
          const annBody = await annRes.json().catch(() => ({}));
          for (const ann of (annBody.annotations ?? []).filter(a => a.annotation_level === 'failure').slice(0, 12)) {
            const loc = ann.path ? `${ann.path}${ann.start_line ? `:${ann.start_line}` : ''}` : 'log';
            lines.push(`${loc}: ${ann.message}`);
          }
        }
      }
    }
  }

  if (lines.length === 0) {
    lines.push(`Workflow run failed (${run.conclusion ?? 'unknown'}).`);
    if (run.html_url) lines.push(run.html_url);
  }

  return truncateForSlack(lines.filter(Boolean).join('\n'), 2800);
}

async function safeGetRunFailureSummary(repo, run) {
  try {
    return await getRunFailureSummary(repo, run);
  } catch (err) {
    console.error('getRunFailureSummary failed:', err);
    const link = run?.html_url ? `\n${run.html_url}` : '';
    return `Could not fetch CI failure details (${err.message}).${link}`;
  }
}

function truncateForSlack(text, maxLen) {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 20)}\n… (truncated)`;
}

function formatErrorBlock(text) {
  if (!text) return '';
  return `\n\`\`\`\n${truncateForSlack(text, 2800)}\n\`\`\``;
}

function formatFailureMessage(headline, detailText, url = null, linkLabel = 'View PR') {
  const link = url ? ` <${url}|${linkLabel}>` : '';
  return `:x: ${headline}${link}${formatErrorBlock(detailText)}`;
}

function formatCiResultMessage(label, result, deploysToDev, pullUrl = null, deployTarget = null) {
  const ciLink = result.url ? ` <${result.url}|View CI run>` : '';
  const prLink = pullUrl ? ` <${pullUrl}|View PR>` : '';
  const detail = result.detail ? ` (${result.detail})` : '';

  if (result.conclusion === 'success') {
    const done = deploysToDev ? `is deployed to ${deployTarget ?? 'prism'}` : 'CI passed on main';
    const successPrLink = pullUrl ? ` <${pullUrl}|View PR>` : '';
    return `:white_check_mark: *${label} ${done}.*${detail}${ciLink}${successPrLink}`;
  }

  if (result.conclusion === 'no_deploy') {
    const successPrLink = pullUrl ? ` <${pullUrl}|View PR>` : '';
    return `:white_check_mark: *${label} merged.* No deploy workflow ran for the changed files — nothing to deploy.${successPrLink}`;
  }

  if (result.conclusion === 'failure') {
    return formatFailureMessage(`*${label} merged but CI failed.*${detail}${ciLink}${prLink}`, result.errors);
  }

  if (result.conclusion === 'timeout') {
    const timeoutDetail = result.errors
      ? result.errors
      : `No completed CI workflows detected within ${CI_WATCH_MINUTES} minutes. Check GitHub Actions manually.`;
    return formatFailureMessage(`*${label} merged but CI did not finish within ${CI_WATCH_MINUTES} minutes.*${detail}${ciLink}${prLink}`, timeoutDetail);
  }

  return formatFailureMessage(`*${label} merged but CI ended with ${result.conclusion}.*${detail}${ciLink}${prLink}`, result.errors);
}

// ─── Text argument parser ─────────────────────────────────────────────────────

function parseArgs(text) {
  text = (text || '').trim();
  let m = text.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/);
  if (m) return { repo: m[1], prNumber: parseInt(m[2], 10) };
  m = text.match(/^([A-Za-z0-9_.-]+)#(\d+)$/);
  if (m) return { repo: `REBUS-Industries/${m[1]}`, prNumber: parseInt(m[2], 10) };
  m = text.match(/^(\d+)$/);
  if (m) return { repo: DEFAULT_REPO, prNumber: parseInt(m[1], 10) };
  return null;
}

function prLabel(repo, prNumber) {
  return repo === DEFAULT_REPO ? `#${prNumber}` : `${repo.replace('REBUS-Industries/', '')}#${prNumber}`;
}

function prUrl(repo, prNumber) {
  return `https://github.com/${repo}/pull/${prNumber}`;
}

// ─── Modal block builders ─────────────────────────────────────────────────────

/** Fetch open PRs from all repos in parallel, tag each with its repo. */
async function getAllOpenPRs() {
  const results = await Promise.all(
    REPOS.map(async r => {
      const prs = await getOpenPRs(r.value).catch(() => []);
      return prs.map(pr => ({ ...pr, _repo: r.value, _repoLabel: r.label }));
    })
  );
  // Flatten and sort by most recently updated
  return results.flat().sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

// Cache open PRs while the merge modal is open (for live preview updates).
let modalPrCache = [];

/** Slack static_select option text — max 75 chars. */
function prSelectOptionText(pr) {
  const MAX = 75;
  const repoTag = pr._repo === DEFAULT_REPO
    ? ''
    : `[${pr._repo.replace('REBUS-Industries/', '').slice(0, 10)}] `;
  const author = (pr.user?.login ?? '?').slice(0, 14);
  const prefix = `${repoTag}#${pr.number} @${author} · `;
  const title = pr.title.slice(0, Math.max(0, MAX - prefix.length));
  return prefix + title;
}

function buildPrPreviewBlock(pr) {
  if (!pr) {
    return {
      type: 'section',
      block_id: 'pr_preview',
      text: { type: 'mrkdwn', text: '_Select a pull request above to see the full title, author, and link._' },
    };
  }
  const repoShort = pr._repo.replace('REBUS-Industries/', '');
  const author = pr.user?.login ?? 'unknown';
  const branch = pr.head?.ref ?? '?';
  const updated = new Date(pr.updated_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const link = pr.html_url ? `<${pr.html_url}|Open on GitHub>` : '';
  return {
    type: 'section',
    block_id: 'pr_preview',
    text: {
      type: 'mrkdwn',
      text: [
        `*${repoShort} #${pr.number}* · @${author} · \`${branch}\``,
        pr.title,
        `_Updated ${updated}_ · ${link}`,
      ].filter(Boolean).join('\n'),
    },
  };
}

function buildModalView(channelId, selectablePRs, selectedPr = null, totalOpen = 0, mode = 'merge') {
  const isCheck = mode === 'check';
  const statusText = queueStatusText();
  const emptyText = totalOpen > 0 && selectablePRs.length === 0
    ? '_All open PRs are currently merging or queued._'
    : '_No open pull requests across any repo._';

  const prBlock = selectablePRs.length === 0
    ? { type: 'section', block_id: 'pr_block', text: { type: 'mrkdwn', text: emptyText } }
    : {
        type: 'input',
        block_id: 'pr_block',
        dispatch_action: true,
        label: { type: 'plain_text', text: 'Pull Request' },
        element: {
          type: 'static_select',
          action_id: 'pr_select',
          placeholder: { type: 'plain_text', text: 'Select a PR…' },
          options: selectablePRs.map(pr => ({
            text: { type: 'plain_text', text: prSelectOptionText(pr), emoji: false },
            value: `${pr._repo}::${pr.number}`,
          })),
          ...(selectedPr ? {
            initial_option: {
              text: { type: 'plain_text', text: prSelectOptionText(selectedPr), emoji: false },
              value: `${selectedPr._repo}::${selectedPr.number}`,
            },
          } : {}),
        },
      };

  return {
    type: 'modal',
    callback_id: isCheck ? 'check_modal' : 'merge_modal',
    private_metadata: channelId,
    title: { type: 'plain_text', text: isCheck ? 'Check a PR' : 'Merge a PR' },
    submit: selectablePRs.length > 0
      ? { type: 'plain_text', text: isCheck ? 'Check status' : 'Merge' }
      : undefined,
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      prBlock,
      { type: 'divider' },
      buildPrPreviewBlock(selectedPr),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: isCheck
            ? `${statusText}\n_Checks mergeability, head CI, and post-merge deploy workflows. Use \`/prism-merge check 42\` for merged PRs._`
            : statusText,
        }],
      },
    ],
  };
}

async function openPrModal(triggerId, channelId, mode = 'merge') {
  const isCheck = mode === 'check';
  const loadingView = {
    type: 'modal',
    callback_id: isCheck ? 'check_modal' : 'merge_modal',
    private_metadata: channelId,
    title: { type: 'plain_text', text: isCheck ? 'Check a PR' : 'Merge a PR' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: ':hourglass: Fetching open pull requests…' } },
    ],
  };
  const opened = await slackApi('views.open', { trigger_id: triggerId, view: loadingView });
  if (!opened.ok) return;

  const allPRs = await getAllOpenPRs();
  modalPrCache = allPRs;
  const selectable = filterSelectablePRs(allPRs);
  const defaultPr = selectable[0] ?? null;
  await slackApi('views.update', {
    view_id: opened.view.id,
    view: buildModalView(channelId, selectable, defaultPr, allPRs.length, mode),
  });
}

async function openMergeModal(triggerId, channelId) {
  return openPrModal(triggerId, channelId, 'merge');
}

async function openCheckModal(triggerId, channelId) {
  return openPrModal(triggerId, channelId, 'check');
}

// ─── App Home ─────────────────────────────────────────────────────────────────

async function publishHome(userId) {
  const statusText = queueStatusText();
  await slackApi('views.publish', {
    user_id: userId,
    view: {
      type: 'home',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'PRISM Merge Bot' } },
        { type: 'section', text: { type: 'mrkdwn', text: 'Merge a PR to `main` and deploy to prism. Merges run one at a time; extra requests are queued.' } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: statusText } },
        { type: 'actions', elements: [
          { type: 'button', action_id: 'open_merge_modal', style: 'primary', text: { type: 'plain_text', text: '🚀  Merge a PR', emoji: true } },
          { type: 'button', action_id: 'open_check_modal', text: { type: 'plain_text', text: '🔍  Check a PR', emoji: true } },
        ] },
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Or: `/prism-merge 42` · `/prism-merge check 42` · `/prism-merge prism-fixtures-service#7`' }] },
      ],
    },
  });
}

// ─── Pinned button message ────────────────────────────────────────────────────

async function postPinMessage(channelId) {
  const result = await slackApi('chat.postMessage', {
    channel: channelId,
    text: 'PRISM Merge Bot',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*PRISM Merge Bot* — merge a PR and deploy to prism.' },
        accessory: { type: 'button', action_id: 'open_merge_modal', style: 'primary', text: { type: 'plain_text', text: '🚀  Merge a PR', emoji: true } },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'open_check_modal', text: { type: 'plain_text', text: '🔍  Check a PR', emoji: true } },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Merges run serially; queued PRs start automatically when the current deploy finishes.' }] },
    ],
  });
  if (result.ok && result.ts) await slackApi('pins.add', { channel: channelId, timestamp: result.ts });
  return result;
}

// ─── Merge flow ───────────────────────────────────────────────────────────────

async function finishCiPoll(job) {
  const { repo, prNumber, channelId, label, ciStartIso } = job;
  const url = prUrl(repo, prNumber);
  try {
    const result = await pollDeploys(repo, ciStartIso, CI_WATCH_MINUTES);
        const ciCfg = repoCiConfig(repo);
    await postToSlack(channelId, formatCiResultMessage(label, result, ciCfg.deploysToDev, url, ciCfg.deployTarget));
    console.log(`CI finished (${label}): ${result.conclusion}`);
  } catch (err) {
    console.error('finishCiPoll error:', err);
    const detail = [err.message, err.stack].filter(Boolean).join('\n');
    await postToSlack(channelId, formatFailureMessage(`*CI poll failed for ${label}*`, detail, url));
  }
}

/**
 * Post an interactive Slack message prompting the user to mark a draft PR
 * as ready-for-review and proceed with the merge, or cancel.
 */
async function postDraftReadyPrompt(channelId, label, prNumber, repo, userName) {
  const url = prUrl(repo, prNumber);
  const value = `${repo}::${prNumber}::${userName}`;
  return slackApi('chat.postMessage', {
    channel: channelId,
    text: `⚠️ ${label} is a draft PR — mark it ready for review and continue merging?`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:pencil: *<${url}|${label}>* is still a *draft* PR.\nMark it ready for review and continue merging?`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'ready_and_merge',
            style: 'primary',
            text: { type: 'plain_text', text: 'Mark Ready & Merge', emoji: false },
            value,
          },
          {
            type: 'button',
            action_id: 'cancel_draft_merge',
            style: 'danger',
            text: { type: 'plain_text', text: 'Cancel', emoji: false },
            value,
          },
        ],
      },
    ],
  });
}

// Why we declined to merge (used to build the Slack abort message).
const ABORT_HEADLINES = {
  conflict: 'it conflicts with `main` and needs a manual rebase',
  checks_failed: 'checks failed after updating with `main`',
  checks_timeout: 'checks did not finish in time after updating with `main`',
  update_failed: 'the branch could not be updated with `main`',
  too_many_updates: '`main` kept advancing faster than CI could finish',
  blocked: 'it is blocked by branch protection (required reviews or checks)',
  draft: 'it is still a draft',
  closed: 'it is no longer open',
};

/**
 * Bring the PR branch up to date with its base and wait for required checks to
 * pass, so the merge always includes the latest `main` and never lands stale or
 * untested code, and concurrent commits on `main` are never lost. Returns:
 *   { status: 'ready', updated }          — safe to merge now
 *   { status: 'merged' }                  — it got merged while we waited
 *   { status: 'abort', reason, details }  — do NOT merge; a human must act
 * Idempotent and safe to re-run (e.g. after a bot restart mid-update).
 */
async function prepareBranchForMerge(job) {
  const { repo, prNumber, channelId, label } = job;
  const deadline = Date.now() + UPDATE_CHECKS_TIMEOUT_MS;
  let updateCount = 0;
  let awaitingNewHeadFrom = null;   // head sha we issued an update from; wait for it to move
  let lastHeadSha = null;
  let headChangedAt = Date.now();
  let postedUpdating = false;
  let postedWaiting = false;
  let firstPass = true;

  while (Date.now() < deadline) {
    if (!firstPass) await sleep(UPDATE_CHECKS_POLL_MS);
    firstPass = false;

    const pr = await getPRInfo(repo, prNumber);
    if (!pr) continue;
    if (pr.state === 'merged' || pr.merged_at) return { status: 'merged' };
    if (pr.state !== 'open') return { status: 'abort', reason: 'closed', details: `PR is ${pr.state}.` };

    const headSha = pr.head?.sha;
    const state = pr.mergeable_state;

    if (headSha && headSha !== lastHeadSha) {
      lastHeadSha = headSha;
      headChangedAt = Date.now();
    }

    // Wait for a just-issued update-branch to actually move the head before re-evaluating.
    if (awaitingNewHeadFrom) {
      if (headSha && headSha !== awaitingNewHeadFrom) awaitingNewHeadFrom = null;
      else continue;
    }

    // Hard conflict with base — cannot update cleanly; a human must resolve it.
    if (state === 'dirty' || pr.mergeable === false) {
      const details = await getMergeFailureDetails(repo, prNumber, { message: 'Branch has merge conflicts with base' });
      return { status: 'abort', reason: 'conflict', details };
    }

    // Behind base → update before merging, regardless of branch-protection strictness.
    const behindBy = await getBehindBy(repo, pr);
    if (behindBy > 0 || state === 'behind') {
      if (updateCount >= UPDATE_MAX_CYCLES) {
        return {
          status: 'abort',
          reason: 'too_many_updates',
          details: `Updated ${updateCount}× but \`main\` kept advancing. Retry when main is quieter, or rebase manually.`,
        };
      }
      if (!postedUpdating) {
        const behindText = behindBy > 0 ? ` by ${behindBy} commit(s)` : '';
        await postToSlack(channelId, `:arrows_counterclockwise: ${label} is behind \`${pr.base?.ref ?? 'main'}\`${behindText} — updating before merge…`);
        postedUpdating = true;
      }
      const upd = await updatePrBranch(repo, prNumber, headSha);
      updateCount++;
      if (!upd.ok) {
        // 422 + "expected head sha" => branch moved under us (concurrent push); re-evaluate.
        if (upd.status === 422 && /expected.*head|head.*sha/i.test(upd.message)) continue;
        if (upd.status === 422 && /conflict/i.test(upd.message)) {
          const details = await getMergeFailureDetails(repo, prNumber, { status: 422, message: upd.message || 'Update hit a merge conflict' });
          return { status: 'abort', reason: 'conflict', details };
        }
        return { status: 'abort', reason: 'update_failed', details: `update-branch failed: HTTP ${upd.status}${upd.message ? ` — ${upd.message}` : ''}` };
      }
      awaitingNewHeadFrom = headSha;   // 202 Accepted: wait for the new merge commit to appear
      continue;
    }

    // Up to date with base — decide based on mergeability / required checks.
    switch (state) {
      case 'clean':
      case 'unstable':   // mergeable; only non-required checks unhappy (current behaviour merges these)
      case 'has_hooks':
        return { status: 'ready', updated: updateCount > 0 };
      case 'draft':
        return { status: 'abort', reason: 'draft', details: 'PR is a draft.' };
      case 'blocked': {
        const sum = await getHeadCheckSummary(repo, headSha);
        if (sum.failed.length) {
          const details = (await getCommitCheckFailures(repo, headSha)).join('\n') || `Failing checks: ${sum.failed.join(', ')}`;
          return { status: 'abort', reason: 'checks_failed', details };
        }
        if (sum.pending > 0) {
          if (!postedWaiting) {
            await postToSlack(channelId, `:hourglass: ${label} updated — waiting for ${sum.pending} required check(s) to pass…`);
            postedWaiting = true;
          }
          continue;
        }
        // Nothing pending/failing yet — let required checks register before concluding.
        if (Date.now() - headChangedAt < BLOCKED_CHECKS_GRACE_MS) continue;
        return { status: 'abort', reason: 'blocked', details: `mergeable_state=blocked with no pending/failing checks — likely required reviews. ${MERGE_STATE_HELP.blocked}` };
      }
      case 'unknown':
      default:
        // GitHub still computing mergeability, or a transient state — keep polling.
        continue;
    }
  }

  // Ran out of time waiting for checks to settle.
  const finalPr = await getPRInfo(repo, prNumber);
  const finalSum = await getHeadCheckSummary(repo, finalPr?.head?.sha);
  if (finalSum.failed.length) {
    return { status: 'abort', reason: 'checks_failed', details: `Failing: ${finalSum.failed.join(', ')}` };
  }
  return {
    status: 'abort',
    reason: 'checks_timeout',
    details: `Still ${finalSum.pending} check(s) pending after ${UPDATE_CHECKS_TIMEOUT_MINUTES} min. Check GitHub Actions, then retry.`,
  };
}

async function runActiveJob(job) {
  const { repo, prNumber, userName, channelId, label } = job;
  const url = prUrl(repo, prNumber);

  if (job.phase === 'polling_ci' && job.ciStartIso) {
    await finishCiPoll(job);
    return;
  }

  try {
    const pr = await getPRInfo(repo, prNumber);

    if (pr?.state === 'merged') {
      job.phase = 'polling_ci';
      job.ciStartIso = pr.merged_at ?? job.ciStartIso ?? new Date().toISOString();
      if (!job.mergedPosted) {
        await postToSlack(channelId, `:twisted_rightwards_arrows: ${label} merged by ${userName} — waiting for CI…`);
        job.mergedPosted = true;
      }
      await persistState();
      await finishCiPoll(job);
      return;
    }

    if (pr?.mergeable === false) {
      const details = await getMergeFailureDetails(repo, prNumber, {
        status: 405,
        message: 'Pull Request is not mergeable',
      });
      await postToSlack(channelId, formatFailureMessage(`*Failed to merge ${label}*`, details, url));
      return;
    }

    // Bring the branch up to date with main and wait for checks BEFORE merging,
    // so we never land stale code or drop concurrent commits. Abort (don't merge)
    // if it can't be updated cleanly or post-update checks fail/time out.
    if (AUTO_UPDATE_ENABLED) {
      job.phase = 'updating';
      await persistState();
      const prep = await prepareBranchForMerge(job);

      if (prep.status === 'abort') {
        await postToSlack(channelId, formatFailureMessage(`*Did not merge ${label}* — ${ABORT_HEADLINES[prep.reason] ?? prep.reason}.`, prep.details, url));
        return;
      }
      if (prep.status === 'merged') {
        job.phase = 'polling_ci';
        job.ciStartIso = new Date().toISOString();
        if (!job.mergedPosted) {
          await postToSlack(channelId, `:twisted_rightwards_arrows: ${label} was already merged — waiting for CI…`);
          job.mergedPosted = true;
        }
        await persistState();
        await finishCiPoll(job);
        return;
      }
      if (prep.updated) {
        await postToSlack(channelId, `:white_check_mark: ${label} is up to date with \`main\` and checks passed — merging…`);
      }
    }

    job.phase = 'merging';
    await persistState();

    const merge = await mergePR(repo, prNumber);
    if (!merge.ok) {
      const details = await getMergeFailureDetails(repo, prNumber, merge);
      await postToSlack(channelId, formatFailureMessage(`*Failed to merge ${label}*`, details, url));
      return;
    }

    job.phase = 'polling_ci';
    job.ciStartIso = new Date().toISOString();
    if (!job.mergedPosted) {
      await postToSlack(channelId, `:twisted_rightwards_arrows: ${label} merged by ${userName} — waiting for CI…`);
      job.mergedPosted = true;
    }
    await persistState();
    await finishCiPoll(job);
  } catch (err) {
    console.error('runActiveJob error:', err);
    const detail = [err.message, err.stack].filter(Boolean).join('\n');
    await postToSlack(channelId, formatFailureMessage(`*Unexpected error merging ${label}*`, detail, url));
  }
}


async function getBranchRef(repo, branch) {
  const res = await GH(`/repos/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, sha: body.object?.sha, message: body.message ?? '' };
}

async function getCommitSubject(repo, sha) {
  const res = await GH(`/repos/${repo}/commits/${sha}`);
  if (!res.ok) return 'portal-app dev';
  const body = await res.json().catch(() => ({}));
  const msg = body.commit?.message ?? '';
  return msg.split('\n')[0]?.trim() || 'portal-app dev';
}

/** ship-dev.sh equivalent: merge dev -> master, then fast-forward dev to master. */
async function promotePortalApp(userName, channelId) {
  if (portalPromoteBusy) {
    await postToSlack(channelId, ':information_source: A *portal-app* promote is already running — wait for it to finish.');
    return;
  }
  portalPromoteBusy = true;
  const repo = PORTAL_APP_REPO;
  const compareUrl = `https://github.com/${repo}/compare/master...dev`;
  try {
    const [dev, master] = await Promise.all([getBranchRef(repo, 'dev'), getBranchRef(repo, 'master')]);
    if (!dev.ok || !master.ok) {
      const detail = [
        !dev.ok ? `dev: HTTP ${dev.status}${dev.message ? ` — ${dev.message}` : ''}` : null,
        !master.ok ? `master: HTTP ${master.status}${master.message ? ` — ${master.message}` : ''}` : null,
      ].filter(Boolean).join('\n');
      await postToSlack(channelId, formatFailureMessage('*portal-app promote failed*', detail, compareUrl));
      return;
    }
    if (dev.sha === master.sha) {
      await postToSlack(
        channelId,
        `:white_check_mark: *portal-app* ` + '`dev`' + ` and ` + '`master`' + ` are already in sync at ` + `\`${dev.sha.slice(0, 7)}\`` + ` — nothing to promote.`,
      );
      return;
    }

    const subject = await getCommitSubject(repo, dev.sha);
    const mergeMsg = `Merge dev: ${subject} (via /portal-app-promote by @${userName})`;
    const mergeRes = await GH(`/repos/${repo}/merges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: 'master', head: 'dev', commit_message: mergeMsg }),
    });
    const mergeBody = await mergeRes.json().catch(() => ({}));
    if (!mergeRes.ok) {
      const detail = [
        mergeBody.message,
        ...(mergeBody.errors ?? []).map(e => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e))),
      ].filter(Boolean).join('\n') || `HTTP ${mergeRes.status}`;
      await postToSlack(channelId, formatFailureMessage('*portal-app promote failed*', detail, compareUrl));
      return;
    }

    const masterSha = mergeBody.sha;
    const syncRes = await GH(`/repos/${repo}/git/refs/heads/dev`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: masterSha, force: false }),
    });
    const syncBody = await syncRes.json().catch(() => ({}));
    if (!syncRes.ok) {
      await postToSlack(
        channelId,
        `:warning: *portal-app* merged ` + '`dev`' + ` -> ` + '`master`' + ` at ` + `\`${masterSha.slice(0, 7)}\`` + ` but could not fast-forward ` + '`dev`' + `: ${syncBody.message ?? `HTTP ${syncRes.status}`}. Prod Firebase deploy should still run; sync branches manually.`,
      );
      return;
    }

    await postToSlack(
      channelId,
      `:rocket: *portal-app* promoted by @${userName}: ` + '`dev`' + ` -> ` + '`master`' + ` (` + `\`${masterSha.slice(0, 7)}\`` + `). Firebase App Hosting is rolling out https://portal.rebus.industries — see Firebase console for status.`,
    );
  } catch (err) {
    console.error('promotePortalApp error:', err);
    await postToSlack(
      channelId,
      formatFailureMessage('*portal-app promote failed*', err?.message ?? String(err), compareUrl),
    );
  } finally {
    portalPromoteBusy = false;
  }
}

async function startMerge(repo, prNumber, userName, channelId, res, isModal = false) {
  const label = prLabel(repo, prNumber);
  const pr = await getPRInfo(repo, prNumber).catch(() => null);
  if (!pr) {
    return isModal
      ? res.json({ response_action: 'errors', errors: { pr_block: `PR #${prNumber} not found in ${repo}.` } })
      : res.json({ response_type: 'ephemeral', text: `:x: PR ${label} not found.` });
  }
  if (pr.state !== 'open') {
    return isModal
      ? res.json({ response_action: 'errors', errors: { pr_block: `PR #${prNumber} is already ${pr.state}.` } })
      : res.json({ response_type: 'ephemeral', text: `:x: PR ${label} is already *${pr.state}*.` });
  }
  if (isDuplicate(repo, prNumber)) {
    const msg = `:information_source: ${label} is already merging or queued.`;
    return isModal
      ? res.json({ response_action: 'errors', errors: { pr_block: msg } })
      : res.json({ response_type: 'ephemeral', text: msg });
  }

  // Draft PR — prompt the user to mark it ready before merging.
  if (pr.draft) {
    if (isModal) res.json({ response_action: 'clear' });
    else res.json({ response_type: 'ephemeral', text: '' });
    await postDraftReadyPrompt(channelId, label, prNumber, repo, userName);
    return;
  }

  const job = {
    repo,
    prNumber,
    userName: `@${userName}`,
    channelId,
    label,
    title: pr.title,
    enqueuedAt: Date.now(),
    phase: 'merging',
    ciStartIso: null,
    mergedPosted: false,
  };

  const respond = async (text) => {
    if (isModal) {
      res.json({ response_action: 'clear' });
      await postToSlack(channelId, text);
    } else {
      res.json({ response_type: 'in_channel', text });
    }
  };

  if (active) {
    queue.push(job);
    await persistState();
    const position = queue.length;
    console.log(`Queued: ${label} by @${userName} (position ${position})`);
    await respond(`:clipboard: *@${userName}* queued ${label}: _${pr.title}_ — position *${position}* in queue.`);
    return;
  }

  active = { ...job, startedAt: Date.now() };
  await persistState();
  console.log(`Started: ${label} by @${userName}`);
  await respond(`:hourglass_flowing_sand: *@${userName}* is merging ${label}: _${pr.title}_`);
  runWorker().catch(console.error);
}

// ─── Slack signature verification ─────────────────────────────────────────────

function verifySlackSignature(req) {
  const ts  = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${req.rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(base).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

app.use(express.urlencoded({
  extended: true,
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));
app.use((req, res, next) => {
  if (req.headers['content-type']?.includes('application/json')) {
    let buf = '';
    req.on('data', c => { buf += c; });
    req.on('end', () => { req.rawBody = buf; try { req.body = JSON.parse(buf); } catch { req.body = {}; } next(); });
  } else { next(); }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    stateFile: STATE_FILE,
    active: active
      ? {
          label: active.label,
          userName: active.userName,
          phase: active.phase,
          ageSeconds: Math.round((Date.now() - active.startedAt) / 1000),
        }
      : null,
    queueLength: queue.length,
    queue: queue.map(j => ({ label: j.label, userName: j.userName })),
    workerBusy,
  });
});

/** Localhost-only smoke test — posts a dummy CI failure to SLACK_CHANNEL_ID. */
app.post('/admin/smoke-ci-failure', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1') && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'localhost only' });
  }
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!channelId) return res.status(500).json({ error: 'SLACK_CHANNEL_ID not set' });

  const dummyErrors = [
    'Build & Test (failure)',
    'job: build',
    '  step failed: Build',
    'src/OrbitConnector.Rhino/Fixtures/RhinoFixtureHelper.cs:41: ; expected',
    'src/OrbitConnector.Rhino/Fixtures/RhinoFixtureHelper.cs:41: Invalid expression term \'=\'',
    'src/OrbitConnector.Rhino/Fixtures/RhinoFixtureHelper.cs:41: } expected',
    '(smoke test — not a real merge)',
  ].join('\n');

  const result = {
    conclusion: 'failure',
    url: 'https://github.com/REBUS-Industries/orbit-connectors/actions/runs/00000000000',
    detail: 'Build & Test=failure',
    errors: dummyErrors,
  };
  const text = formatCiResultMessage('orbit-connectors#SMOKE', result, false);
  await postToSlack(channelId, text);
  res.json({ ok: true, posted: true, channelId, preview: text });
});

/** Localhost-only smoke test — posts a dummy merge-blocked message to SLACK_CHANNEL_ID. */
app.post('/admin/smoke-merge-failure', async (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1') && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'localhost only' });
  }
  const channelId = process.env.SLACK_CHANNEL_ID;
  if (!channelId) return res.status(500).json({ error: 'SLACK_CHANNEL_ID not set' });

  const details = [
    'GitHub: Pull Request is not mergeable',
    'HTTP 405',
    'title: feat(web+assimp): 3DS mesh support + honest model-quality UI',
    'head: feat/fixture-builder (abc1234)',
    'mergeable: false',
    'mergeable_state: dirty',
    MERGE_STATE_HELP.dirty,
    'Common PRISM conflict zones: web/src/shared/api.ts, web/src/admin/App.vue',
    '(smoke test — not a real merge)',
  ].join('\n');
  const text = formatFailureMessage('*Failed to merge #48*', details, 'https://github.com/REBUS-Industries/prism/pull/48');
  await postToSlack(channelId, text);
  res.json({ ok: true, posted: true, channelId, preview: text });
});

// ── Events API ────────────────────────────────────────────────────────────────
app.post('/events', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.body.type === 'url_verification') return res.json({ challenge: req.body.challenge });
  if (req.body.event?.type === 'app_home_opened') {
    res.json({ ok: true });
    await publishHome(req.body.event.user);
    return;
  }
  res.json({ ok: true });
});


// portal-app prod promote (dev -> master)
app.post('/portal-app-promote', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).json({ error: 'Unauthorized' });
  const userName  = req.body.user_name || 'unknown';
  const channelId = req.body.channel_id;
  res.json({
    response_type: 'in_channel',
    text: `:hourglass_flowing_sand: *@${userName}* is promoting *portal-app* (` + '`dev`' + ` -> ` + '`master`' + ` / Firebase prod)...`,
  });
  promotePortalApp(userName, channelId).catch(err => console.error('portal-app-promote:', err));
});

// ── Slash command ─────────────────────────────────────────────────────────────
app.post('/merge', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).json({ error: 'Unauthorized' });
  const text      = (req.body.text || '').trim();
  const userName  = req.body.user_name || 'unknown';
  const channelId = req.body.channel_id;
  const triggerId = req.body.trigger_id;

  if (text === 'pin') {
    await postPinMessage(channelId);
    return res.json({ response_type: 'ephemeral', text: ':pushpin: Merge button posted and pinned.' });
  }
  if (text === 'check' || text.startsWith('check ')) {
    const rest = text === 'check' ? '' : text.slice(6).trim();
    if (!rest) {
      await openCheckModal(triggerId, channelId);
      return res.json({ response_type: 'ephemeral', text: '' });
    }
    const parsed = parseArgs(rest);
    if (!parsed) {
      return res.json({
        response_type: 'ephemeral',
        text: 'Usage: `/prism-merge check` (opens form) or `/prism-merge check 42` or `/prism-merge check repo-name#42`',
      });
    }
    await checkPR(parsed.repo, parsed.prNumber, userName, channelId, res, false);
    return;
  }
  if (!text) {
    await openMergeModal(triggerId, channelId);
    return res.json({ response_type: 'ephemeral', text: '' });
  }
  const parsed = parseArgs(text);
  if (!parsed) {
    return res.json({ response_type: 'ephemeral', text: 'Usage: `/prism-merge` (opens form) or `/prism-merge 42` or `/prism-merge repo-name#42`' });
  }
  await startMerge(parsed.repo, parsed.prNumber, userName, channelId, res, false);
});

// ── Interactions (modal submit, repo change, shortcuts, home button) ──────────
app.post('/interact', async (req, res) => {
  if (!verifySlackSignature(req)) return res.status(401).json({ error: 'Unauthorized' });
  let payload;
  try {
    payload = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : (req.body.payload ?? req.body);
  } catch { return res.status(400).json({ error: 'Bad payload' }); }

  // Global shortcut (⚡ menu)
  if (payload.type === 'shortcut' && payload.callback_id === 'merge_shortcut') {
    res.json({});
    await openMergeModal(payload.trigger_id, payload.user.id);
    return;
  }

  // Block actions (home button, pinned button, repo dropdown change)
  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0];
    if (action?.action_id === 'open_merge_modal') {
      res.json({});
      const channelId = payload.channel?.id ?? payload.user.id;
      await openMergeModal(payload.trigger_id, channelId);
      return;
    }
    if (action?.action_id === 'open_check_modal') {
      res.json({});
      const channelId = payload.channel?.id ?? payload.user.id;
      await openCheckModal(payload.trigger_id, channelId);
      return;
    }
    if (action?.action_id === 'pr_select' && (payload.view?.callback_id === 'merge_modal' || payload.view?.callback_id === 'check_modal')) {
      res.json({});
      const raw = action.selected_option?.value ?? '';
      const selectable = filterSelectablePRs(modalPrCache);
      const pr = selectable.find(p => `${p._repo}::${p.number}` === raw) ?? null;
      const channelId = payload.view.private_metadata;
      const mode = payload.view.callback_id === 'check_modal' ? 'check' : 'merge';
      console.log(`Modal PR preview update (${mode}): ${raw}`);
      const updated = await slackApi('views.update', {
        view_id: payload.view.id,
        hash: payload.view.hash,
        view: buildModalView(channelId, selectable, pr, modalPrCache.length, mode),
      });
      if (!updated.ok) console.error('views.update failed:', JSON.stringify(updated));
      return;
    }

    // ── Draft PR: "Mark Ready & Merge" button ─────────────────────────────────
    if (action?.action_id === 'ready_and_merge') {
      res.json({});
      const channelId = payload.channel?.id ?? payload.user.id;
      const parts = (action.value ?? '').split('::');
      const repo = parts[0];
      const prNumber = parseInt(parts[1] ?? '', 10);
      const userName = parts[2] ?? 'unknown';
      if (!repo || !prNumber || isNaN(prNumber)) {
        await postToSlack(channelId, ':x: Could not parse draft merge data — please try `/prism-merge` again.');
        return;
      }
      const label = prLabel(repo, prNumber);
      await postToSlack(channelId, `:pencil2: Marking ${label} as ready for review…`);
      const ready = await markPRReady(repo, prNumber);
      if (!ready.ok) {
        await postToSlack(channelId, `:x: Could not mark ${label} as ready for review: ${ready.message || 'GitHub error'}`);
        return;
      }
      // Drive startMerge without the original Express res (already acknowledged).
      // isModal=true makes startMerge post its queue/start message to Slack
      // directly rather than through res. The fakeRes shim forwards modal error
      // responses (response_action:'errors') to Slack as plain messages.
      const fakeRes = {
        json: (data) => {
          if (data?.errors) {
            const errText = Object.values(data.errors ?? {}).join('; ');
            postToSlack(channelId, `:x: ${errText}`).catch(console.error);
          }
          // response_action:'clear' — no-op; startMerge will postToSlack itself.
        },
      };
      await startMerge(repo, prNumber, userName, channelId, fakeRes, true);
      return;
    }

    // ── Draft PR: "Cancel" button ─────────────────────────────────────────
    if (action?.action_id === 'cancel_draft_merge') {
      res.json({});
      const channelId = payload.channel?.id ?? payload.user.id;
      const parts = (action.value ?? '').split('::');
      const repo = parts[0];
      const prNumber = parseInt(parts[1] ?? '', 10);
      const label = (repo && !isNaN(prNumber)) ? prLabel(repo, prNumber) : 'PR';
      await postToSlack(channelId, `:no_entry: Merge cancelled for ${label}.`);
      return;
    }

    res.json({});
    return;
  }

  // Modal submission
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'merge_modal') {
    const values    = payload.view.state.values;
    const raw       = values.pr_block?.pr_select?.selected_option?.value ?? '';
    const [repo, prStr] = raw.split('::');
    const prNumber  = parseInt(prStr ?? '', 10);
    const userName  = payload.user?.username || 'unknown';
    const channelId = payload.view?.private_metadata || payload.user.id;
    if (!repo || !prNumber || isNaN(prNumber)) {
      return res.json({ response_action: 'errors', errors: { pr_block: 'Select a pull request.' } });
    }
    await startMerge(repo, prNumber, userName, channelId, res, true);
    return;
  }

  if (payload.type === 'view_submission' && payload.view?.callback_id === 'check_modal') {
    const values    = payload.view.state.values;
    const raw       = values.pr_block?.pr_select?.selected_option?.value ?? '';
    const [repo, prStr] = raw.split('::');
    const prNumber  = parseInt(prStr ?? '', 10);
    const userName  = payload.user?.username || 'unknown';
    const channelId = payload.view?.private_metadata || payload.user.id;
    if (!repo || !prNumber || isNaN(prNumber)) {
      return res.json({ response_action: 'errors', errors: { pr_block: 'Select a pull request.' } });
    }
    await checkPR(repo, prNumber, userName, channelId, res, true);
    return;
  }

  res.json({});
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const missing = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'GITHUB_TOKEN'].filter(k => !process.env[k]);
if (missing.length) { console.error('Missing env vars:', missing.join(', ')); process.exit(1); }

(async () => {
  await loadState();
  app.listen(PORT, () => {
    console.log(`Merge bot listening on :${PORT} (state: ${STATE_FILE})`);
    resumeOnStartup().catch(err => console.error('resumeOnStartup failed:', err));
  });
})();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
