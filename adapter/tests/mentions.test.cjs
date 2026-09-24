const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-adapter.user.js'), 'utf8');
const block = source.slice(source.indexOf('\t// Native mentions use'), source.indexOf('\tfunction forwardSend()'));
function fixture() {
  let serial = 0;
  const ctx = vm.createContext({Map, Set, JSON, Object, Array, Number, String, Error, Promise, Date, URL,
    crypto:{randomUUID:()=>String(++serial)}, documentID:'doc-1', location:{origin:'https://chatgpt.com'},
    requestAnimationFrame:fn=>setImmediate(fn)});
  vm.runInContext(block,ctx);
  const menu = {librarySearchKey:null,isFileLibrarySearchPending:false,libraryFolderPathSuggestions:[],fileLibraryPathSuggestions:[],
    gptsAndAppsSlashCommands$:()=>[],onSearchQueryChange(q){menu.librarySearchKey=q?JSON.stringify([q]):null;}};
  const state = {scope:'account-A:conversation-1',attachmentScope:'account-A:conversation-1',menu,store:{files$:()=>[],chatUploadLimitError$:()=>false}};
  ctx.websiteMentionState=()=>state;
  return {ctx,state,menu};
}
function item(id='plugin:pdf', title='PDF') {
  return {id,title,insertText:title,secondary:'Read PDFs',onSelect(){},searchParameters:{targets:[title,'Read PDFs']},
    meta:{isApp:true,isConnected:true,systemHintType:id,mention:{representation:'inline-pill',kind:'system-hint'}}};
}
function selection(ctx,state,title='PDF',kind='plugin') {
  const candidate=ctx.projectMentionItem(item('plugin:pdf',title),kind,state.scope);
  return {candidate,location:0,length:title.length+1};
}
function copy(value){return JSON.parse(JSON.stringify(value));}
test('queries mounted service without touching an editor; filters disabled/unconnected plugins and preserves server-ranked files',async()=>{
  const {ctx,menu}=fixture();let calls=[];
  menu.onSearchQueryChange=q=>{calls.push(q);menu.librarySearchKey=JSON.stringify([q]);};
  menu.gptsAndAppsSlashCommands$=()=>[item(),{...item('off'),disabled:true},{...item('not-connected'),meta:{isApp:true,isConnected:false}}];
  menu.fileLibraryPathSuggestions=[{...item('file-library:one','First'),meta:{}},{...item('file-library:two','Second'),meta:{}}];
  const result=await ctx.searchMentions('pdf');
  assert.deepEqual(copy(result.items.map(x=>[x.id,x.kind])),[['plugin:pdf','plugin'],['file-library:one','file'],['file-library:two','file']]);
  assert.deepEqual(calls,['pdf']);assert.equal(result.nextCursor,undefined);
});
test('a new query rejects old pending results, while selected references survive later searches',async()=>{
  const {ctx,state,menu}=fixture();const selected=selection(ctx,state);
  menu.isFileLibrarySearchPending=true;
  const first=ctx.searchMentions('old');const rejected=assert.rejects(first,/search-superseded/);
  menu.isFileLibrarySearchPending=false;
  await ctx.searchMentions('new');await rejected;
  assert.equal(ctx.validateNativeMentions('@PDF',[selected],state.scope).length,1);
});
test('context change during pending query rejects the response',async()=>{
  const {ctx,state,menu}=fixture();menu.isFileLibrarySearchPending=true;
  const p=ctx.searchMentions('pdf');state.scope='account-B:conversation-1';
  await assert.rejects(p,/context-changed/);
});
test('UTF16 ranges preserve emoji before mentions and reject overlap, edited labels and stale account/document keys',()=>{
  const {ctx,state}=fixture();let s=selection(ctx,state);s.location=3;
  assert.equal(ctx.validateNativeMentions('😀 @PDF',[s],state.scope)[0].start,3);
  assert.throws(()=>ctx.validateNativeMentions('😀 @PDF',[s,s],state.scope),/invalid-range/);
  assert.throws(()=>ctx.validateNativeMentions('😀 @PXX',[s],state.scope),/selection-text-mismatch/);
  assert.throws(()=>ctx.validateNativeMentions('😀 @PDF',[s],'account-B'),/selection-stale/);
  s.candidate.payload.documentID='old-doc';
  assert.throws(()=>ctx.validateNativeMentions('😀 @PDF',[s],state.scope),/selection-stale/);
});
test('incomplete/failed API search does not become an empty successful result',async()=>{
  const {ctx}=fixture();ctx.mentionSearchGeneration=4;
  await ctx.observeMentionSearchResponse('pdf',4,{ok:true,clone:()=>({json:async()=>({items:[],partial_results:true})})});
  assert.equal(ctx.mentionSearchFailure.invariant,'search-incomplete');
  ctx.mentionSearchFailure=null;
  await ctx.observeMentionSearchResponse('pdf',3,{ok:false});
  assert.equal(ctx.mentionSearchFailure,null,'obsolete response must not poison latest query');
});
test('request observer only handles composer global search, never credentials or unrelated bodies',()=>{
  const {ctx}=fixture();
  assert.equal(ctx.mentionRequestQuery('/backend-api/global/search',{body:JSON.stringify({query:'pdf',entrypoint:'composer'})}),'pdf');
  assert.equal(ctx.mentionRequestQuery('/backend-api/global/search',{body:JSON.stringify({query:'pdf',entrypoint:'library_page'})}),null);
  assert.equal(ctx.mentionRequestQuery('/api/auth/session',{}),null);
});
test('document construction keeps newlines and substitutes semantic pills; media becomes attachment only',()=>{
  const {ctx,state}=fixture();let s=selection(ctx,state);s.location=2;
  const media={id:'file-library:image',title:'image.png',onSelect(){},meta:{}};
  const mc=ctx.projectMentionItem(media,'file',state.scope);
  const text='看 @PDF\n@image.png\n';
  const ranges=ctx.validateNativeMentions(text,[s,{location:7,length:10,candidate:mc}],state.scope);
  const schema={nodes:{paragraph:{create:(_,children)=>({type:'p',children})},doc:{create:(_,children)=>({type:'doc',children})},inline_selection_pill:{}},text:text=>({type:'text',text})};
  const doc=ctx.buildMentionDocument(text,ranges,schema,(_,v)=>({type:'pill',id:v.mentionId,keyword:v.mentionValue}));
  assert.deepEqual(copy(doc),{type:'doc',children:[{type:'p',children:[{type:'text',text:'看 '},{type:'pill',id:'plugin:pdf',keyword:'PDF'}]},{type:'p',children:[]},{type:'p',children:[]}]});
});
test('surrounding query whitespace is normalized before matching the website request key',async()=>{
  const {ctx,menu}=fixture();let query;
  menu.onSearchQueryChange=q=>{query=q;menu.librarySearchKey=JSON.stringify([q]);};
  await ctx.searchMentions('  PDF  ');assert.equal(query,'PDF');
});
test('eligible plugin with malformed search fields fails visibly instead of disappearing',async()=>{
  const {ctx,menu}=fixture();const malformed=item();delete malformed.searchParameters;
  menu.gptsAndAppsSlashCommands$=()=>[malformed];
  await assert.rejects(ctx.searchMentions('pdf'),/plugin-search-targets-missing/);
});
test('submission guard rejects a concurrent submit and releases after failed preparation',async()=>{
  const {ctx}=fixture();let fail,events=[];
  Object.assign(ctx,{probeChatGPTComposer:()=>({ok:true,anchors:{form:{},editor:{}}}),activateWebsiteComposer(){},hideWebsiteComposer(){},
    reportNativeState:(...e)=>events.push(e),prepareNativeMentions:()=>new Promise((_,reject)=>{fail=reject;})});
  const submit=source.slice(source.indexOf('\tvar nativeSubmissionInFlight'),source.indexOf('\tfunction forwardAttachmentPicker(kind)'));
  vm.runInContext(submit,ctx);
  ctx.freeAutoThinkingState=()=>null;
  const first=ctx.submitNativeDraft('@PDF',[{}]);
  assert.equal(events[0][0],'sending');
  await assert.rejects(ctx.submitNativeDraft('@PDF',[{}]),/submission-in-flight/);
  fail(new Error('preparation rejected'));await assert.rejects(first,/preparation rejected/);
  assert.equal(ctx.nativeSubmissionInFlight,false);assert.equal(events.at(-1)[0],'composer-error');
});
test('failed callback restores original website document and attachments for retry',async()=>{
  const {ctx,state}=fixture();const s=selection(ctx,state,'PDF','file');
  const saved=ctx.mentionSelections.get(s.candidate.payload.selectionKey);
  saved.item.onSelect=()=>{files=[{status:'ready',fileId:'new'}];throw Error('callback failed');};
  const original={content:['original']};let files=[{fileId:'existing'}];const originalFiles=files;
  const view={state:{doc:original,schema:{},get tr(){return {replaceWith:(_,__,content)=>({content})};}},dispatch(tr){view.state.doc={content:tr.content};}};
  view.state.doc.content.size=1;
  const files$=()=>files;files$.set=x=>{files=x;};state.view=view;state.store={files$};
  ctx.websiteMentionPillFactory=async()=>()=>({});ctx.buildMentionDocument=()=>({content:['prepared']});
  await assert.rejects(ctx.prepareNativeMentions('@PDF',[s]),/callback failed/);
  assert.deepEqual(view.state.doc.content,original.content);assert.equal(files,originalFiles);
});
test('identical semantic candidates retain their selection keys while updating callbacks',()=>{
  const {ctx,state}=fixture();const one=selection(ctx,state);const next=item();let called=false;next.onSelect=()=>{called=true;};
  const candidate=ctx.projectMentionItem(next,'plugin',state.scope);
  assert.equal(candidate.payload.selectionKey,one.candidate.payload.selectionKey);
  ctx.mentionSelections.get(candidate.payload.selectionKey).item.onSelect();assert.equal(called,true);
  next.meta={...next.meta,mention:{representation:'inline-pill',kind:'document-reference'}};
  const changed=ctx.projectMentionItem(next,'plugin',state.scope);
  assert.notEqual(changed.payload.selectionKey,candidate.payload.selectionKey);
});
test('inline plugin preparation preserves legacy hint state by never invoking its toggle callback',async()=>{
  const {ctx,state}=fixture();const s=selection(ctx,state);let callback=false;
  ctx.mentionSelections.get(s.candidate.payload.selectionKey).item.onSelect=()=>{callback=true;};
  const doc={content:['pill'],eq(other){return this===other;}},original={content:[]};original.content.size=0;
  const view={state:{doc:original,schema:{},get tr(){return {replaceWith:(_,__,content)=>({content})};}},dispatch(){view.state.doc=doc;}};
  const files$=()=>[];files$.set=()=>{};state.view=view;state.store={files$,chatUploadLimitError$:()=>null};
  ctx.websiteMentionPillFactory=async()=>()=>({});ctx.buildMentionDocument=()=>doc;
  const prepared=await ctx.prepareNativeMentions('@PDF',[s]);
  assert.equal(prepared.verify(),true);assert.equal(callback,false);
});
test('connected legacy WebKit plugin remains searchable with its schema contract',async()=>{
  const {ctx,state,menu}=fixture();const legacy=item();delete legacy.meta.mention;legacy.insertText='@PDF';
  menu.gptsAndAppsSlashCommands$=()=>[legacy];state.view={state:{schema:{marks:{ecosystemMentionMark:{}}}}};
  assert.equal((await ctx.searchMentions('pdf')).items[0].kind,'plugin');
  delete state.view.state.schema.marks.ecosystemMentionMark;
  await assert.rejects(ctx.searchMentions('pdf'),/legacy-plugin-contract-changed/);
});
test('legacy text mark uses semantic plugin ID and keyword, not the menu row ID',()=>{
  const {ctx,state}=fixture();const legacy=item('row-pdf');legacy.meta.systemHintType='plugin:pdf';delete legacy.meta.mention;legacy.insertText='@PDF';
  const candidate=ctx.projectMentionItem(legacy,'plugin',state.scope);
  const ranges=ctx.validateNativeMentions('@PDF',[{candidate,location:0,length:4}],state.scope);
  const schema={nodes:{paragraph:{create:(_,children)=>({children})},doc:{create:(_,children)=>({children})}},marks:{ecosystemMentionMark:{create:attrs=>attrs}},text:(text,marks)=>({text,marks})};
  const doc=ctx.buildMentionDocument('@PDF',ranges,schema,()=>{throw Error('legacy must not build a pill');});
  const node=doc.children[0].children[0];
  assert.equal(node.text,'@PDF');assert.equal(node.marks[0].id,'plugin:pdf');assert.equal(node.marks[0].keyword,'PDF');assert.equal(node.marks[0].kind,'at-mention');
});
test('legacy preparation and rollback restore previously selected tool via fresh named callbacks',async()=>{
  const {ctx,state,menu}=fixture();const legacy=item();delete legacy.meta.mention;legacy.insertText='@PDF';let changes=[];
  const search={...item('search','Search'),color:'selected',meta:{systemHintType:'search'}};
  legacy.onSelect=()=>{changes.push('plugin');legacy.color=legacy.color==='selected'?undefined:'selected';if(legacy.color==='selected')search.color=undefined;};
  search.onSelect=()=>{changes.push('search');search.color=search.color==='selected'?undefined:'selected';};
  menu.gptsAndAppsSlashCommands$=()=>[legacy];menu.systemHints=[search];
  const candidate=ctx.projectMentionItem(legacy,'plugin',state.scope);
  function doc(content){return {content,eq(other){return JSON.stringify(this.content)===JSON.stringify(other.content);}};}
  const original=doc(['original']);original.content.size=1;
  const view={state:{doc:original,schema:{},get tr(){return {replaceWith:(_,__,content)=>({content})};}},dispatch(tr){view.state.doc=doc(tr.content);}};
  let files=[];const files$=()=>files;files$.set=x=>{files=x;};state.view=view;state.store={files$,chatUploadLimitError$:()=>null};
  ctx.websiteMentionPillFactory=async()=>()=>({});ctx.buildMentionDocument=()=>doc(['legacy mark']);
  const prepared=await ctx.prepareNativeMentions('@PDF',[{candidate,location:0,length:4}]);
  assert.equal(legacy.color,'selected');assert.equal(search.color,undefined);assert.equal(prepared.verify(),true);
  await prepared.rollback();
  assert.equal(legacy.color,undefined);assert.equal(search.color,'selected');assert.equal(view.state.doc.eq(original),true);
  assert.deepEqual(changes,['plugin','plugin','search']);
});
