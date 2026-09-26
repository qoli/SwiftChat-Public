const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-network-attachments.js'), 'utf8');
function fixture() {
  const calls = [], frames = []; let status = 'uploading', changes = 0;
  const window = {requestAnimationFrame(callback) { frames.push(callback); return frames.length; }};
  const context = {window, File, Uint8Array, atob, Error}; vm.runInNewContext(source, context);
  const api = context.window.__SwiftChatNetworkAttachments;
  api.configure({runtime: {
    async uploadAttachment(file) { calls.push({upload:file}); return {token: 'local-token'}; },
    attachmentState(token) { calls.push({stateToken:token}); return {status}; },
    async removeAttachment(token) { calls.push({removedToken:token}); }
  }, onChange() { changes += 1; }});
  return {api, calls, ready() { status = 'ready'; }, error() { status = 'error'; },
    frame() { assert.ok(frames.length); frames.shift()(); },
    get frameCount() { return frames.length; }, get changeCount() { return changes; }};
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
test('hidden upload completion notifies native without a React commit', async () => {
  const f = fixture(); await f.api.importNativeAttachment('n', 'fixture.txt', 'text/plain', btoa('x'));
  assert.equal(f.changeCount, 2); assert.equal(f.frameCount, 1);
  f.frame();
  assert.equal(f.changeCount, 2, 'Unchanged state must not flood the bridge');
  assert.equal(f.frameCount, 1);
  f.ready(); f.frame();
  assert.equal(f.changeCount, 3); assert.equal(f.api.snapshot()[0].status, 'ready');
  assert.equal(f.frameCount, 0, 'Observation stops at the terminal state');
});
test('hidden upload failure and pending removal stop observation', async () => {
  const failed = fixture(); await failed.api.importNativeAttachment('n', 'fixture.txt', 'text/plain', btoa('x'));
  failed.error(); failed.frame();
  assert.equal(failed.changeCount, 3); assert.equal(failed.api.snapshot()[0].status, 'failed');
  assert.equal(failed.frameCount, 0);

  const removed = fixture(); await removed.api.importNativeAttachment('n', 'fixture.txt', 'text/plain', btoa('x'));
  await removed.api.remove('n'); removed.frame();
  assert.equal(removed.api.snapshot().length, 0); assert.equal(removed.frameCount, 0);
});
