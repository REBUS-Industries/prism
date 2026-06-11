/**
 * PRISM Merge Bot
 *
 * Slack slash command /prism-merge <PR-number>
 * - Checks a in-process lock (only one merge at a time)
 * - Merges the PR via GitHub API
 * - Polls the triggered web-image CI run until complete
 * - Posts results back to the Slack channel
 * - Releases the lock when done (success or failure)
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────

const {
  SLACK_SIGNING_SECRET,  // from Slack app Basic Information page
  SLACK_BOT_TOKEN,       // Bot OAuth token (xoxb-…)
  SLACK_CHANNEL_ID,      // Channel ID to post status messages
  GITHUB_TOKEN,          // PAT with repo + workflow scope
} = process.env;

const REPO     = 'REBUS-Industries/prism';
const WORKFLOW = 'web.yml'; // the web-image workflow filename
const PORT     = 3456;

// ─── Lock ─────────────────────────────────────────────────────────────────────

/** @type {{ prNumber: number; userName: string; startedAt: number } | null} */
let lock = null;

// ─── Slack helpers ────────────────────────────────────────────────────────────

async function postToSlack(text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL_ID, text }),
  });
  const data = await res.json();
  if (!data.ok) console.error('Slack post failed:', data.error);
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────

const GH = (path, opts = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers ?? {}),
    },
  });

async function getPRInfo(prNumber) {
  const res = await GH(`/repos/${REPO}/pulls/${prNumber}`);
  if (!res.ok) return null;
  return res.json();
}

async function mergePR(prNumber) {
  const res = await GH(`/repos/${REPO}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merge_method: 'merge' }),
  });
  const body = await res.json();
  return { ok: res.ok, status: res.status, message: body.message ?? '' };
}

/** Poll for the web-image workflow run that started after `afterIso`. */
async function pollWorkflow(afterIso, maxMinutes = 12) {
  const deadline = Date.now() + maxMinutes * 60_000;
  while (Date.now() < deadline) {
    await sleep(15_000);
    const res  = await GH(
      `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5&branch=main`,
    );
    if (!res.ok) continue;
    const { workflow_runs: runs } = await res.json();
    // Find the first run created at or after the merge started
    const run = runs.find(r => r.created_at >= afterIso);
    if (!run) continue;
    if (run.status === 'completed') {
      return { conclusion: run.conclusion, url: run.html_url };
    }
  }
  return { conclusion: 'timeout', url: null };
}

// ─── Main merge flow (runs in background) ─────────────────────────────────────

async function doMerge(prNumber, userName) {
  const startIso = new Date().toISOString();
  try {
    const merge = await mergePR(prNumber);
    if (!merge.ok) {
      const reason = merge.status === 405
        ? 'PR is not mergeable (conflicts or CI failing)'
        : merge.message || `HTTP ${merge.status}`;
      await postToSlack(`:x: Failed to merge PR #${prNumber}: ${reason}`);
      return;
    }

    await postToSlack(
      `:merged: PR #${prNumber} merged by ${userName} — waiting for prism-dev deploy…`,
    );

    const result = await pollWorkflow(startIso);

    if (result.conclusion === 'success') {
      await postToSlack(
        `:white_check_mark: *PR #${prNumber} is live on prism-dev.* <${result.url}|View CI run>`,
      );
    } else if (result.conclusion === 'timeout') {
      await postToSlack(
        `:warning: PR #${prNumber} merged but the CI deploy timed out — check <https://github.com/${REPO}/actions|GitHub Actions> manually.`,
      );
    } else {
      await postToSlack(
        `:x: PR #${prNumber} merged but deploy *${result.conclusion}*. <${result.url}|View CI run>`,
      );
    }
  } catch (err) {
    console.error('doMerge error:', err);
    await postToSlack(`:x: Unexpected error merging PR #${prNumber}: ${err.message}`);
  } finally {
    lock = null;
    console.log(`Lock released (PR #${prNumber})`);
  }
}

// ─── Slack signature verification ─────────────────────────────────────────────

function verifySlackSignature(req) {
  const ts  = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return false;
  // Reject requests older than 5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base     = `v0:${ts}:${req.rawBody}`;
  const expected = 'v0=' + crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(base)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

// Capture raw body for Slack signature verification
app.use(express.urlencoded({
  extended: true,
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));

// Health check
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    locked: !!lock,
    lock: lock
      ? { prNumber: lock.prNumber, userName: lock.userName, ageSeconds: Math.round((Date.now() - lock.startedAt) / 1000) }
      : null,
  });
});

// /prism-merge slash command
app.post('/merge', async (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(401).json({ error: 'Invalid Slack signature' });
  }

  const text     = (req.body.text || '').trim();
  const userName = req.body.user_name || 'unknown';
  const prNumber = parseInt(text, 10);

  // Usage help
  if (!prNumber || isNaN(prNumber)) {
    return res.json({
      response_type: 'ephemeral',
      text: 'Usage: `/prism-merge <PR-number>`\nExample: `/prism-merge 42`\n\nMerges the PR and deploys to prism-dev. Only one merge is allowed at a time.',
    });
  }

  // Lock check
  if (lock) {
    const age = Math.round((Date.now() - lock.startedAt) / 1000 / 60);
    return res.json({
      response_type: 'ephemeral',
      text: `:lock: A merge is already in progress: *PR #${lock.prNumber}* by ${lock.userName} (${age}m ago).\nWait for it to complete before merging another PR.`,
    });
  }

  // Quick PR existence check
  const pr = await getPRInfo(prNumber).catch(() => null);
  if (!pr) {
    return res.json({
      response_type: 'ephemeral',
      text: `:x: PR #${prNumber} not found in ${REPO}.`,
    });
  }
  if (pr.state !== 'open') {
    return res.json({
      response_type: 'ephemeral',
      text: `:x: PR #${prNumber} is already *${pr.state}* — nothing to merge.`,
    });
  }

  // Acquire lock
  lock = { prNumber, userName: `@${userName}`, startedAt: Date.now() };
  console.log(`Lock acquired: PR #${prNumber} by @${userName}`);

  // Respond to Slack immediately (must be < 3s) then do work in background
  res.json({
    response_type: 'in_channel',
    text: `:hourglass_flowing_sand: *@${userName}* is merging PR #${prNumber}: _${pr.title}_`,
  });

  doMerge(prNumber, `@${userName}`).catch(console.error);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const missing = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID', 'GITHUB_TOKEN']
  .filter(k => !process.env[k]);

if (missing.length) {
  console.error('Missing required env vars:', missing.join(', '));
  process.exit(1);
}

app.listen(PORT, () => console.log(`Merge bot listening on :${PORT}`));

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
