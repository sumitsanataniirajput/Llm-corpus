/** Large dataset uploads use signed, resumable TUS uploads directly to Storage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, datasetFixtures } from './harness.mjs';

function selectFile(app, input, file) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new app.window.Event('change'));
}

test('files larger than the standard-upload threshold use signed resumable Storage upload', async () => {
  const app = createApp(datasetFixtures());
  await app.window.datasets.render();
  app.window.datasets.showUpload();
  app.doc.getElementById('datasets-name').value = 'Large training corpus';

  const file = new app.window.File(
    [new Uint8Array(6 * 1024 * 1024 + 32)],
    'large.txt',
    { type: 'text/plain' }
  );
  selectFile(app, app.doc.getElementById('datasets-file'), file);

  const sessionCalls = [];
  const completionCalls = [];
  app.window.CORPUS_API.createDatasetUploadSession = async (id, payload) => {
    sessionCalls.push({ id, payload });
    return {
      ok: true,
      bucket: 'corpus-storage',
      storage_path: 'user-1/datasets/' + id + '/random_large.txt',
      token: 'signed-upload-token',
    };
  };
  app.window.CORPUS_API.completeDatasetUpload = async (id, payload) => {
    completionCalls.push({ id, payload });
    return { ok: true, file_size: file.size };
  };

  const instances = [];
  class TusUploadStub {
    constructor(uploadFile, options) {
      this.file = uploadFile;
      this.options = options;
      instances.push(this);
    }
    findPreviousUploads() { return Promise.resolve([]); }
    resumeFromPreviousUpload(previous) { this.previous = previous; }
    start() {
      this.options.onProgress(this.file.size, this.file.size);
      this.options.onSuccess();
    }
  }
  app.window.tus = { Upload: TusUploadStub };

  app.net.calls.length = 0;
  await app.window.datasets.handleUpload();

  assert.equal(sessionCalls.length, 1);
  assert.equal(sessionCalls[0].payload.file_name, 'large.txt');
  assert.equal(completionCalls.length, 1);
  assert.equal(completionCalls[0].payload.file_name, 'large.txt');
  assert.equal(instances.length, 1);
  assert.equal(instances[0].options.chunkSize, 6 * 1024 * 1024);
  assert.match(instances[0].options.endpoint, /\.storage\.supabase\.co\/storage\/v1\/upload\/resumable$/);
  assert.equal(instances[0].options.headers['x-signature'], 'signed-upload-token');
  assert.equal(instances[0].options.metadata.bucketName, 'corpus-storage');
  assert.match(app.doc.getElementById('toast-container').textContent, /uploaded/i);
  assert.equal(app.XHRStub.instances.length, 0, 'large files do not pass through the Render API multipart route');
});

test('frontend configuration no longer imposes a fixed 100 MB app-level limit', () => {
  const app = createApp(datasetFixtures());
  assert.equal(app.window.CORPUS_CONFIG.MAX_FILE_SIZE, 0);
});
