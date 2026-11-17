#!/usr/bin/env node
/**
 * CORPUS ULTIMATE — deployment freshness check.
 *
 * Answers one question, from evidence instead of assumption:
 * **are the live Render services running the code that is in this checkout?**
 *
 * A merged commit on `main` is not proof of a deployment (that mistake cost two
 * incident reports). This script compares the live services with the repository:
 *
 *   1. GET <API>/api/v1/version  -> build_id must equal BUILD_ID in
 *      backend/app/api/endpoints/version.py, every FEATURES marker listed there
 *      must be reported by the running process, and (when known) commit must
 *      equal --expected-commit / EXPECTED_COMMIT.
 *   2. GET <WEB>/version.json    -> buildId must equal frontend/version.json.
 *   3. GET <WEB>/js/datasets.js, /css/responsive.css and /index.html -> must
 *      contain the shipped markers (mobile file-picker overlay, tap-to-open
 *      zone, large-display/TV breakpoints, responsive viewport), i.e. the
 *      actual code is being served and not just a matching build id.
 *
 * Exits 0 only when everything matches. Exits 1 with actionable output
 * otherwise, so CI fails instead of silently shipping a stale build.
 *
 * Dependency-free: needs Node 18+ (global fetch). That keeps it runnable in
 * this repository, which has no runtime dependencies.
 *
 * Usage:
 *   node scripts/verify-deployment.mjs
 *   node scripts/verify-deployment.mjs --api https://... --web https://...
 *   EXPECTED_COMMIT=<sha> WAIT_SECONDS=600 node scripts/verify-deployment.mjs
 *
 * Environment:
 *   API_BASE_URL           backend base URL  (default: the Render service)
 *   WEB_URL                frontend base URL (default: the Render service)
 *   EXPECTED_COMMIT        git SHA that must be deployed (optional)
 *   WAIT_SECONDS           poll for up to N seconds before failing (default 0);
 *                          useful right after a push while Render builds
 *   POLL_INTERVAL_SECONDS  delay between attempts (default 20)
 *   REQUEST_TIMEOUT_MS     per-request timeout (default 30000)
 *   SKIP_ASSET_MARKERS=1   skip check 3 (only build ids are compared)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Markers that must be present in the *served* assets. Build ids alone cannot
// catch a static host that is serving cached/old files, so the exact code paths
// that mobile and large-screen users depend on are checked byte-for-byte.
const ASSET_MARKERS = [
  {
    path: '/js/datasets.js',
    marker: 'drop-zone-input',
    label: 'mobile file-picker overlay',
    detail: 'datasetAssetHasPickerOverlay',
  },
  {
    path: '/js/datasets.js',
    marker: 'datasets-drop',
    label: 'tap-to-open dataset picker zone',
    detail: 'datasetAssetHasTapZone',
  },
  {
    path: '/js/router.js',
    marker: 'CORPUS_MODULE_LOADER',
    label: 'page-module recovery (re-request with cache-bust)',
    detail: 'routerHasModuleRecovery',
  },
  {
    path: '/css/responsive.css',
    marker: 'min-aspect-ratio: 21/9',
    label: 'large-display / TV scaling breakpoints',
    detail: 'cssHasLargeDisplayBreakpoints',
  },
  {
    path: '/index.html',
    marker: 'width=device-width',
    label: 'responsive viewport meta tag',
    detail: 'htmlHasViewportMeta',
  },
];

function parseArgs(argv) {
  const args = { api: null, web: null, expectedCommit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--api') {
      args.api = argv[i + 1];
      i += 1;
    } else if (arg === '--web') {
      args.web = argv[i + 1];
      i += 1;
    } else if (arg === '--expected-commit') {
      args.expectedCommit = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const API = (args.api || process.env.API_BASE_URL || 'https://corpus-ultimate-api.onrender.com').replace(/\/+$/, '');
const WEB = (args.web || process.env.WEB_URL || 'https://corpus-ultimate-web.onrender.com').replace(/\/+$/, '');
const EXPECTED_COMMIT = (args.expectedCommit || process.env.EXPECTED_COMMIT || '').trim().toLowerCase();
const WAIT_SECONDS = Number(process.env.WAIT_SECONDS || 0);
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 20);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
// Render free instances answer the first request after idle with an
// "Application loading" splash; wait and retry instead of failing.
const COLD_START_RETRIES = Number(process.env.COLD_START_RETRIES || 3);
const COLD_START_RETRY_DELAY_MS = Number(process.env.COLD_START_RETRY_DELAY_MS || 15000);
const SKIP_ASSET_MARKERS = process.env.SKIP_ASSET_MARKERS === '1';

function expectedBackendBuildId() {
  const file = path.join(ROOT, 'backend', 'app', 'api', 'endpoints', 'version.py');
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/^BUILD_ID\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`could not find BUILD_ID in ${path.relative(ROOT, file)}`);
  }
  return match[1];
}

function expectedFeatures() {
  const file = path.join(ROOT, 'backend', 'app', 'api', 'endpoints', 'version.py');
  const source = fs.readFileSync(file, 'utf8');
  const block = source.match(/^FEATURES\s*=\s*\[([^\]]*)\]/m);
  if (!block) {
    throw new Error(`could not find FEATURES in ${path.relative(ROOT, file)}`);
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function expectedFrontendBuildId() {
  const file = path.join(ROOT, 'frontend', 'version.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed.buildId) {
    throw new Error(`frontend/version.json has no buildId`);
  }
  return parsed.buildId;
}

async function httpGet(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json, text/plain, */*', 'cache-control': 'no-cache' },
      redirect: 'follow',
    });
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    return { status: response.status, contentType, body };
  } finally {
    clearTimeout(timer);
  }
}

function isJson(contentType, body) {
  if (contentType.includes('json')) return true;
  const trimmed = body.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * Render free instances answer the first request after idle with an
 * "Application loading" HTML splash (~60 s). Retry those a few times instead of
 * reporting the service as broken.
 */
async function getJson(url, {
  coldStartRetries = COLD_START_RETRIES,
  coldStartDelayMs = COLD_START_RETRY_DELAY_MS,
} = {}) {
  let last = null;
  for (let attempt = 0; attempt <= coldStartRetries; attempt += 1) {
    const response = await httpGet(url);
    last = response;
    if (response.status === 200 && isJson(response.contentType, response.body)) {
      try {
        return { ok: true, status: response.status, json: JSON.parse(response.body) };
      } catch (err) {
        last = { ...response, parseError: err.message };
      }
    }
    const coldStart = response.status === 200 && !isJson(response.contentType, response.body);
    if (!coldStart && response.status !== 502 && response.status !== 503 && response.status !== 504) {
      break;
    }
    if (attempt < coldStartRetries) {
      await new Promise((resolve) => setTimeout(resolve, coldStartDelayMs));
    }
  }
  return {
    ok: false,
    status: last ? last.status : 0,
    body: last ? last.body : '',
    contentType: last ? last.contentType : '',
  };
}

/** Human-readable fetch failure, including the underlying socket/DNS/TLS code. */
function describeFetchError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError') return 'request timed out';
  const cause = err.cause && (err.cause.code || err.cause.message);
  return cause ? `${err.message} (${cause})` : err.message;
}

function shortCommit(value) {
  if (!value) return '';
  return String(value).slice(0, 12);
}

async function checkBackend(expectedBuildId, expectedFeaturesLocal) {
  const result = { ok: true, problems: [], notes: [], details: {} };
  const url = `${API}/api/v1/version`;
  let response;
  try {
    response = await getJson(url);
  } catch (err) {
    result.ok = false;
    result.problems.push(
      `could not reach ${url} (${describeFetchError(err)}). ` +
        `Check the service is up, API_BASE_URL is correct, and that this runner is allowed to ` +
        `make outbound requests to it.`
    );
    return result;
  }

  if (!response.ok) {
    result.ok = false;
    if (response.status === 404 || (response.body || '').includes('detail')) {
      result.problems.push(
        `${url} -> ${response.status} Not Found. The running API does not expose the version route at all, ` +
          `so it is OLDER than build ${expectedBuildId}: redeploy corpus-ultimate-api from main ` +
          `(Render → Manual Deploy → Deploy latest commit).`
      );
    } else {
      result.problems.push(`${url} -> ${response.status || 'no response'} (expected 200 JSON).`);
    }
    result.details.apiBuild = 'unknown (route missing)';
    return result;
  }

  const body = response.json || {};
  result.details.apiBuild = body.build_id || '(missing)';
  result.details.apiCommit = body.commit || null;
  result.details.apiService = body.service || null;
  result.details.apiFeatures = Array.isArray(body.features) ? body.features : [];

  if (!body.build_id) {
    result.ok = false;
    result.problems.push(
      `${url} responded without build_id — the deployed API predates the version endpoint's build marker.`
    );
  } else if (body.build_id !== expectedBuildId) {
    result.ok = false;
    result.problems.push(
      `API build_id is ${body.build_id} but this checkout expects ${expectedBuildId}. ` +
        `The deployment is stale: redeploy corpus-ultimate-api from main.`
    );
  }

  if (EXPECTED_COMMIT) {
    if (!body.commit) {
      result.notes.push(
        `API reports no commit (RENDER_GIT_COMMIT unset) — cannot compare against ${shortCommit(EXPECTED_COMMIT)}. ` +
          `Confirm the service is deployed from this repository with Auto-Deploy on.`
      );
    } else if (String(body.commit).toLowerCase() !== EXPECTED_COMMIT) {
      result.ok = false;
      result.problems.push(
        `API is running commit ${shortCommit(body.commit)} but this run expects ${shortCommit(EXPECTED_COMMIT)}. ` +
          `The service is deploying a different commit/branch than main.`
      );
    }
  }

  // Every marker declared in this checkout must be reported by the running API.
  // A missing marker means the deployed build predates the corresponding fix,
  // even when the build id happens to match.
  const missing = result.details.apiFeatures.length
    ? expectedFeaturesLocal.filter((feature) => !result.details.apiFeatures.includes(feature))
    : expectedFeaturesLocal;
  if (missing.length) {
    result.ok = false;
    result.problems.push(
      `API feature markers are missing ${missing.map((f) => `"${f}"`).join(', ')} — ` +
        `the deployed build predates the fix(es) these markers describe.`
    );
  }

  return result;
}

async function checkFrontend(expectedBuildId) {
  const result = { ok: true, problems: [], notes: [], details: {} };
  const versionUrl = `${WEB}/version.json`;

  let response;
  try {
    response = await getJson(versionUrl, { coldStartRetries: 1 });
  } catch (err) {
    result.ok = false;
    result.problems.push(`could not reach ${versionUrl} (${describeFetchError(err)}).`);
    return result;
  }

  if (!response.ok) {
    result.ok = false;
    result.problems.push(
      `${versionUrl} -> ${response.status || 'no response'}. The static site does not serve version.json, ` +
        `so it is serving a build older than ${expectedBuildId}: redeploy corpus-ultimate-web from main ` +
        `(Publish Directory must be frontend/).`
    );
    result.details.webBuild = 'unknown (version.json missing)';
  } else {
    const buildId = (response.json || {}).buildId;
    result.details.webBuild = buildId || '(missing)';
    if (buildId !== expectedBuildId) {
      result.ok = false;
      result.problems.push(
        `frontend buildId is ${buildId || '(missing)'} but this checkout expects ${expectedBuildId}. ` +
          `The deployment is stale: redeploy corpus-ultimate-web from main.`
      );
    }
  }

  if (!SKIP_ASSET_MARKERS) {
    const fetched = new Map();
    for (const { path: assetPath, marker, label, detail } of ASSET_MARKERS) {
      const assetUrl = `${WEB}${assetPath}`;
      try {
        if (!fetched.has(assetUrl)) fetched.set(assetUrl, await httpGet(assetUrl));
        const asset = fetched.get(assetUrl);
        const served = asset.status === 200 ? asset.body : '';
        const found = served.includes(marker);
        result.details[detail] = found;
        if (asset.status !== 200) {
          result.ok = false;
          result.problems.push(`${assetUrl} -> ${asset.status} (expected 200).`);
        } else if (!found) {
          result.ok = false;
          result.problems.push(
            `${assetUrl} does not contain "${marker}", so the served files predate the ${label}. ` +
              `Hard-reload/redeploy corpus-ultimate-web.`
          );
        }
      } catch (err) {
        result.ok = false;
        result.problems.push(`could not reach ${assetUrl} (${describeFetchError(err)}).`);
      }
    }
  }

  return result;
}

function printReport(backend, frontend, expected) {
  const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);
  console.log('');
  console.log('Deployment freshness report');
  console.log('─'.repeat(78));
  console.log(`  expected backend build_id   ${expected.backend}`);
  console.log(`  expected frontend buildId   ${expected.frontend}`);
  console.log(`  required API features       ${expected.features.join(', ') || '(none)'}`);
  if (EXPECTED_COMMIT) console.log(`  expected commit             ${shortCommit(EXPECTED_COMMIT)}`);
  console.log('');
  line('API service', backend.details.apiService || API);
  line('API build_id', backend.details.apiBuild || '(unreachable)');
  line('API commit', backend.details.apiCommit ? shortCommit(backend.details.apiCommit) : '(not reported)');
  line('frontend buildId', frontend.details.webBuild || '(unreachable)');
  if (!SKIP_ASSET_MARKERS) {
    line('picker overlay served', frontend.details.datasetAssetHasPickerOverlay === true ? 'yes' : 'no');
    line('tap-to-open zone served', frontend.details.datasetAssetHasTapZone === true ? 'yes' : 'no');
    line('module recovery served', frontend.details.routerHasModuleRecovery === true ? 'yes' : 'no');
    line('large-display CSS served', frontend.details.cssHasLargeDisplayBreakpoints === true ? 'yes' : 'no');
    line('viewport meta served', frontend.details.htmlHasViewportMeta === true ? 'yes' : 'no');
  }
  console.log('');

  const problems = [...backend.problems, ...frontend.problems];
  const notes = [...backend.notes, ...frontend.notes];
  for (const note of notes) console.log(`  note: ${note}`);
  if (notes.length) console.log('');

  if (problems.length === 0) {
    console.log('  RESULT: live services match this checkout.');
    console.log('─'.repeat(78));
    return 0;
  }
  console.log('  RESULT: the live deployment does NOT match this checkout.');
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log('─'.repeat(78));
  console.log('  Fix: Render → service → Settings (Repository, Branch = main, Auto-Deploy on)');
  console.log('       → Manual Deploy → Deploy latest commit → check the build log.');
  console.log('  Details: docs/PRODUCTION_VERIFICATION.md');
  return 1;
}

async function main() {
  let expected;
  try {
    expected = {
      backend: expectedBackendBuildId(),
      frontend: expectedFrontendBuildId(),
      features: expectedFeatures(),
    };
  } catch (err) {
    console.error(`verify-deployment: ${err.message}`);
    return 2;
  }

  const deadline = Date.now() + Math.max(0, WAIT_SECONDS) * 1000;
  let backend;
  let frontend;

  for (;;) {
    backend = await checkBackend(expected.backend, expected.features);
    frontend = await checkFrontend(expected.frontend);
    if (backend.ok && frontend.ok) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    console.log(
      `deployment not ready yet — retrying in ${POLL_INTERVAL_SECONDS}s ` +
        `(${Math.ceil(remaining / 1000)}s left before this check fails)`
    );
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_SECONDS * 1000, remaining)));
  }

  return printReport(backend, frontend, expected);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`verify-deployment failed: ${err && err.stack ? err.stack : err}`);
    process.exit(2);
  });
