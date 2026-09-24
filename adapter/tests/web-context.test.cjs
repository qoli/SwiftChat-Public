const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-adapter.user.js'), 'utf8');
const block = source.slice(source.indexOf('\t// Web Chat compatibility contract:'), source.indexOf('\tfunction forwardAttachmentPicker(kind)'));
function fixture(mode = 'work') {
  const calls = [], editor = {}, form = {};
  const ctx = vm.createContext({nativeAttachments: new Map(), verifyNativeAttachments(){},Promise, Error, queueMicrotask, location:{pathname:'/'},
    currentConversationMode:()=>mode, contextError:code=>new Error('app-context:'+code),
    mentionError:code=>new Error('mentions:'+code),
    probeChatGPTComposer:()=>({ok:true, anchors:{editor,form}}),
    activateWebsiteComposer:()=>{}, hideWebsiteComposer:()=>{}, reportNativeState:()=>{},
    syncDraftToSite:text=>{editor.text=text; return true;},
    editorDraftText:()=>editor.text, normalizeEditorText:text=>text,
    requestAnimationFrame:fn=>fn(), documentScrollState:null,
    prepareNativeMentions:async(text,mentions)=>{calls.push({text,mentions});return {verify:()=>true,rollback:async()=>{}};},
    armAppContext:(text,context)=>{calls.push({hidden:true,text,context});return {promise:Promise.resolve(true)};},
    forwardSend:()=>{calls.push({send:editor.text});return true;}});
  vm.runInContext(block,ctx);
  return {ctx,calls,editor,setMode:value=>mode=value};
}
const context = 'Work with Apps — read-only context.\n\n````text\n# literal 😀\n```\n<img src=x>\n````';
test('Work sends fenced context above unchanged body without hidden transport',async()=>{
  const f=fixture(), draft='  請解釋\n\nbody\n';
  assert.equal(await f.ctx.submitNativeDraft(draft,[],context),true);
  assert.ok(f.editor.text.endsWith('\n```\n\n'+draft));
  const encoded=f.editor.text.split('```json\n')[1].split('\n```')[0];
  assert.equal(JSON.parse(encoded),context);
  assert.ok(!encoded.includes('`'));
  assert.equal(f.editor.text.match(/```/g).length,2);
  assert.equal(f.calls.length,1);
});
test('Work rebases mention UTF-16 positions without mutating native references',async()=>{
  const f=fixture(), mentions=[{location:3,length:4,candidate:{id:'app'}}];
  await f.ctx.submitNativeDraft('😀 @App',mentions,context);
  const prefixLength=f.calls[0].text.length-'😀 @App'.length;
  assert.equal(f.calls[0].mentions[0].location,3+prefixLength);
  assert.equal(f.calls[0].text.slice(f.calls[0].mentions[0].location),'@App');
  assert.equal(mentions[0].location,3);
});
test('Chat still uses hidden transport and original body',async()=>{
  const f=fixture('chat'); await f.ctx.submitNativeDraft('question',[],context);
  assert.equal(f.editor.text,'question'); assert.equal(f.calls[0].hidden,true);
});
test('no context leaves ordinary submissions unchanged even with unknown mode',async()=>{
  const f=fixture(null); await f.ctx.submitNativeDraft('question');
  assert.equal(f.editor.text,'question'); assert.equal(f.calls.length,1);
});
test('unknown and changed modes fail before send',async()=>{
  const f=fixture(null);
  await assert.rejects(f.ctx.submitNativeDraft('question',[],context),/requires-confirmed-conversation-mode/);
  assert.equal(f.calls.length,0);
  const g=fixture();
  g.ctx.requestAnimationFrame=fn=>{g.setMode('chat');fn();};
  await assert.rejects(g.ctx.submitNativeDraft('question',[],context),/conversation-mode-changed/);
  assert.equal(g.calls.length,0);
});
