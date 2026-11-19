/* Provider Management card structure.
 * The five-column models table used to overflow the page on a phone; the card
 * now uses responsive model cards, wraps endpoints/fingerprints, keeps
 * credentials masked and preserves every action button.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './harness.mjs';

const openApps = [];
function app(options) {
  const value = createApp(options);
  openApps.push(value);
  return value;
}
after(() => {
  while (openApps.length) {
    const instance = openApps.pop();
    try { instance.dom.window.close(); } catch (err) { /* already closed */ }
  }
});

function providerFixture() {
  return {
    id: 'prov_openai',
    name: 'OpenAI primary',
    provider_type: 'openai',
    enabled: true,
    status: 'connected',
    base_url: 'https://api.example-very-long-endpoint-for-overflow-testing.invalid/v1/beta',
    default_teacher_model: 'vendor/extremely-long-model-identifier-for-wrapping',
    credential_hint: '••••6789',
    credential_fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    last_tested_at: null,
    last_error: null,
    capabilities: { teacher_inference: true, synthetic_data_generation: true },
  };
}

test('provider card renders responsive model cards, no raw table, wraps long identifiers', () => {
  const instance = app({});
  instance.window.teachers._state(); // touch state init
  const provider = providerFixture();
  // Seed the module's model cache through the state accessor path: providerCard
  // reads STATE.models via modelsFor, so render through the module by injecting
  // models into the exposed state object is not possible; instead we assert the
  // structural contract of the card itself with no models.
  const html = instance.window.teachers._providerCard(provider);
  const root = instance.doc.createElement('div');
  root.innerHTML = html;

  assert.ok(!root.querySelector('table'), 'the tabular models dump is gone from the card');
  assert.ok(root.querySelector('.provider-endpoint'), 'endpoint URL has a wrapping hook');
  assert.match(root.querySelector('.provider-endpoint').textContent, /api\.example-very-long-endpoint/);
  assert.ok(root.querySelector('.provider-fingerprint'), 'fingerprint has a wrapping hook');
  assert.match(root.querySelector('.model-card-list').textContent, /No models yet/);

  // Credentials stay masked: only the hint and fingerprint appear, never a key.
  assert.match(root.textContent, /••••6789/);
  assert.doesNotMatch(root.textContent, /sk-/i);

  // Every action is preserved.
  const actions = Array.from(root.querySelectorAll('.actions-row button')).map((b) => b.textContent.trim());
  assert.ok(actions.some((t) => /Test connection/.test(t)));
  assert.ok(actions.some((t) => /Discover models/.test(t)));
  assert.ok(actions.some((t) => /Disable/.test(t)));
  assert.ok(actions.some((t) => /Revoke key/.test(t)));

  // Capability chips render truthfully and wrap via chip-row.
  const chips = Array.from(root.querySelectorAll('.chip-row .chip')).map((c) => c.textContent.trim());
  assert.ok(chips.some((t) => /Teacher inference/.test(t)));
  assert.ok(chips.some((t) => /unverified|fine-tuning/i.test(t)), 'fine-tuning capability is reported, not assumed');
});
