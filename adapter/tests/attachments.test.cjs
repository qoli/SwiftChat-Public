const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {File} = require('node:buffer');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-adapter.user.js'), 'utf8');
const block = source.slice(source.indexOf('\t// Native attachments retain'), source.indexOf('\tfunction forwardSend()'));
const submit = source.slice(source.indexOf('\tvar nativeSubmissionInFlight'), source.indexOf('\tfunction forwardAttachmentPicker(kind)'));
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  let files = [], limit = false, serial = 0, register = true, draft = '', sends = 0;
  const diagnostics = [], timers = [], frames = [], reports = [];
  const state = {scope:'account:doc:conversation:model', store:{files$:()=>files,chatUploadLimitError$:()=>limit}};
  Object.defineProperty(state, 'attachmentScope', {get(){return state.scope;}});
  const input = {accept:'image/*',disabled:false,dispatchEvent(event){
    assert.equal(event.bubbles,true);
    if (event.type === 'input') return;
    assert.equal(event.type,'change');
    if (register) files.push({file:this.files[0],tempId:`temp-${++serial}`,status:'uploading'});
  }};
  const form = {}, document = {}, host = {};
  const root = {memoizedProps:{}};
  host.__reactFiber$fixture = {stateNode:{current:root}};
  class DataTransfer {
    constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}
  }
  const ctx = vm.createContext({Map,Set,Error,Promise,File,DataTransfer,Uint8Array,atob,Event,
    performance, documentID:'fixture-document', ADAPTER_VERSION:'fixture-version',
    setTimeout:fn=>{timers.push(fn);return timers.length;},
    window:{webkit:{messageHandlers:{swiftChatConversationAdapterStatus:{postMessage:value=>diagnostics.push(copy(value))}}}},
    document,SELECTORS:{form:'form',editor:'editor'},location:{pathname:'/c/fixture'},queueMicrotask,
    requestAnimationFrame:fn=>{if(fn.name==='observeNativeAttachmentState'){frames.push(fn);return frames.length;}return setImmediate(fn);},
    isGenerating:()=>false,websiteMentionState:()=>state,
    attachmentControl:()=>input,exactlyOne:(target,selector)=>selector==='editor'?host:selector==='form'?form:input,
    mentionError:invariant=>new Error(`mentions:${invariant}`),
    probeChatGPTComposer:()=>({ok:true,anchors:{form,editor:{}}}),
    activateWebsiteComposer(){},hideWebsiteComposer(){},reportNativeState(){reports.push(copy(ctx.nativeAttachmentReport()));},
    waitForWebsiteState:async(read,invariant)=>{const value=read();if(!value) throw new Error(invariant);return value;},
    syncDraftToSite:text=>{draft=text;return true;},editorDraftText:()=>draft,normalizeEditorText:text=>text,
    forwardSend:()=>{sends++;return true;},documentScrollState:null});
  vm.runInContext(block+submit,ctx);
  return {ctx,state,input,root,diagnostics,timers,frames,reports,get files(){return files;},set files(value){files=value;},
    set limit(value){limit=value;},set register(value){register=value;},get sends(){return sends;},
    add:(id='a',mime='image/png')=>ctx.importNativeAttachment(id,'fixture.png',mime,Buffer.from('image bytes').toString('base64'))};
}
test('upload preserves the exact File identity registered by the website, MIME and bytes',async()=>{
  const f=fixture();assert.deepEqual(copy(await f.add()),[{id:'a',status:'uploading'}]);
  assert.equal(f.input.files[0],f.files[0].file);
  assert.equal(f.files[0].file.name,'fixture.png');assert.equal(f.files[0].file.type,'image/png');
  assert.equal(await f.files[0].file.text(),'image bytes');
  await assert.rejects(f.add(),/duplicate-identity/);
  f.register=false;await assert.rejects(f.add('b'),/upload-not-registered/);
  assert.equal(f.ctx.nativeAttachments.has('b'),true);
  assert.equal(f.ctx.nativeAttachmentSnapshot().find(item=>item.id==='b').status,'failed');
});
test('snapshot distinguishes uploading, ready, failed, missing, unknown, and upload limits',async()=>{
  const f=fixture();await f.add();
  for (const [status,expected] of [['uploading','uploading'],['ready','ready'],['failed','failed'],['error','failed'],['unknown','failed']]) {
    f.files[0].status=status;assert.equal(f.ctx.nativeAttachmentSnapshot()[0].status,expected);
  }
  f.files[0].status='ready';f.limit=true;
  assert.match(f.ctx.nativeAttachmentSnapshot()[0].error,/limit/);
  f.limit=false;f.files=[];assert.match(f.ctx.nativeAttachmentSnapshot()[0].error,/no longer/);
});
test('ownership scope change still removes the exact attachment retained by the website',async()=>{
  const f=fixture();await f.add();let calls=0;
  f.root.memoizedProps={tempId:'temp-1',onRemove:()=>{calls++;f.files=[];}};f.state.scope='different-model';
  assert.match(f.ctx.nativeAttachmentSnapshot()[0].error,/different conversation/);
  assert.equal(await f.ctx.removeNativeAttachment('a'),true);assert.equal(calls,1);
  assert.equal(f.files.length,0);assert.equal(f.ctx.nativeAttachments.size,0);
});
test('changed scope forgets absent old attachment without touching unrelated website files',async()=>{
  const f=fixture();await f.add();let calls=0;
  f.state.scope='different-conversation';f.files=[{tempId:'other',status:'ready'}];
  f.root.memoizedProps={tempId:'other',onRemove:()=>calls++};
  assert.equal(await f.ctx.removeNativeAttachment('a'),true);assert.equal(calls,0);
  assert.equal(f.files.length,1);assert.equal(f.files[0].tempId,'other');assert.equal(f.ctx.nativeAttachments.size,0);
});
test('remove requires one verified callback and confirms website store removal',async()=>{
  const f=fixture();await f.add();
  await assert.rejects(f.ctx.removeNativeAttachment('a'),/remove-control-unavailable/);
  f.root.memoizedProps={tempId:'temp-1',onRemove(){}};
  await assert.rejects(f.ctx.removeNativeAttachment('a'),/removal-not-confirmed/);
  assert.equal(f.ctx.nativeAttachments.size,1);
  let calls=0;f.root.memoizedProps.onRemove=()=>{calls++;f.files=[];};
  assert.equal(await f.ctx.removeNativeAttachment('a'),true);assert.equal(calls,1);
  assert.equal(f.ctx.nativeAttachments.size,0);
});
test('ambiguous removal callbacks fail without mutating attachment ownership',async()=>{
  const f=fixture();await f.add();
  f.root.child={memoizedProps:{tempId:'temp-1',onRemove(){}}};
  f.root.sibling={memoizedProps:{tempId:'temp-1',onRemove(){}}};
  await assert.rejects(f.ctx.removeNativeAttachment('a'),/remove-control-unavailable/);
  assert.equal(f.ctx.nativeAttachments.size,1);
});
test('draft identity must match the complete attachment set without duplicates',async()=>{
  const f=fixture();await f.add('a');await f.add('b');f.files.forEach(file=>file.status='ready');
  assert.throws(()=>f.ctx.verifyNativeAttachments(['a']),/draft-identity-mismatch/);
  assert.throws(()=>f.ctx.verifyNativeAttachments(['a','missing']),/draft-identity-mismatch/);
  assert.throws(()=>f.ctx.verifyNativeAttachments(['a','a']),/draft-identity-mismatch/);
  assert.doesNotThrow(()=>f.ctx.verifyNativeAttachments(['b','a']));
});
test('send blocks unready attachments, preserves retry identity, then accepts attachment-only draft',async()=>{
  const f=fixture();await f.add();
  await assert.rejects(f.ctx.submitNativeDraft('',[],'',['a']),/not-ready/);
  assert.equal(f.sends,0);assert.equal(f.ctx.nativeSubmissionInFlight,false);assert.equal(f.ctx.nativeAttachments.size,1);
  f.files[0].status='ready';assert.equal(await f.ctx.submitNativeDraft('',[],'',['a']),true);
  assert.equal(f.sends,1);assert.equal(f.ctx.nativeAttachments.size,0);
});
test('send rechecks upload state after website draft synchronization',async()=>{
  const f=fixture();await f.add();f.files[0].status='ready';
  f.ctx.requestAnimationFrame=fn=>{f.files[0].status='failed';setImmediate(fn);};
  await assert.rejects(f.ctx.submitNativeDraft('question',[],'',['a']),/not-ready/);
  assert.equal(f.sends,0);assert.equal(f.ctx.nativeAttachments.size,1);
});

test('context acknowledgment retains attachment identity until success and preserves it on failure',async()=>{
  for (const succeeds of [true,false]) {
    const f=fixture();await f.add();f.files[0].status='ready';
    let resolveLease,rejectLease,notifyArmed;
    const armed=new Promise(resolve=>{notifyArmed=resolve;});
    const lease=new Promise((resolve,reject)=>{resolveLease=resolve;rejectLease=reject;});
    f.ctx.currentConversationMode=()=> 'chat';
    f.ctx.armAppContext=()=>{notifyArmed();return {promise:lease,finish(){}};};
    const submission=f.ctx.submitNativeDraft('question',[],'context',['a']);
    const result=succeeds?submission:assert.rejects(submission,/context failed/);
    await armed;
    assert.equal(f.sends,1);
    assert.equal(f.ctx.nativeAttachments.size,1,'Pending acknowledgment must keep identity');
    if(succeeds) resolveLease();else rejectLease(new Error('context failed'));
    await result;
    assert.equal(f.ctx.nativeAttachments.size,succeeds?0:1);
    assert.equal(f.ctx.nativeSubmissionInFlight,false);
  }
});

test('pending registration retains File identity and late registration remains removable after timeout',async()=>{
  const f=fixture();f.register=false;
  let rejectRegistration;
  f.ctx.waitForWebsiteState=(read,invariant)=>{
    assert.equal(read(),false);
    assert.equal(f.ctx.nativeAttachmentSnapshot()[0].status,'preparing');
    return new Promise((_,reject)=>{rejectRegistration=()=>reject(new Error(invariant));});
  };
  const importResult=f.add('late','application/pdf');
  const rejected=assert.rejects(importResult,/upload-not-registered/);
  assert.equal(f.ctx.nativeAttachments.size,1);
  const originalFile=f.input.files[0];
  rejectRegistration();await rejected;
  assert.equal(f.ctx.nativeAttachmentSnapshot()[0].status,'failed');
  await assert.rejects(f.ctx.removeNativeAttachment('late'),/registration-unresolved-reload-conversation/);
  assert.equal(f.ctx.nativeAttachments.size,1);
  f.files=[{file:originalFile,tempId:'late-temp',status:'ready'}];
  let removals=0;
  f.root.memoizedProps={tempId:'late-temp',onRemove:()=>{removals++;f.files=[];}};
  assert.equal(await f.ctx.removeNativeAttachment('late'),true);
  assert.equal(removals,1);assert.equal(f.files.length,0);assert.equal(f.ctx.nativeAttachments.size,0);
});
test('generic file registration activates the form and waits for website registration',async()=>{
  const f=fixture();f.register=false;let active=false,finished=false;
  f.ctx.activateWebsiteComposer=()=>{active=true;};
  f.ctx.hideWebsiteComposer=()=>{active=false;finished=true;};
  f.ctx.waitForWebsiteState=async(read)=>{
    assert.equal(active,true);assert.equal(read(),false);
    await Promise.resolve();
    f.files=[{file:f.input.files[0],tempId:'generic',status:'uploading'}];
    assert.equal(read(),true);
  };
  assert.deepEqual(copy(await f.add('document','application/pdf')),[{id:'document',status:'uploading'}]);
  assert.equal(active,false);assert.equal(finished,true);
});

test('restored website files project metadata without reading their binary contents',()=>{
  const f=fixture();
  const file={name:'restored.pdf',type:'application/pdf',size:4321,arrayBuffer(){throw new Error('must not read binary');}};
  f.files=[{file,tempId:'restored',status:'ready'}];
  assert.deepEqual(copy(f.ctx.nativeAttachmentSnapshot()),[{
    id:'website:restored',status:'ready',name:'restored.pdf',mimeType:'application/pdf',size:4321
  }]);
  assert.equal(f.ctx.nativeAttachments.size,1);
  assert.equal(f.ctx.nativeAttachmentSnapshot().length,1,'Repeated reports must not duplicate restored files');
});
test('restored attachment identity blocks stale send until the reviewed IDs are supplied',async()=>{
  const f=fixture();f.files=[{file:new File(['pdf'],'restored.pdf',{type:'application/pdf'}),tempId:'restored',status:'ready'}];
  f.ctx.nativeAttachmentSnapshot();
  await assert.rejects(f.ctx.submitNativeDraft('question',[],'',[]),/draft-identity-mismatch/);
  assert.equal(f.sends,0);
  assert.equal(await f.ctx.submitNativeDraft('question',[],'',['website:restored']),true);
  assert.equal(f.sends,1);
});
test('sent website attachments are not resurrected while the website clears its store',async()=>{
  const f=fixture();await f.add();f.files[0].status='ready';
  const sent=f.files[0];
  assert.equal(await f.ctx.submitNativeDraft('question',[],'',['a']),true);
  assert.deepEqual(copy(f.ctx.nativeAttachmentSnapshot()),[]);
  assert.equal(f.ctx.submittedAttachmentIDs.has(sent.tempId),true);
  f.files=[];assert.deepEqual(copy(f.ctx.nativeAttachmentSnapshot()),[]);
  assert.equal(f.ctx.submittedAttachmentIDs.size,0);
  f.files=[{file:new File(['new'],'new.txt',{type:'text/plain'}),tempId:'new',status:'ready'}];
  assert.equal(f.ctx.nativeAttachmentSnapshot()[0].id,'website:new');
});
test('website file adoption is suppressed during submission and unsupported metadata fails explicitly',()=>{
  const f=fixture();f.files=[{file:new File(['new'],'new.txt',{type:'text/plain'}),tempId:'new',status:'ready'}];
  f.ctx.nativeSubmissionInFlight=true;
  assert.deepEqual(copy(f.ctx.nativeAttachmentSnapshot()),[]);
  f.ctx.nativeSubmissionInFlight=false;
  assert.equal(f.ctx.nativeAttachmentSnapshot()[0].id,'website:new');
  f.files.push({tempId:'missing-file',status:'ready'});
  assert.throws(()=>f.ctx.nativeAttachmentSnapshot(),/restored-file-metadata-unavailable/);
});

test('late website attachment appearing after preflight blocks send even without native attachments',async()=>{
  const f=fixture();
  f.ctx.requestAnimationFrame=fn=>{
    f.files=[{file:new File(['late'],'late.pdf',{type:'application/pdf'}),tempId:'late',status:'ready'}];
    setImmediate(fn);
  };
  await assert.rejects(f.ctx.submitNativeDraft('question'),/unreviewed-website-attachment/);
  assert.equal(f.sends,0);
});
test('prepared mention authorizes exactly its own website file and no unrelated attachment',async()=>{
  for (const unrelated of [false,true]) {
    const f=fixture();let rolledBack=false;
    const mentioned={fileId:'library-1',tempId:'mentioned',status:'ready'};
    f.ctx.prepareNativeMentions=async()=>{
      f.files=[mentioned];
      if(unrelated) f.files.push({file:new File(['other'],'other.txt',{type:'text/plain'}),tempId:'other',status:'ready'});
      return {attachmentFiles:[mentioned],verify:()=>true,rollback:async()=>{rolledBack=true;}};
    };
    if(unrelated) {
      await assert.rejects(f.ctx.submitNativeDraft('@file',[{}]),/unreviewed-website-attachment/);
      assert.equal(f.sends,0);assert.equal(rolledBack,true);
    } else {
      assert.equal(await f.ctx.submitNativeDraft('@file',[{}]),true);
      assert.equal(f.sends,1);assert.equal(rolledBack,false);
    }
  }
});

test('diagnostics observe completion without DOM changes and never expose attachment content or names', async () => {
  const f=fixture();
  const id='12345678-1234-1234-1234-123456789abc';
  await f.add(id);
  assert.deepEqual(f.diagnostics.map(x=>x.attachmentDiagnostic.stage), ['dispatch','registered']);
  assert.equal(f.diagnostics[1].attachmentDiagnostic.rawStatus,'uploading');
  assert.equal(f.diagnostics[1].attachmentDiagnostic.registered,true);
  f.files[0].status='ready';
  f.timers.shift()();
  assert.equal(f.diagnostics.at(-1).attachmentDiagnostic.rawStatus,'ready');
  assert.equal(f.diagnostics.at(-1).attachmentDiagnostic.id,id);
  assert.equal(f.timers.length,0, 'Terminal state stops sampling');
  assert.equal(f.files[0].status,'ready', 'Diagnostics do not change upload state');
  const serialized=JSON.stringify(f.diagnostics);
  for(const secret of ['fixture.png','image bytes','temp-1','account:doc']) assert.equal(serialized.includes(secret),false);
});
test('diagnostics distinguish a pending website upload, changed scope and upload limit', async () => {
  const f=fixture();await f.add();
  f.limit=true;f.state.scope='another-account';f.timers.shift()();
  const d=f.diagnostics.at(-1).attachmentDiagnostic;
  assert.equal(d.rawStatus,'uploading');assert.equal(d.scopeMatches,false);assert.equal(d.limit,true);
  assert.equal(f.timers.length,1);
  f.files[0].status='failed';f.timers.shift()();assert.equal(f.timers.length,0);
});

test('hidden composer upload completion reaches native without any DOM mutation',async()=>{
  const f=fixture();await f.add();assert.equal(f.frames.length,1);
  f.frames.shift()();assert.equal(f.reports.length,0, 'Unchanged signal does not flood the bridge');
  assert.equal(f.frames.length,1);
  f.files[0].status='ready';f.frames.shift()();
  assert.equal(f.reports.at(-1)[0].status,'ready');
  assert.equal(f.frames.length,0, 'Observation stops after completion');
});
test('hidden composer failure, limits and file disappearance reach native without DOM mutations',async()=>{
  for (const change of ['error','limit','removed']) {
    const f=fixture();await f.add();
    if(change==='error') f.files[0].status='error';
    if(change==='limit') f.limit=true;
    if(change==='removed') f.files=[];
    f.frames.shift()();
    assert.equal(f.reports.at(-1)[0].status,'failed',change);
    assert.equal(f.frames.length,0,change);
  }
});
test('removing a pending attachment stops signal observation',async()=>{
  const f=fixture();await f.add();
  f.root.memoizedProps={tempId:'temp-1',onRemove:()=>{f.files=[];}};
  await f.ctx.removeNativeAttachment('a');f.frames.shift()();
  assert.equal(f.frames.length,0);assert.equal(f.reports.length,0);
});
