/**
 * Tests for scripts/verify-deployment.mjs.
 *
 * The script is the only thing that will notice "GitHub has the fix, Render
 * serves an old build", so its verdict has to be trustworthy: fresh services
 * pass, stale ones fail, and Render's cold-start splash is not mistaken for a
 * broken deployment.
 *
 * Each case runs the real CLI against a local HTTP server (no network).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify-deployment.mjs');

function expectedBuilds() {
  const backendSource = fs.readFileSync(
    path.join(ROOT, 'backend', 'app', 'api', 'endpoints', 'version.py'),
    'utf8'
  );
  const backend = backendSource.match(/^BUILD_ID\s*=\s*"([^"]+)"/m);
  assert.ok(backend, 'BUILD_ID is declared in version.py');
  const frontend = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'frontend', 'version.json'), 'utf8')
  ).buildId;
  const featuresBlock = backendSource.match(/^FEATURES\s*=\s*\[([^\]]*)\]/m);
  const features = [...featuresBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(features.length > 0, 'FEATURES is declared in version.py');
  return { backend: backend[1], frontend, features };
}

/** Local site whose responses are controlled per test. */
async function startSite(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function runVerify(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, COLD_START_RETRY_DELAY_MS: '50', REQUEST_TIMEOUT_MS: '5000', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Exactly the markers scripts/verify-deployment.mjs demands from the served
// assets, so a "current" mock site really does look like a current deployment.
const SHIPPED_ASSETS = {
  '/js/datasets.js': 'const overlay = "drop-zone-input"; const zone = "datasets-drop";',
  '/js/router.js': 'if (typeof window.CORPUS_MODULE_LOADER === \'function\') { /* recovery */ }',
  '/css/responsive.css': '@media (min-aspect-ratio: 21/9) and (min-width: 1600px) { :root { --page-max: min(2100px, 78vw); } }',
  '/index.html': '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">',
};

function serveShippedAssets(req, res) {
  const body = SHIPPED_ASSETS[req.url];
  if (body === undefined) {
    res.writeHead(404);
    return res.end();
  }
  const type = req.url.endsWith('.css')
    ? 'text/css'
    : req.url.endsWith('.js') ? 'application/javascript' : 'text/html';
  res.writeHead(200, { 'content-type': type });
  return res.end(body);
}

test('a deployment that matches this checkout passes', async () => {
  const builds = expectedBuilds();
  const site = await startSite((req, res) => {
    if (req.url === '/api/v1/version') {
      return json(res, 200, {
        service: 'corpus-ultimate-api',
        build_id: builds.backend,
        commit: 'a'.repeat(40),
        features: builds.features,
      });
    }
    if (req.url === '/version.json') return json(res, 200, { buildId: builds.frontend });
    return serveShippedAssets(req, res);
  });

  try {
    const result = await runVerify(
      ['--api', site.url, '--web', site.url],
      { EXPECTED_COMMIT: 'a'.repeat(40) }
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /live services match this checkout/);
  } finally {
    await site.close();
  }
});

test('a stale deployment fails with an actionable message', async () => {
  const site = await startSite((req, res) => {
    if (req.url === '/api/v1/version') return json(res, 404, { detail: 'Not Found' });
    if (req.url === '/version.json') { res.writeHead(404); return res.end('Not Found'); }
    // Pre-modernisation datasets.js: no overlay input.
    res.writeHead(200, { 'content-type': 'application/javascript' });
    return res.end('const file = fileInput.files[0];');
  });

  try {
    const result = await runVerify(['--api', site.url, '--web', site.url]);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /does NOT match this checkout/);
    assert.match(result.stdout, /does not expose the version route/);
    assert.match(result.stdout, /does not serve version.json/);
    assert.match(result.stdout, /predate the\s+mobile file-picker overlay/);
    assert.match(result.stdout, /predate the\s+large-display \/ TV scaling breakpoints/);
    assert.match(result.stdout, /picker overlay served\s+no/);
    assert.match(result.stdout, /module recovery served\s+no/);
  } finally {
    await site.close();
  }
});

test('an old frontend buildId fails even when the API is current', async () => {
  const builds = expectedBuilds();
  const site = await startSite((req, res) => {
    if (req.url === '/api/v1/version') {
      return json(res, 200, {
        service: 'corpus-ultimate-api',
        build_id: builds.backend,
        commit: null,
        features: builds.features,
      });
    }
    if (req.url === '/version.json') return json(res, 200, { buildId: '2026-01-01.0' });
    return serveShippedAssets(req, res);
  });

  try {
    const result = await runVerify(['--api', site.url, '--web', site.url]);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /frontend buildId is 2026-01-01\.0/);
    // A service that reports no commit is a note, not a failure on its own.
    assert.match(result.stdout, /RESULT: the live deployment does NOT match/);
  } finally {
    await site.close();
  }
});

test("Render's cold-start splash is retried, not reported as broken", async () => {
  const builds = expectedBuilds();
  let apiHits = 0;
  const site = await startSite((req, res) => {
    if (req.url === '/api/v1/version') {
      apiHits += 1;
      if (apiHits === 1) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html><body>Render - Application loading</body></html>');
      }
      return json(res, 200, {
        service: 'corpus-ultimate-api',
        build_id: builds.backend,
        commit: null,
        features: builds.features,
      });
    }
    if (req.url === '/version.json') return json(res, 200, { buildId: builds.frontend });
    return serveShippedAssets(req, res);
  });

  try {
    const result = await runVerify(['--api', site.url, '--web', site.url]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok(apiHits >= 2, 'the cold-start response was retried');
  } finally {
    await site.close();
  }
});

test('missing feature markers fail (proves the deployed build predates the fix)', async () => {
  const builds = expectedBuilds();
  const site = await startSite((req, res) => {
    if (req.url === '/api/v1/version') {
      return json(res, 200, { service: 'corpus-ultimate-api', build_id: builds.backend, commit: null, features: [] });
    }
    if (req.url === '/version.json') return json(res, 200, { buildId: builds.frontend });
    return serveShippedAssets(req, res);
  });

  try {
    const result = await runVerify(['--api', site.url, '--web', site.url]);
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /feature markers are missing/);
    assert.match(result.stdout, /predates the fix/);
  } finally {
    await site.close();
  }
});
