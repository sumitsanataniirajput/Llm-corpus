/**
 * Build identity consistency.
 *
 * A stale cached script is what turns "we shipped the fix" into "the page says
 * the module is not loaded". One build id must therefore be used everywhere:
 *
 *   frontend/version.json  buildId
 *   frontend/js/config.js  CORPUS_CONFIG.BUILD_ID          (used to cache-bust
 *                                                           a page-module reload)
 *   frontend/index.html    <meta name="corpus-build"> and the ?v= on every local
 *                          stylesheet/script
 *
 * If those drift, a browser can serve one file from an old build next to a new
 * one. This test fails the build instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(FRONTEND_DIR, rel), 'utf8');

const version = JSON.parse(read('version.json'));
const indexHtml = read('index.html');
const configJs = read('js/config.js');

test('version.json has a buildId and a source ref', () => {
  assert.match(version.buildId, /^\d{4}-\d{2}-\d{2}\.\d+$/, 'buildId format YYYY-MM-DD.N');
  assert.ok(typeof version.sourceRef === 'string' && version.sourceRef.length > 0);
});

test('CORPUS_CONFIG.BUILD_ID matches frontend/version.json', () => {
  const match = configJs.match(/BUILD_ID:\s*'([^']+)'/);
  assert.ok(match, 'config.js must define BUILD_ID');
  assert.equal(match[1], version.buildId);
});

test('index.html exposes the same build id in </meta name="corpus-build">', () => {
  const meta = indexHtml.match(/<meta\s+name="corpus-build"\s+content="([^"]+)"/);
  assert.ok(meta, 'index.html must declare <meta name="corpus-build">');
  assert.equal(meta[1], version.buildId);
});

test('every local stylesheet and script is requested with the current ?v=', () => {
  const assets = [...indexHtml.matchAll(/(?:href|src)="((?:css|js)\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(assets.length >= 20, 'expected all local CSS/JS to be enumerated');
  for (const asset of assets) {
    assert.match(
      asset,
      new RegExp(`\\?v=${version.buildId.replace(/\./g, '\\.')}$`),
      `${asset} must carry ?v=${version.buildId}`
    );
  }
});

test('index.html loads the datasets module before the bootstrap', () => {
  const order = [...indexHtml.matchAll(/<script\s+src="(js\/[^"]+)"/g)].map((m) => m[1].split('?')[0]);
  const datasets = order.indexOf('js/datasets.js');
  const bootstrap = order.indexOf('js/app-bootstrap.js');
  const router = order.indexOf('js/router.js');
  assert.notEqual(datasets, -1, 'js/datasets.js is not loaded at all');
  assert.ok(router !== -1 && router < datasets, 'the router loads before the page modules');
  assert.ok(datasets < bootstrap, 'page modules load before app-bootstrap.js');
  assert.equal(order[order.length - 1], 'js/app-bootstrap.js', 'the bootstrap is the last script');
});

test('every script referenced by index.html exists on disk', () => {
  const scripts = [...indexHtml.matchAll(/<script\s+src="(js\/[^"]+)"/g)].map((m) => m[1].split('?')[0]);
  for (const rel of scripts) {
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, rel)), `${rel} is referenced but missing`);
  }
  const styles = [...indexHtml.matchAll(/href="(css\/[^"]+)"/g)].map((m) => m[1].split('?')[0]);
  for (const rel of styles) {
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, rel)), `${rel} is referenced but missing`);
  }
});

test('the backend build marker is independent and present', () => {
  const backend = fs.readFileSync(
    path.resolve(FRONTEND_DIR, '..', 'backend', 'app', 'api', 'endpoints', 'version.py'),
    'utf8'
  );
  const match = backend.match(/^BUILD_ID\s*=\s*"([^"]+)"/m);
  assert.ok(match, 'backend BUILD_ID must exist for the deployment check');
  assert.match(match[1], /^\d{4}-\d{2}-\d{2}\.\d+$/);
});
