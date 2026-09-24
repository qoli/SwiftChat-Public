const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-adapter.user.js'), 'utf8');
function fixture() {
  const messages = [], listeners = new Set(), frames = [];
  let elapsed = 0;
  const document = {
    visibilityState: 'hidden', readyState: 'complete',
    querySelectorAll: () => [{ textContent: 'PRIVATE EDITOR CONTENT' }],
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn)
  };
  const ctx = vm.createContext({
    crypto: { randomUUID }, performance: { now: () => elapsed }, document,
    documentID: randomUUID(), ADAPTER_VERSION: 'fixture', SELECTORS: { editor: '#prompt-textarea' },
    window: { webkit: { messageHandlers: { swiftChatConversationAdapterStatus: {
      postMessage: value => messages.push(JSON.parse(JSON.stringify(value)))
    } } } },
    isModelControlExpanded: () => true,
    probeChatGPTComposer: () => ({ ok: true, anchors: { form: {} } }),
    activateWebsiteComposer() {}, forwardModelControl: () => true,
    requestAnimationFrame: fn => frames.push(fn)
  });
  vm.runInContext(source.slice(source.indexOf('\tfunction diagnoseOperation('), source.indexOf('\tfunction waitForWebsiteState(')), ctx);
  vm.runInContext(source.slice(source.indexOf('\tasync function openNativeModelControl('), source.indexOf('\tfunction setModelTransportVisible(')), ctx);
  return { ctx, messages, listeners, frames, document, advance: ms => elapsed += ms };
}
test('a suspended animation frame identifies the exact wait and visibility without pretending completion', async () => {
  const f = fixture();
  const result = f.ctx.diagnoseOperation('model.snapshot', diagnostic => f.ctx.openNativeModelControl(diagnostic));
  assert.deepEqual(f.messages.map(x => x.operationDiagnostic.outcome), ['begin', 'waiting']);
  assert.equal(f.messages.at(-1).operationDiagnostic.stage, 'model.open.frame');
  assert.equal(f.messages.at(-1).operationDiagnostic.visibility, 'hidden');
  f.advance(4200); f.document.visibilityState = 'visible';
  for (const fn of f.listeners) fn();
  assert.equal(f.messages.at(-1).operationDiagnostic.elapsedMS, 4200);
  f.frames.shift()();
  assert.equal(await result, true);
  assert.equal(f.messages.at(-1).operationDiagnostic.outcome, 'succeeded');
  assert.equal(new Set(f.messages.map(x => x.operationDiagnostic.operationID)).size, 1);
  assert.equal(f.listeners.size, 0);
  assert.ok(!JSON.stringify(f.messages).includes('PRIVATE EDITOR CONTENT'));
});
test('synchronous catalog errors and asynchronous rejection preserve the original error without logging its contents', async () => {
  const f = fixture(), error = new Error('PRIVATE URL?token=secret');
  assert.throws(() => f.ctx.diagnoseOperation('conversation.catalog', () => { throw error; }), e => e === error);
  await assert.rejects(f.ctx.diagnoseOperation('conversation.configure', () => Promise.reject(error)), e => e === error);
  assert.equal(f.messages.filter(x => x.operationDiagnostic.outcome === 'failed').length, 2);
  assert.equal(f.listeners.size, 0);
  assert.ok(!JSON.stringify(f.messages).includes('secret'));
  const value = { models: [] };
  assert.equal(f.ctx.diagnoseOperation('conversation.catalog', () => value), value);
});
test('overlapping operations keep separate IDs and rejected controls are not logged as success', async () => {
  const f = fixture();
  const pending = f.ctx.diagnoseOperation('model.snapshot', diagnostic => f.ctx.openNativeModelControl(diagnostic));
  assert.equal(f.ctx.diagnoseOperation('model.select', () => false), false);
  const rejected = f.messages.at(-1).operationDiagnostic;
  assert.equal(rejected.outcome, 'failed');
  assert.notEqual(rejected.operationID, f.messages[0].operationDiagnostic.operationID);
  f.frames.shift()(); await pending;
  assert.equal(f.messages.at(-1).operationDiagnostic.operation, 'model.snapshot');
  assert.equal(f.listeners.size, 0);
});
