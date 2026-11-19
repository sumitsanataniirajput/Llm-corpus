/* End-to-end Teacher Selection → Knowledge Distillation handoff.
 * Runs the real page modules against the jsdom fetch harness: connect/select
 * providers, carry a plan, verify the actual IDs in the DOM and POST body, then
 * create a draft job only after dataset + consent are complete.
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function callsTo(net, method, pattern) {
  return net.calls.filter((call) => call.method === method && pattern.test(call.route));
}

function provider(id, name, modelId) {
  return {
    id,
    name,
    provider_type: 'openai',
    enabled: true,
    status: 'connected',
    default_teacher_model: modelId,
    credential_hint: '••••6789',
    credential_fingerprint: 'a1b2c3d4',
    models: [{
      id: `${id}_model`, provider_id: id, model_id: modelId,
      display_name: name, enabled: true, discovered: true,
    }],
  };
}

function optionsFixture() {
  return {
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
  };
}

function routes({ providersRef, posts = true } = {}) {
  const list = [
    { method: 'GET', match: '/api/v1/teachers/providers', respond: () => json({
      providers: providersRef ? providersRef.providers : [], credential_encryption_configured: true,
    }) },
    { method: 'GET', match: '/api/v1/distillation/options', respond: () => json(optionsFixture()) },
    { method: 'GET', match: '/api/v1/datasets', respond: () => json([
      { id: 'ds_1', name: 'Wiki corpus', format: 'txt', size: 2048, status: 'ready', has_file: true },
    ]) },
    { method: 'GET', match: '/api/v1/distillation/jobs', respond: () => json({ jobs: [] }) },
  ];
  if (posts) {
    list.push({ method: 'POST', match: '/api/v1/distillation/jobs', respond: ({ body }) => json({
      id: 'dj_draft', ...body, status: 'draft',
    }, 201) });
  }
  return list;
}

function selectedValues(select) {
  return Array.from(select.selectedOptions || []).map((option) => option.value).filter(Boolean);
}

function setField(doc, id, value) {
  const el = doc.getElementById(id);
  assert.ok(el, `#${id} exists`);
  el.value = String(value);
  return el;
}

test('Use plan transfers real teacher/evaluator IDs, settings and consent into a draft job', async () => {
  const providersRef = { providers: [
    provider('prov_openai', 'OpenAI primary', 'vendor/model-a'),
    provider('prov_other', 'OpenAI secondary', 'vendor/model-b'),
  ] };
  const instance = app({ extraRoutes: routes({ providersRef }) });
  const toasts = [];
  instance.window.ui.toast = (message, type) => toasts.push({ message, type });

  await instance.window.teacherSelection.render('teacher-selection');
  const studio = instance.window.teacherSelection;
  studio.setMode('evaluator');
  studio.addTeacher('prov_openai::vendor/model-a');
  studio.addTeacher('prov_openai::vendor/model-a'); // duplicate must not create a second payload entry
  studio.addEvaluator('prov_other::vendor/model-b');
  studio.addEvaluator('prov_other::vendor/model-b'); // duplicate must not create a second payload entry
  assert.equal(studio._validation().length, 0, 'mode C plan is valid before handoff');

  setField(instance.doc, 'ts-count', 7);
  setField(instance.doc, 'ts-task', 'qa');
  setField(instance.doc, 'ts-subject', 'science');
  setField(instance.doc, 'ts-difficulty', 'intermediate');
  setField(instance.doc, 'ts-language', 'hi');
  setField(instance.doc, 'ts-max-requests', 44);
  setField(instance.doc, 'ts-max-tokens', 123456);
  setField(instance.doc, 'ts-max-spend', 3.5);
  setField(instance.doc, 'ts-concurrency', 2);

  studio.usePlan(null);
  assert.equal(instance.net.navigatedTo, 'knowledge-distillation');
  assert.ok(studio.hasPlan(), 'the plan survives the navigation call');
  assert.equal(toasts.filter((entry) => entry.type === 'success').length, 0,
    'Use plan does not claim that a job was created');

  await instance.window.distillation.render('knowledge-distillation');
  assert.equal(studio.hasPlan(), false, 'distillation owns the plan after a successful prefill');
  assert.ok(instance.window.distillation._state().plan, 'the plan is retained in distillation state');

  assert.equal(instance.doc.getElementById('kd-mode').value, 'evaluator');
  assert.equal(instance.doc.getElementById('kd-count').value, '7');
  assert.equal(instance.doc.getElementById('kd-task').value, 'qa');
  assert.equal(instance.doc.getElementById('kd-spend').value, '3.5');
  assert.equal(instance.doc.getElementById('kd-requests').value, '44');

  const teachers = instance.doc.getElementById('kd-teachers');
  const evaluators = instance.doc.getElementById('kd-evaluator');
  assert.deepEqual(selectedValues(teachers), ['prov_openai::vendor/model-a']);
  assert.deepEqual(selectedValues(evaluators), ['prov_other::vendor/model-b']);
  assert.equal(teachers.selectedOptions[0].getAttribute('data-provider-id'), 'prov_openai');
  assert.equal(teachers.selectedOptions[0].getAttribute('data-model-id'), 'vendor/model-a');
  assert.equal(evaluators.selectedOptions[0].getAttribute('data-provider-id'), 'prov_other');
  assert.equal(evaluators.selectedOptions[0].getAttribute('data-model-id'), 'vendor/model-b');
  const summaryText = instance.doc.getElementById('kd-plan-summary').textContent;
  assert.match(summaryText, /vendor\/model-a/);
  assert.match(summaryText, /vendor\/model-b/);
  assert.match(summaryText, /Hindi|hi/);
  assert.match(summaryText, /science/);
  assert.match(summaryText, /intermediate/);

  // A second render (async provider load / navigation / refresh) re-applies the
  // same retained plan instead of consuming it a second time.
  await instance.window.distillation.render('knowledge-distillation');
  assert.deepEqual(selectedValues(instance.doc.getElementById('kd-teachers')), ['prov_openai::vendor/model-a']);
  assert.deepEqual(selectedValues(instance.doc.getElementById('kd-evaluator')), ['prov_other::vendor/model-b']);

  const createButton = instance.doc.getElementById('kd-create');
  assert.equal(createButton.disabled, true, 'Create Job starts disabled without dataset/consent');
  await instance.window.distillation.createJob(null);
  assert.equal(callsTo(instance.net, 'POST', /^\/api\/v1\/distillation\/jobs$/).length, 0,
    'a premature Create Job call makes no request');

  setField(instance.doc, 'kd-dataset', 'ds_1');
  instance.doc.getElementById('kd-consent').checked = true;
  instance.window.distillation.updateValidationUI();
  assert.equal(instance.doc.getElementById('kd-create').disabled, false,
    'all required fields enable Create Job');
  assert.equal(toasts.filter((entry) => entry.type === 'success').length, 0,
    'no success toast appears before the draft is created');

  await instance.window.distillation.createJob(null);
  const posts = callsTo(instance.net, 'POST', /^\/api\/v1\/distillation\/jobs$/);
  assert.equal(posts.length, 1);
  const body = posts[0].body;
  assert.equal(body.dataset_id, 'ds_1');
  assert.equal(body.mode, 'evaluator');
  assert.equal(body.allow_external_send, true);
  assert.deepEqual(body.teachers, [{ provider_id: 'prov_openai', model_id: 'vendor/model-a' }]);
  assert.deepEqual(body.evaluators, [{ provider_id: 'prov_other', model_id: 'vendor/model-b' }]);
  assert.equal(body.generation.count, 7);
  assert.deepEqual(body.generation.languages, ['hi']);
  assert.deepEqual(body.generation.subjects, ['science']);
  assert.deepEqual(body.generation.difficulties, ['intermediate']);
  assert.deepEqual(body.generation.task_types, ['qa']);
  assert.equal(body.budget.max_spend_usd, 3.5);
  assert.equal(body.budget.max_requests, 44);
  assert.equal(body.budget.max_tokens, 123456);
  assert.equal(body.budget.max_concurrency, 2);
  assert.deepEqual(body.quality, { min_quality_score: 0.6, min_chars: 40 });
  assert.equal(instance.window.teacherSelection.hasPlan(), false, 'the consumed plan is cleared after job creation');
});

test('an unavailable plan provider is preserved as a blocking inline warning, never discarded', async () => {
  const providersRef = { providers: [provider('prov_openai', 'OpenAI primary', 'vendor/model-a')] };
  const instance = app({ extraRoutes: routes({ providersRef }) });
  await instance.window.teacherSelection.render('teacher-selection');
  instance.window.teacherSelection.addTeacher('prov_openai::vendor/model-a');
  instance.window.teacherSelection.usePlan(null);

  providersRef.providers = [];
  await instance.window.distillation.render('knowledge-distillation');
  const teachers = instance.doc.getElementById('kd-teachers');
  assert.deepEqual(selectedValues(teachers), ['prov_openai::vendor/model-a'],
    'the exact original provider/model value remains visible');
  assert.equal(teachers.selectedOptions[0].getAttribute('data-available'), '0');
  setField(instance.doc, 'kd-dataset', 'ds_1');
  instance.doc.getElementById('kd-consent').checked = true;
  instance.window.distillation.updateValidationUI();
  assert.match(instance.doc.getElementById('kd-plan-errors').textContent, /unavailable/i);
  assert.match(instance.doc.getElementById('kd-plan-summary').textContent, /not available/i);
  assert.equal(instance.doc.getElementById('kd-create').disabled, true);
  await instance.window.distillation.createJob(null);
  assert.equal(callsTo(instance.net, 'POST', /^\/api\/v1\/distillation\/jobs$/).length, 0);
});

test('Knowledge Distillation keeps backend mode B/C validation beside the form', async () => {
  const providersRef = { providers: [
    provider('prov_openai', 'OpenAI primary', 'vendor/model-a'),
    provider('prov_other', 'OpenAI secondary', 'vendor/model-b'),
  ] };
  const instance = app({ extraRoutes: routes({ providersRef, posts: false }) });
  await instance.window.distillation.render('knowledge-distillation');

  setField(instance.doc, 'kd-dataset', 'ds_1');
  instance.doc.getElementById('kd-consent').checked = true;
  const teachers = instance.doc.getElementById('kd-teachers');
  teachers.options[0].selected = true;
  setField(instance.doc, 'kd-mode', 'multi');
  instance.window.distillation.updateValidationUI();
  let text = instance.doc.getElementById('kd-plan-errors').textContent;
  assert.match(text, /Mode B requires at least two different teacher providers/i);
  assert.equal(instance.doc.getElementById('kd-create').disabled, true);

  setField(instance.doc, 'kd-mode', 'evaluator');
  instance.window.distillation.updateValidationUI();
  text = instance.doc.getElementById('kd-plan-errors').textContent;
  assert.match(text, /requires at least one separate evaluator/i);
  assert.equal(instance.doc.getElementById('kd-create').disabled, true);
  assert.equal(callsTo(instance.net, 'POST', /^\/api\/v1\/distillation\/jobs$/).length, 0);
});
