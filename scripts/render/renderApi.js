// Minimal Render REST API client shared by the deploy scripts.
// The API key comes from RENDER_API_KEY, or (for local terminal use) from
// ~/.render/api_key so it never has to be typed into a shell history.
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'https://api.render.com/v1';

function apiKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY.trim();
  const file = path.join(os.homedir(), '.render', 'api_key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  throw new Error(`no Render API key: set RENDER_API_KEY or write it to ${file}`);
}

async function render(method, urlPath, body) {
  const res = await fetch(API + urlPath, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: 'application/json',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${text}`);
  return data;
}

// List endpoints are cursor-paginated: [{ <item>, cursor }, ...]
async function listAll(urlPath, itemKey) {
  const items = [];
  let cursor;
  for (;;) {
    const sep = urlPath.includes('?') ? '&' : '?';
    const page = await render('GET', `${urlPath}${sep}limit=100${cursor ? `&cursor=${cursor}` : ''}`);
    items.push(...page.map(p => p[itemKey]));
    if (page.length < 100) return items;
    cursor = page[page.length - 1].cursor;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const TERMINAL_OK = new Set(['live']);
const TERMINAL_BAD = new Set(['build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed']);

// Polls a deploy until it is live (resolve) or reaches a failed state (throw).
async function waitForDeploy(serviceId, deployId, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const deploy = await render('GET', `/services/${serviceId}/deploys/${deployId}`);
    if (deploy.status !== last) console.log(`[render] deploy ${deployId}: ${deploy.status}`);
    last = deploy.status;
    if (TERMINAL_OK.has(deploy.status)) return deploy;
    if (TERMINAL_BAD.has(deploy.status)) throw new Error(`deploy ${deployId} ended as ${deploy.status}`);
    await sleep(10000);
  }
  throw new Error(`deploy ${deployId} not live after ${timeoutMs / 60000} min (last status: ${last})`);
}

module.exports = { render, listAll, waitForDeploy };
