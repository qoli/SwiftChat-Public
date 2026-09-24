const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-adapter.user.js'), 'utf8');
const modeSource = source.slice(source.indexOf('\tvar conversationModes'), source.indexOf('\tvar pendingAttachmentListeners'));
function fixture({timeoutMs = 0} = {}) {
  let selected = 'chatgpt';
  let controlAvailable = true;
  let acceptClick = true;
  let disabled = false;
  let clickCount = 0;
  const observers = new Set();
  let label = 'High';
  const location = {pathname:'/'};
  const ctx = vm.createContext({Map, JSON, Object, Promise, location, Error,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(){ observers.add(this); }
      disconnect(){ observers.delete(this); }
    },
    setTimeout:fn=>setTimeout(fn,timeoutMs), clearTimeout,
    activeConversationID: () => location.pathname.startsWith('/c/') ? location.pathname.slice(3) : null,
    freeWebsiteConversationMode: () => null,
    freeAutoThinkingState: () => null,
    document: {querySelectorAll:()=>controlAvailable ? [{getAttribute:()=>selected}] : []},
    exactlyOne: (_,selector) => controlAvailable ? {
      get disabled() { return disabled; },
      click:()=>{clickCount++;if(acceptClick && !disabled)selected=selector.includes('="work"') ? 'work' : 'chatgpt';}
    } : null,
    probeChatGPTComposer:()=>({ok:true,anchors:{form:{}}}),
    uniqueControl:()=>({textContent:label}), SELECTORS:{modelControl:'model'},
    requestAnimationFrame:fn=>setImmediate(fn)});
  vm.runInContext(modeSource,ctx);
  return {ctx,location,setControl:v=>controlAvailable=v,setAccept:v=>acceptClick=v,setLabel:v=>label=v,
    clicks:()=>clickCount,
    setDisabled:v=>{disabled=v;for(const observer of [...observers])observer.callback();}};
}
test('mode selection waits for the website to enable its initially disabled toggle',async()=>{
  const {ctx,setDisabled,clicks}=fixture({timeoutMs:1000});
  setDisabled(true);
  const selection=ctx.selectNewConversationMode('work');
  await new Promise(setImmediate);
  assert.equal(clicks(),0);
  setDisabled(false);
  assert.equal(await selection,true);
  assert.equal(ctx.currentConversationMode(),'work');
  assert.equal(clicks(),1);
});
test('a toggle that stays disabled fails explicitly without clicking or claiming the requested mode',async()=>{
  const {ctx,setDisabled,clicks}=fixture();
  setDisabled(true);
  await assert.rejects(ctx.selectNewConversationMode('work'),
    /mode-control-not-ready:requested=work:observed=chat:composer=ready:control-disabled=true/);
  assert.equal(clicks(),0);
  assert.equal(ctx.currentConversationMode(),'chat');
});
test('only explicit observed origins identify existing conversation modes',()=>{
  const {ctx,location}=fixture();
  assert.equal(ctx.modeForOrigin({conversation_origin:'tpp'}),'work');
  assert.equal(ctx.modeForOrigin({conversation_origin:null}),'chat');
  assert.equal(ctx.modeForOrigin({}),null);
  assert.equal(ctx.modeForOrigin({conversation_origin:'future-mode'}),null);
  location.pathname='/c/work-id';
  assert.equal(ctx.currentConversationMode(),null);
  vm.runInContext('conversationModes.set("work-id", "work")',ctx);
  assert.equal(ctx.currentConversationMode(),'work');
});
test('new mode selection verifies the website and refuses existing conversations',async()=>{
  const {ctx,location,setControl,setAccept}=fixture();
  assert.equal(await ctx.selectNewConversationMode('work'),true);
  assert.equal(ctx.currentConversationMode(),'work');
  assert.equal(await ctx.selectNewConversationMode('chat'),true);
  setAccept(false);
  await assert.rejects(ctx.selectNewConversationMode('work'),/mode-not-confirmed/);
  setControl(false);
  assert.equal(ctx.currentConversationMode(),null);
  await assert.rejects(ctx.selectNewConversationMode('work'),/mode-control-missing/);
  location.pathname='/c/existing';setControl(true);
  assert.equal(await ctx.selectNewConversationMode('work'),false);
});
test('model context changes for route, mode and control label, not message output',async()=>{
  const {ctx,location,setLabel}=fixture();
  const chat=ctx.modelContextKey();
  assert.equal(ctx.modelContextKey(),chat);
  await ctx.selectNewConversationMode('work');
  const work=ctx.modelContextKey();assert.notEqual(work,chat);
  location.pathname='/c/new';
  const routed=ctx.modelContextKey();assert.notEqual(routed,work);
  setLabel('GPT-6 Astra Light');assert.notEqual(ctx.modelContextKey(),routed);
});
test('confirmed home submission mode follows the newly assigned conversation ID',async()=>{
  const {ctx,location}=fixture();
  await ctx.selectNewConversationMode('work');
  vm.runInContext('submittedHomeMode = currentConversationMode()',ctx);
  location.pathname='/c/new-work';assert.equal(ctx.currentConversationMode(),'work');
  location.pathname='/c/unrelated';assert.equal(ctx.currentConversationMode(),null);
});
function modelSnapshotFixture() {
  const {ctx,location,setLabel} = fixture();
  ctx.openHiddenModelControl = async () => { setLabel('Reasoning intensity'); return true; };
  ctx.currentModelControlSnapshot = () => ({modelName:'GPT-6 Astra',effortLabel:'High'});
  ctx.closeHiddenModelControl = async () => { setLabel('High'); return true; };
  const start = source.indexOf('\tasync function nativeModelControlSnapshot(');
  const end = source.indexOf('\tasync function selectNativeModel(', start);
  vm.runInContext(source.slice(start,end),ctx);
  return {ctx,location};
}
test('model snapshot accepts the temporary button label while its menu is open',async()=>{
  const {ctx}=modelSnapshotFixture();
  const before=ctx.modelContextKey();
  const snapshot=await ctx.nativeModelControlSnapshot();
  assert.equal(snapshot.contextKey,before);
  assert.equal(snapshot.modelName,'GPT-6 Astra');
});
test('model snapshot rejects a navigation during the asynchronous menu read',async()=>{
  const {ctx,location}=modelSnapshotFixture();
  ctx.closeHiddenModelControl = async()=>{location.pathname='/c/another';return true;};
  await assert.rejects(ctx.nativeModelControlSnapshot(),/conversation-changed/);
});
