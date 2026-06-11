/**
 * PRISM Merge Bot
 *
 * /prism-merge          → opens modal with live repo dropdown + open PR list
 * /prism-merge 42       → direct merge (agent shorthand)
 * /prism-merge repo#42  → direct merge in another REBUS-Industries repo
 * /prism-merge pin      → post a pinned Merge button to the channel
 *
 * Interactions handled at POST /slack/interact.
 * Events (App Home) handled at POST /slack/events.
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const { SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, GITHUB_TOKEN } = process.env;

const DEFAULT_REPO = 'REBUS-Industries/prism';
const PORT = 3456;

const REPOS = [
  { label: 'prism (web / server)',      value: 'REBUS-Industries/prism' },
  { label: 'prism-fixtures-service',    value: 'REBUS-Industries/prism-fixtures-service' },
  { label: 'prism-materials-service',   value: 'REBUS-Industries/prism-materials-service' },
  { label: 'prism-visualiser-service',  value: 'REBUS-Industries/prism-visualiser-service' },
  { label: 'prism-agent-service',       value: 'REBUS-Industries/prism-agent-service' },
  { label: 'prism-agent',               value: 'REBUS-Industries/prism-agent' },
  { label: 'prism-server-polyrepo',     value: 'REBUS-Industries/prism-server-polyrepo' },
  { label: 'orbit-connectors',          value: 'REBUS-Industries/orbit-connectors' },
  { label: 'orbit-ue-template',         value: 'REBUS-Industries/orbit-ue-template' },
  { label: 'orbit-server',              value: 'REBUS-Industries/orbit-server' },
  { label: 'orbit-sdk',                 value: 'REBUS-Industries/orbit-sdk' },
];

// ─── Lock ─────────────────────────────────────────────────────────────────────

let lock = null;

// ─── Slack API helpers ────────────────────────────────────────────────────────

async function slackApi(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error(`Slack ${method} failed:`, JSON.stringify(data));
  return data;
}

const postToSlack = (channel, text) => slackApi('chat.postMessage', { channel, text });

// ─── GitHub API helpers ───────────────────────────────────────────────────────

const GH = (path, opts = {}) => fetch(`https://api.github.com${path}`, {
  ...opts,
  headers: {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers ?? {}),
  },
});

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

async function mergePR(repo, prNumber) {
  const res = await GH(`/repos/${repo}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: 'merge' }),
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, message: body.message ?? '' };
}

async function pollWorkflow(repo, afterIso, maxMinutes = 12) {
  const deadline = Date.now() + maxMinutes * 60_000;
  while (Date.now() < deadline) {
    await sleep(15_000);
    const res = await GH(`/repos/${repo}/actions/runs?per_page=10&branch=main`);
    if (!res.ok) continue;
    const { workflow_runs: runs } = await res.json();
    const run = runs.find(r => r.created_at >= afterIso);
    if (!run) continue;
    if (run.status === 'completed') return { conclusion: run.conclusion, url: run.html_url };
  }
  return { conclusion: 'timeout', url: null };
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

function buildModalView(channelId, allPRs) {
  const statusText = lock
    ? `:lock: *Merge in progress:* ${lock.label} by ${lock.userName} — ${Math.round((Date.now() - lock.startedAt) / 1000 / 60)}m ago.`
    : ':white_check_mark: No merge in progress — ready.';

  const prBlock = allPRs.length === 0
    ? { type: 'section', block_id: 'pr_block', text: { type: 'mrkdwn', text: '_No open pull requests across any repo._' } }
    : {
        type: 'input',
        block_id: 'pr_block',
        label: { type: 'plain_text', text: 'Pull Request' },
        element: {
          type: 'static_select',
          action_id: 'pr_select',
          placeholder: { type: 'plain_text', text: 'Select a PR…' },
          options: allPRs.map(pr => {
            const repoShort = pr._repo.replace('REBUS-Industries/', '');
            const prefix = `[${repoShort}] #${pr.number} — `;
            const titleMax = 74 - prefix.length;
            const title = pr.title.slice(0, titleMax);
            return {
              text: { type: 'plain_text', text: prefix + title, emoji: false },
              value: `${pr._repo}::${pr.number}`,
            };
          }),
        },
      };

  return {
    type: 'modal',
    callback_id: 'merge_modal',
    private_metadata: channelId,
    title: { type: 'plain_text', text: 'Merge a PR' },
    submit: allPRs.length > 0 ? { type: 'plain_text', text: 'Merge' } : undefined,
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      prBlock,
      { type: 'context', elements: [{ type: 'mrkdwn', text: statusText }] },
    ],
  };
}

async function openMergeModal(triggerId, channelId) {
  // Open immediately with a loading placeholder — trigger_id expires in 3s.
  const loadingView = {
    type: 'modal',
    callback_id: 'merge_modal',
    private_metadata: channelId,
    title: { type: 'plain_text', text: 'Merge a PR' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: ':hourglass: Fetching open pull requests…' } },
    ],
  };
  const opened = await slackApi('views.open', { trigger_id: triggerId, view: loadingView });
  if (!opened.ok) return;

  // Fetch all PRs in parallel, then update the modal.
  const allPRs = await getAllOpenPRs();
  await slackApi('views.update', { view_id: opened.view.id, view: buildModalView(channelId, allPRs) });
}

// ─── App Home ─────────────────────────────────────────────────────────────────

async function publishHome(userId) {
  const statusText = lock
    ? `:lock: *Merge in progress:* ${lock.label} by ${lock.userName} — ${Math.round((Date.now() - lock.startedAt) / 1000 / 60)}m ago.`
    : ':white_check_mark: *Ready* — no merge in progress.';
  await slackApi('views.publish', {
    user_id: userId,
    view: {
      type: 'home',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'PRISM Merge Bot' } },
        { type: 'section', text: { type: 'mrkdwn', text: 'Merge a PR to `main` and deploy to prism-dev. Only one merge runs at a time.' } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: statusText } },
        { type: 'actions', elements: [{ type: 'button', action_id: 'open_merge_modal', style: 'primary', text: { type: 'plain_text', text: '🚀  Merge a PR', emoji: true } }] },
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Or: `/prism-merge 42` · `/prism-merge prism-fixtures-service#7`' }] },
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
        text: { type: 'mrkdwn', text: '*PRISM Merge Bot* — merge a PR and deploy to prism-dev.' },
        accessory: { type: 'button', action_id: 'open_merge_modal', style: 'primary', text: { type: 'plain_text', text: '🚀  Merge a PR', emoji: true } },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'One merge at a time. Results post back here when deploy completes.' }] },
    ],
  });
  if (result.ok && result.ts) await slackApi('pins.add', { channel: channelId, timestamp: result.ts });
  return result;
}

// ─── Merge flow ───────────────────────────────────────────────────────────────

async function doMerge(repo, prNumber, userName, channelId) {
  const startIso = new Date().toISOString();
  const label = prLabel(repo, prNumber);
  try {
    const merge = await mergePR(repo, prNumber);
    if (!merge.ok) {
      const reason = merge.status === 405 ? 'PR is not mergeable (conflicts or CI failing)' : merge.message || `HTTP ${merge.status}`;
      await postToSlack(channelId, `:x: Failed to merge ${label}: ${reason}`);
      return;
    }
    await postToSlack(channelId, `:twisted_rightwards_arrows: ${label} merged by ${userName} — waiting for CI deploy…`);
    const result = await pollWorkflow(repo, startIso);
    if (result.conclusion === 'success') {
      await postToSlack(channelId, `:white_check_mark: *${label} is deployed.* <${result.url}|View CI run>`);
    } else if (result.conclusion === 'timeout') {
      await postToSlack(channelId, `:warning: ${label} merged but CI timed out — check <https://github.com/${repo}/actions|GitHub Actions> manually.`);
    } else {
      await postToSlack(channelId, `:x: ${label} merged but deploy *${result.conclusion}*. <${result.url}|View CI run>`);
    }
  } catch (err) {
    console.error('doMerge error:', err);
    await postToSlack(channelId, `:x: Unexpected error merging ${label}: ${err.message}`);
  } finally {
    lock = null;
    console.log(`Lock released (${label})`);
  }
}

async function startMerge(repo, prNumber, userName, channelId, res, isModal = false) {
  const label = prLabel(repo, prNumber);
  if (lock) {
    const age = Math.round((Date.now() - lock.startedAt) / 1000 / 60);
    const msg = `:lock: Merge in progress: *${lock.label}* by ${lock.userName} (${age}m ago). Wait for it to complete.`;
    return isModal
      ? res.json({ response_action: 'errors', errors: { pr_block: msg } })
      : res.json({ response_type: 'ephemeral', text: msg });
  }
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
  lock = { label, prNumber, repo, userName: `@${userName}`, startedAt: Date.now() };
  console.log(`Lock acquired: ${label} by @${userName}`);
  if (isModal) {
    res.json({ response_action: 'clear' });
    await postToSlack(channelId, `:hourglass_flowing_sand: *@${userName}* is merging ${label}: _${pr.title}_`);
  } else {
    res.json({ response_type: 'in_channel', text: `:hourglass_flowing_sand: *@${userName}* is merging ${label}: _${pr.title}_` });
  }
  doMerge(repo, prNumber, `@${userName}`, channelId).catch(console.error);
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
  res.json({ ok: true, locked: !!lock, lock: lock ? { label: lock.label, userName: lock.userName, ageSeconds: Math.round((Date.now() - lock.startedAt) / 1000) } : null });
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
    } else {
      res.json({});
    }
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

  res.json({});
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const missing = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'GITHUB_TOKEN'].filter(k => !process.env[k]);
if (missing.length) { console.error('Missing env vars:', missing.join(', ')); process.exit(1); }
app.listen(PORT, () => console.log(`Merge bot listening on :${PORT}`));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
