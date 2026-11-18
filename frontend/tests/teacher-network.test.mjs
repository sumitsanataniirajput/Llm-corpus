/**
 * AI Teacher Network, distillation review, student studio, intelligence, budgets.
 *
 * These tests run the REAL page modules against the harness' fetch stub, with the
 * teacher/distillation endpoints described through `extraRoutes`. The assertions
 * are about the promises the pages make: no key ever rendered, no invented spec,
 * "Unavailable" where the backend had nothing, and no request without consent.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp as createAppBase } from './harness.mjs';

const openApps = [];
function createApp(options) {
  const app = createAppBase(options);
  openApps.push(app);
  return app;
}

after(() => {
  while (openApps.length) {
    const app = openApps.pop();
    try { app.dom.window.close(); } catch (err) { /* already closed */ }
  }
});

const FULL_KEY = 'sk-live-SUPER-SECRET-0123456789';

function providersFixture() {
  return [{
    id: 'prov_openai',
    provider_type: 'openai',
    name: 'OpenAI primary',
    base_url: null,
    credential_hint: '••••6789',
    credential_fingerprint: 'a1b2c3d4',
    enabled: true,
    status: 'connected',
    last_error: null,
    last_tested_at: new Date().toISOString(),
    default_teacher_model: 'vendor/model-a',
    budget: { max_spend_usd_per_day: 2.5 },
    capabilities: {
      teacher_inference: true,
      synthetic_data_generation: true,
      provider_managed_finetuning: null,
      provider_managed_finetuning_evidence: 'fine-tuning access could not be verified',
      student_local_training: true,
    },
    models: [{
      id: 'tm_1', provider_id: 'prov_openai', model_id: 'vendor/model-a',
      display_name: 'Model A', context_window: null, max_output_tokens: null,
      input_price_per_million: null, output_price_per_million: null,
      price_source: null, discovered: true, enabled: true,
    }],
  }];
}

function baseRoutes(overrides = {}) {
  const routes = [
    { method: 'GET', match: '/api/v1/teachers/types', respond: () => json({
      provider_types: [
        { key: 'openai', label: 'OpenAI', requires_base_url: false, default_base_url: 'https://api.openai.com/v1' },
        { key: 'custom', label: 'Custom OpenAI-compatible', requires_base_url: true, default_base_url: '' },
      ],
    }) },
    { method: 'GET', match: '/api/v1/teachers/credential-status', respond: () => json({
      encryption_configured: true, algorithm: 'AES-256-GCM', message: null,
    }) },
    { method: 'GET', match: '/api/v1/teachers/providers', respond: () => json({
      providers: providersFixture(), credential_encryption_configured: true,
    }) },
    { method: 'GET', match: '/api/v1/teachers/models', respond: () => json({
      models: providersFixture()[0].models,
    }) },
    { method: 'GET', match: '/api/v1/teachers/usage', respond: () => json({
      providers: [{
        provider_id: 'prov_openai', name: 'OpenAI primary', provider_type: 'openai',
        requests: 4, successes: 3, failures: 1, rate_limit_errors: 0,
        input_tokens: 480, output_tokens: 240, total_tokens: 720, cached_tokens: 0,
        estimated_cost: 0.0021, unpriced_requests: 2, avg_latency_ms: 812,
        last_request_at: new Date().toISOString(), spend_24h: 0.0021, requests_24h: 4,
        budget: { max_spend_usd_per_day: 2.5 },
      }],
      totals: { requests: 4, input_tokens: 480, output_tokens: 240, total_tokens: 720, estimated_cost: 0.0021 },
      pricing_note: 'Requests without a price are counted as unpriced instead of being estimated.',
    }) },
    { method: 'GET', match: '/api/v1/datasets', respond: () => json([
      { id: 'ds_1', name: 'Wiki corpus', format: 'txt', size: 2048, status: 'ready', has_file: true },
    ]) },
    { method: 'GET', match: '/api/v1/distillation/options', respond: () => json({
      modes: {
        single: { label: 'A — Single teacher' },
        multi: { label: 'B — Multiple independent answers' },
        evaluator: { label: 'C — Teacher + evaluator' },
        competition: { label: 'D — Competition' },
        specialized: { label: 'E — Specialised by domain' },
      },
      task_types: { instruction: { label: 'Instruction following' }, qa: { label: 'Question & answer' } },
      languages: { en: 'English', hi: 'Hindi' },
      subjects: ['mathematics', 'science'],
      difficulties: ['beginner', 'intermediate'],
      output_formats: [{ key: 'chat_jsonl', label: 'Conversational JSONL' }],
      quality_defaults: { min_quality_score: 0.6, min_chars: 40 },
      budget_defaults: { max_requests: 200, max_spend_usd: 5 },
      max_examples_per_run: 200,
      max_source_chars: 60000,
    }) },
    { method: 'GET', match: '/api/v1/distillation/jobs', respond: () => json({
      jobs: [{
        id: 'dj_1', mode: 'single', status: 'review', source_dataset_name: 'source.txt',
        counts: { total: 3, accepted: 2, pending: 1 }, created_at: new Date().toISOString(),
      }],
    }) },
    { method: 'GET', match: /^\/api\/v1\/distillation\/jobs\/dj_1$/, respond: () => json({
      id: 'dj_1', mode: 'single', status: 'review', dataset_id: 'ds_1',
      generation_config: { count: 3 }, progress: {
        generated: 3, accepted: 2, rejected: 0, duplicates: 1, failed_calls: 0,
        budget: { stop_reason: null },
      },
      counts: { total: 3, accepted: 2, pending: 1, rejected: 0, duplicates: 1 },
      error: null,
    }) },
    { method: 'GET', match: /^\/api\/v1\/distillation\/jobs\/dj_1\/summary$/, respond: () => json({
      job_id: 'dj_1', status: 'review', mode: 'single',
      counts: { total: 3, accepted: 2, rejected: 0, pending: 1, duplicates: 1 },
      percentages: { accepted: 66.7 },
      validation_failures: 0,
      by_language: [{ language: 'en', total: 3, accepted: 2 }],
      by_subject: [{ subject: 'science', total: 3, accepted: 2 }],
      teacher_contribution: [{ provider_name: 'OpenAI primary', model_id: 'vendor/model-a', total: 3, accepted: 2, rejected: 0, share_percent: 100 }],
      quality: { avg_score: 0.83, min_score: 0.7, max_score: 0.95 },
      usage: { requests: 3, successes: 3, failures: 0, rate_limited: 0, budget_blocked: 0,
               input_tokens: 360, output_tokens: 180, total_tokens: 540, estimated_cost: 0.0,
               avg_latency_ms: 640, cost_note: 'priced only' },
      evaluations: { total: 0, avg_mean_score: null, accepts: 0, rejects: 0 },
      teacher_disagreements: [], budget: {}, progress: {}, error: null,
    }) },
    { method: 'GET', match: /^\/api\/v1\/distillation\/jobs\/dj_1\/records/, respond: () => json({
      job_id: 'dj_1', total: 1, limit: 25, offset: 0,
      records: [{
        id: 'rec_1', job_id: 'dj_1',
        instruction: 'Explain photosynthesis briefly.',
        target: 'Plants convert light energy into chemical energy stored in sugars.',
        chosen: null, rejected: null,
        task_type: 'instruction', difficulty: 'beginner', language: 'en', subject: 'science',
        provenance: { provider_name: 'OpenAI primary', model_id: 'vendor/model-a',
                      request_id: 'cmpl-abcdef123456789', usage: { input_tokens: 120, output_tokens: 60 } },
        validation: { status: 'accepted', score: 0.8, checks: {}, reasons: [] },
        quality_score: 0.8, status: 'accepted', reviewed_by_human: false,
        created_at: new Date().toISOString(),
      }],
    }) },
    { method: 'POST', match: /^\/api\/v1\/distillation\/jobs\/dj_1\/records\/bulk$/, respond: ({ body }) => json({
      ok: true, action: body.action, affected: (body.record_ids || []).length,
    }) },
    { method: 'GET', match: '/api/v1/training', respond: () => json([
      { id: 'job_1', status: 'running', engine: 'pytorch', model_id: 'model_1', dataset_id: 'ds_1' },
    ]) },
    { method: 'GET', match: /^\/api\/v1\/training\/job_1\/intelligence$/, respond: () => json({
      job_id: 'job_1',
      model: { id: 'model_1', name: 'Corpus Small', version: '1.0', status: 'training' },
      architecture: {
        architecture: 'CorpusTransformerPT', engine: 'pytorch', method: 'sft',
        total_parameters: 123456, trainable_parameters: 123456, trainable_percent: 100,
        layers: 2, embedding_dim: 64, intermediate_dim: 128, attention_heads: 4, kv_heads: 4,
        vocab_size: 512, context_window: 64, precision: 'float32', quantization: null,
        weight_size_bytes: 493824, source: 'instantiated from the stored model config',
        compatibility: { hf_weights_loadable: false, reason: 'custom state dict' },
      },
      training: {
        algorithm: 'pytorch', optimizer: 'adamw', learning_rate: 0.001, batch_size: 2,
        gradient_accumulation_steps: 4, effective_global_batch: 8,
        effective_global_batch_formula: 'batch_size × gradient_accumulation_steps × 1 device',
        total_steps: 10, completed_steps: 4, total_epochs: 2, current_epoch: 1,
        precision: 'float32', seed: 42, gradient_clip: 1.0,
      },
      dataset: {
        available: true, dataset_id: 'ds_1', name: 'Wiki corpus', records: 8, tokens: 1024,
        train_tokens: 1024, validation_tokens: null, test_tokens: null,
        avg_tokens_per_sample: 16, min_sample_length: 16, max_sample_length: 16,
        language_distribution: { unknown: 8 }, subject_distribution: {}, source_distribution: {},
        cleaning_status: 'raw extracted text, no filtering applied',
        tokenization_status: 'tokenized', split: { train: 1 }, checksum: 'abc123def4567890',
        limitations: ['A language or subject label was not detected for this plain-text dataset.'],
      },
      hardware: {
        samples: 2,
        latest: {
          captured_at: new Date().toISOString(), stage: 'training', step: 4, device: 'cpu',
          acceleration: 'CPU only (torch reports no CUDA device)', cpu_count: 4,
          cpu_model: 'Test CPU', cpu_utilization: 62.5, ram_used_mb: 900, ram_total_mb: 4096,
          gpu_name: null, gpu_memory_used_mb: null, gpu_memory_total_mb: null,
          gpu_utilization: null, cpu_temperature_c: null, battery_percent: null, worker_count: 1,
        },
        this_api_host: { device: 'cpu', cpu_count: 4 },
        unavailable: ['GPU is not readable on the training host.', 'GPU utilisation is not readable on the training host.'],
      },
      metrics: {
        status: 'running', stage: 'training', progress_percent: 40, completed_steps: 4,
        total_steps: 10, current_epoch: 1, total_epochs: 2, processed_tokens: 4000,
        tokens_per_second: 120, samples_per_second: 7.5, train_loss: 2.4, learning_rate: 0.001,
        gradient_norm: null, eta_seconds: 50, elapsed_seconds: 33, last_metric_at: new Date().toISOString(),
        failure_reason: null,
        series: [
          { step: 1, loss: 3.5, learning_rate: 0.001, tokens_per_second: 100 },
          { step: 2, loss: 2.9, learning_rate: 0.001, tokens_per_second: 110 },
          { step: 3, loss: 2.4, learning_rate: 0.001, tokens_per_second: 120 },
        ],
      },
      charts: { loss: [], learning_rate: [], throughput: [] },
      statuses: { generation: null, validation: null, training: 'running', evaluation: null },
      independent_status_note: 'Generation, validation, training and evaluation are separate runs.',
      generated_at: new Date().toISOString(),
    }) },
    { method: 'GET', match: '/api/v1/students/system', respond: () => json({
      libraries: { python: '3.11', torch: '2.1.0', transformers: '4.36.0', peft: '0.7.1',
                   accelerate: '0.25.0', bitsandbytes: null, cuda_available: false,
                   cuda_devices: [], cpu_count: 4 },
      methods: {
        sft: { label: 'Supervised fine-tuning', description: 'Train all weights.' },
        lora: { label: 'LoRA', description: 'Freeze base, train adapters.' },
        qlora: { label: 'QLoRA', description: '4-bit base + adapters.' },
      },
      availability: {
        corpus: { sft: { available: true, reasons: [] }, lora: { available: false, reasons: ['custom transformer'] } },
        huggingface: { sft: { available: true, reasons: [] },
                       lora: { available: true, reasons: [] },
                       qlora: { available: false, reasons: ['bitsandbytes is not installed, so 4-bit quantisation is unavailable.'] } },
      },
      notes: [],
    }) },
    { method: 'GET', match: '/api/v1/students/models', respond: () => json({
      models: [{ id: 'model_1', name: 'Corpus Small', status: 'idle', version: '1.0',
                 architecture: {}, checkpoints: 1, last_step: 12, last_loss: 1.5,
                 has_tokenizer: true, base_source: 'corpus' }],
      note: 'CORPUS engine models',
    }) },
    { method: 'GET', match: '/api/v1/students/configs', respond: () => json({ configs: [] }) },
  ];
  return routes.concat(overrides.extra || []);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function callsTo(net, method, pattern) {
  return net.calls.filter((call) => call.method === method && pattern.test(call.route));
}

/* ------------------------------------------------------------------ tests */

test('AI Teacher Network lists providers without ever rendering the key', async () => {
  const app = createApp({ extraRoutes: baseRoutes() });
  await app.window.teachers.render('ai-teachers');
  const html = app.doc.getElementById('page-container').innerHTML;

  assert.match(html, /OpenAI primary/);
  assert.match(html, /••••6789/, 'only the masked hint is shown');
  assert.ok(!html.includes(FULL_KEY), 'the raw key must never appear');
  assert.match(html, /Not available/, 'a model without a reported context window says so');
  assert.match(html, /Provider fine-tuning unverified/, 'an unverified capability is never shown as supported');
  assert.match(html, /Connected/);
});

test('adding a provider posts the key once, then clears it from the form', async () => {
  const routes = baseRoutes({ extra: [
    { method: 'POST', match: '/api/v1/teachers/providers', respond: ({ body }) => json({
      id: 'prov_new', provider_type: body.provider_type, name: body.name,
      credential_hint: '••••6789', credential_fingerprint: 'ffff0000', enabled: true,
      status: body.test_on_save === false ? 'unverified' : 'connected', capabilities: {},
      budget: {}, models: [], base_url: body.base_url || null,
    }, 201) },
  ] });
  const app = createApp({ extraRoutes: routes });
  await app.window.teachers.render('provider-management');
  app.window.teachers.openAddForm();

  const form = app.doc.querySelector('#provider-add-form form');
  assert.ok(form, 'the add form opens');
  form.querySelector('input[name="name"]').value = 'New provider';
  form.querySelector('input[name="api_key"]').value = FULL_KEY;
  const typeSelect = form.querySelector('select[name="provider_type"]');
  typeSelect.value = 'openai';

  await app.window.teachers.submitProvider({ preventDefault() {}, target: form });

  const posts = callsTo(app.net, 'POST', /^\/api\/v1\/teachers\/providers$/);
  assert.equal(posts.length, 1, 'exactly one create request');
  assert.equal(posts[0].body.api_key, FULL_KEY);
  assert.equal(posts[0].body.test_on_save, true);

  const html = app.doc.getElementById('page-container').innerHTML;
  assert.ok(!html.includes(FULL_KEY), 'the key is not echoed back into the page');
  assert.ok(!JSON.stringify(app.window.localStorage || {}).includes(FULL_KEY),
    'the key is never persisted in localStorage');
});

test('a refused provider save surfaces the backend reason', async () => {
  const routes = baseRoutes({ extra: [
    { method: 'POST', match: '/api/v1/teachers/providers', respond: () => json({
      detail: 'CREDENTIAL_ENCRYPTION_KEY is not configured, so provider credentials cannot be encrypted.',
    }, 409) },
  ] });
  const app = createApp({ extraRoutes: routes });
  await app.window.teachers.render('provider-management');
  app.window.teachers.openAddForm();
  const form = app.doc.querySelector('#provider-add-form form');
  form.querySelector('input[name="name"]').value = 'Refused';
  form.querySelector('input[name="api_key"]').value = 'sk-test-12345678';
  await app.window.teachers.submitProvider({ preventDefault() {}, target: form });

  const html = app.doc.getElementById('page-container').innerHTML;
  assert.match(html, /CREDENTIAL_ENCRYPTION_KEY/);
});

test('teacher selection blocks mode B with one teacher and allows two', async () => {
  const app = createApp({ extraRoutes: baseRoutes() });
  await app.window.teacherSelection.render('teacher-selection');

  app.window.teacherSelection.setMode('multi');
  app.window.teacherSelection.addTeacher('prov_openai::vendor/model-a');
  let errors = app.window.teacherSelection._validation();
  assert.ok(errors.some((message) => /two different teacher providers/i.test(message)),
    'a single provider is rejected for mode B');

  app.window.teacherSelection.addTeacher('prov_other::vendor/model-b');
  errors = app.window.teacherSelection._validation();
  assert.equal(errors.filter((message) => /teacher providers/i.test(message)).length, 0,
    'two distinct providers satisfy mode B');
});

test('modes C and D demand an evaluator from a different provider', async () => {
  const app = createApp({ extraRoutes: baseRoutes() });
  await app.window.teacherSelection.render('teacher-selection');
  app.window.teacherSelection.setMode('evaluator');
  app.window.teacherSelection.addTeacher('prov_openai::vendor/model-a');
  let errors = app.window.teacherSelection._validation();
  assert.ok(errors.some((message) => /separate evaluator/i.test(message)));

  app.window.teacherSelection.addEvaluator('prov_openai::vendor/model-a');
  errors = app.window.teacherSelection._validation();
  assert.ok(errors.some((message) => /different provider/i.test(message)),
    'a teacher evaluating itself is refused');
});

test('distillation refuses to create a job without explicit consent', async () => {
  const app = createApp({ extraRoutes: baseRoutes({ extra: [
    { method: 'POST', match: '/api/v1/distillation/jobs', respond: ({ body }) => json({ id: 'dj_new', ...body, status: 'draft' }, 201) },
  ] }) });
  await app.window.distillation.render('knowledge-distillation');

  await app.window.distillation.createJob(null);
  assert.equal(callsTo(app.net, 'POST', /^\/api\/v1\/distillation\/jobs$/).length, 0,
    'no job is created while the consent box is unchecked');

  app.doc.getElementById('kd-consent').checked = true;
  app.doc.getElementById('kd-dataset').value = 'ds_1';
  app.doc.getElementById('kd-count').value = '2';
  const teacherSelect = app.doc.getElementById('kd-teachers');
  if (teacherSelect && teacherSelect.options.length) teacherSelect.options[0].selected = true;

  await app.window.distillation.createJob(null);
  const posts = callsTo(app.net, 'POST', /^\/api\/v1\/distillation\/jobs$/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.allow_external_send, true);
  assert.ok(posts[0].body.teachers.length >= 1, 'at least one teacher is sent');
});

test('the review screen shows provenance, totals and only accepted exports', async () => {
  const app = createApp({ extraRoutes: baseRoutes() });
  await app.window.distillation.render('dataset-review');
  const html = app.doc.getElementById('page-container').innerHTML;

  assert.match(html, /Generated/);
  assert.match(html, /Validation failures/);
  assert.match(html, /OpenAI primary/, 'teacher contribution is shown');
  assert.match(html, /cmpl-abcdef123456789/, 'the request id is part of provenance');
  assert.match(html, /Only accepted records are converted/);

  const box = app.doc.querySelector('.kd-select');
  assert.ok(box, 'each record has a selection checkbox');
  box.checked = true;
  app.window.distillation.toggleSelect(box);
  await app.window.distillation.bulk('accept', null);
  const bulk = callsTo(app.net, 'POST', /\/records\/bulk$/);
  assert.equal(bulk.length, 1);
  assert.deepEqual(bulk[0].body, { record_ids: ['rec_1'], action: 'accept' });
});

test('training intelligence renders Unavailable instead of inventing GPU values', async () => {
  const app = createApp({ extraRoutes: baseRoutes() });
  app.window.intelligence.selectJob('job_1');
  await app.window.intelligence.render();
  const html = app.doc.getElementById('page-container').innerHTML;

  assert.match(html, /CorpusTransformerPT/);
  assert.match(html, /123,456/, 'the measured parameter count is shown');
  assert.match(html, /Unavailable/, 'null GPU fields print Unavailable');
  assert.match(html, /40%/, 'progress comes from the backend step counter');
  assert.match(html, /CPU only \(torch reports no CUDA device\)/);
  assert.match(html, /Generation, validation, training and evaluation are separate runs/);
  assert.ok(!/GPU utilization[\s\S]{0,80}0%/.test(html), 'GPU utilization is not fabricated as 0%');
});

test('usage page shows unpriced requests instead of an invented cost', async () => {
  const app = createApp({ extraRoutes: baseRoutes() });
  await app.window.budgets.render();
  const html = app.doc.getElementById('page-container').innerHTML;
  assert.match(html, /OpenAI primary/);
  assert.match(html, /2 unpriced/);
  assert.match(html, /Requests without a price are counted as unpriced/);
  assert.match(html, /\$0\.0021/);
});

test('student studio marks unavailable methods and shows the measured architecture', async () => {
  const app = createApp({ extraRoutes: baseRoutes({ extra: [
    { method: 'POST', match: '/api/v1/students/inspect', respond: () => json({
      name: 'Corpus Small', model_id: 'model_1', base_source: 'corpus', base_ref: null,
      architecture: {
        architecture: 'CorpusTransformerPT', engine: 'pytorch', total_parameters: 98765,
        trainable_parameters: 98765, trainable_percent: 100, layers: 2, embedding_dim: 64,
        intermediate_dim: 128, attention_heads: 4, kv_heads: 4, vocab_size: 512,
        context_window: 64, precision: 'float32', quantization: null, weight_size_bytes: 395060,
        parameter_breakdown: { 'token_embedding.weight': 32768 }, source: 'instantiated from the stored model config',
      },
      methods: {
        sft: { available: true, reasons: [] },
        lora: { available: false, reasons: ['The CORPUS PyTorch architecture is a custom transformer, not a Hugging Face module tree.'] },
        qlora: { available: false, reasons: ['bitsandbytes is not installed.'] },
      },
      compatibility: { hf_weights_loadable: false, reason: 'CORPUS checkpoints store a custom state dict.' },
    }) },
  ] }) });
  await app.window.students.render();
  app.doc.getElementById('st-model').value = 'model_1';
  await app.window.students.inspect(null);
  const html = app.doc.getElementById('page-container').innerHTML;

  assert.match(html, /98,765/);
  assert.match(html, /CorpusTransformerPT/);
  assert.match(html, /custom transformer/);
  assert.match(html, /Unavailable/);
  assert.match(html, /not installed/);
});
