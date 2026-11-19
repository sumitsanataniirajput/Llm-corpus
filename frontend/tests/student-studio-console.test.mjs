/* Student Model Studio inspection console.
 * Verifies the console renders real backend fields, never invents values, and
 * omits the trainable-percentage card when the backend did not measure it.
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

const CORPUS_INSPECTION = {
  name: 'Corpus Small',
  model_id: 'model_1',
  base_source: 'corpus',
  base_ref: null,
  architecture: {
    architecture: 'CorpusTransformerPT',
    architecture_version: 'corpus-pytorch-1',
    engine: 'pytorch',
    total_parameters: 16784896,
    trainable_parameters: 16784896,
    frozen_parameters: 0,
    trainable_percent: 100,
    embedding_dim: 512,
    hidden_dim: 512,
    intermediate_dim: 2048,
    layers: 8,
    attention_heads: 8,
    kv_heads: 8,
    vocab_size: 32000,
    context_window: 1024,
    dropout: 0.1,
    tokenizer: 'CorpusTokenizer (trained per dataset)',
    tokenizer_version: 'tok_v3.json',
    precision: 'float32',
    quantization: null,
    weight_size_bytes: 67139584,
    source: 'instantiated from the stored model config',
    parameter_breakdown: { 'layers.0.attention.w_q.weight': 262144, 'token_embedding.weight': 16384000 },
  },
  methods: {},
  compatibility: { reason: 'CORPUS checkpoints store a custom state dict.' },
};

test('console shows real measured values in overview cards and groups', () => {
  const instance = app({});
  const html = instance.window.students._inspectionConsole(CORPUS_INSPECTION);
  const root = instance.doc.createElement('div');
  root.innerHTML = html;
  const text = root.textContent;
  assert.match(text, /16,784,896/);
  assert.match(text, /100%/);
  assert.match(text, /CorpusTransformerPT/);
  assert.match(text, /corpus-pytorch-1/);
  assert.match(text, /CorpusTokenizer \(trained per dataset\)/);
  assert.match(text, /tok_v3\.json/);
  assert.match(text, /float32/);
  assert.doesNotMatch(text, /Not reported/);
  assert.ok(root.querySelector('.spec-groups'), 'groups container present');
  assert.ok(root.querySelectorAll('.spec-group').length >= 4, 'identity/dimensions/parameters/tokenizer groups');
  assert.ok(root.querySelector('.stats-grid'), 'overview grid present');
  // Advanced parameter breakdown is collapsible, not dumped inline.
  const details = root.querySelector('details.spec-advanced');
  assert.ok(details, 'breakdown is behind a details element');
  assert.match(details.textContent, /token_embedding\.weight/);
});

test('config-only HF inspection omits trainable share and reports missing fields', () => {
  const instance = app({});
  const hf = {
    name: 'demo-model',
    model_id: null,
    base_source: 'huggingface',
    base_ref: 'org/demo-model',
    architecture: {
      architecture: 'DemoForCausalLM',
      architecture_version: '4.36.0',
      engine: 'transformers',
      total_parameters: null,
      parameter_source: 'not measured — enable \'load weights\' to count them',
      trainable_parameters: null,
      frozen_parameters: null,
      trainable_percent: null,
      embedding_dim: 768,
      hidden_dim: 768,
      intermediate_dim: 3072,
      layers: 12,
      attention_heads: 12,
      kv_heads: 12,
      vocab_size: 50257,
      context_window: 2048,
      precision: 'float16',
      quantization: null,
      weight_size_bytes: null,
      tokenizer: 'GPT2TokenizerFast',
      tokenizer_version: 'org/demo-model',
      source: 'Hugging Face config',
    },
    methods: {},
    compatibility: { reason: 'Standard Hugging Face causal LM.' },
  };
  const html = instance.window.students._inspectionConsole(hf);
  const root = instance.doc.createElement('div');
  root.innerHTML = html;
  const text = root.textContent;
  // Measured config fields appear…
  assert.match(text, /DemoForCausalLM/);
  assert.match(text, /50,257/);
  assert.match(text, /GPT2TokenizerFast/);
  assert.match(text, /org\/demo-model/);
  assert.match(text, /not measured/);
  // …but unmeasured values are reported as such, never invented.
  assert.match(text, /Not reported/);
  const cards = Array.from(root.querySelectorAll('.stat-card')).map((card) => card.textContent);
  assert.ok(!cards.some((card) => /Trainable\s/.test(card) && /%/.test(card)),
    'no trainable-percentage card when the backend did not measure it');
  assert.ok(!root.querySelector('details.spec-advanced'), 'no breakdown without measured data');
  assert.equal(text.includes('16784896'), false, 'no hardcoded CORPUS values leak into an HF inspection');
});

test('empty architecture object renders groups with every value Not reported', () => {
  const instance = app({});
  const html = instance.window.students._inspectionConsole({ architecture: {}, methods: {} });
  const root = instance.doc.createElement('div');
  root.innerHTML = html;
  const text = root.textContent;
  assert.match(text, /Not reported/);
  assert.doesNotMatch(text, /undefined/);
  assert.doesNotMatch(text, /NaN/);
  assert.doesNotMatch(text, /null/);
});
