const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-network-attachments.js'), 'utf8');
function fixture() {
  const calls = []; let status = 'uploading';
  const context = {window: {}, File, Uint8Array, atob, Error}; vm.runInNewContext(source, context);
  const api = context.window.__SwiftChatNetworkAttachments;
  api.configure({runtime: {
    async uploadAttachment(file) { calls.push({upload:file}); return {token: 'local-token'}; },
    attachmentState(token) { calls.push({stateToken:token}); return {status}; },
    async removeAttachment(token) { calls.push({removedToken:token}); }
  }});
  return {api, calls, ready() { status = 'ready'; }, error() { status = 'error'; }};
}
test('upload registration keeps remote identity behind an opaque local token', async () => {
  const f = fixture(); await f.api.importNativeAttachment('n', 'fixture.txt', 'text/plain', btoa('synthetic'));
  assert.equal(await f.calls[0].upload.text(), 'synthetic');
  assert.equal(f.calls.at(-1).stateToken, 'local-token');
  assert.equal(f.api.snapshot()[0].status, 'uploading');
  assert.throws(() => f.api.attachmentTokens(['n']), /not-ready/);
  f.ready(); assert.deepEqual(Array.from(f.api.attachmentTokens(['n'])), ['local-token']);
  assert.equal(JSON.stringify(f.api.snapshot()).includes('local-token'), false);
  f.api.didSubmit(['n']); assert.equal(f.api.snapshot().length, 0);
});
test('removal invokes the website runtime and drops native identity', async () => {
  const f = fixture(); await f.api.importNativeAttachment('n', 'fixture.txt', 'text/plain', btoa('x'));
  await f.api.remove('n'); assert.equal(f.calls.at(-1).removedToken, 'local-token'); assert.equal(f.api.snapshot().length, 0);
});
test('processing errors and changed selections fail closed', async () => {
  const f = fixture(); await f.api.importNativeAttachment('n', 'fixture.txt', 'text/plain', btoa('x'));
  assert.throws(() => f.api.verify([]), /draft-identity-mismatch/);
  f.error(); assert.equal(f.api.snapshot()[0].status, 'failed');
  assert.throws(() => f.api.verify(['n']), /not-ready/);
});
test('raw upload errors never escape and duplicate imports do not reupload', async () => {
  const f = fixture(); f.api.configure({runtime: {async uploadAttachment() {throw Error('private response');}}});
  await assert.rejects(f.api.importNativeAttachment('n', 'f.txt', 'text/plain', btoa('x')), /network-attachments:upload-failed/);
  assert.equal(f.api.snapshot()[0].status, 'failed');
  await assert.rejects(f.api.importNativeAttachment('n', 'f.txt', 'text/plain', btoa('x')), /duplicate-identity/);
});
