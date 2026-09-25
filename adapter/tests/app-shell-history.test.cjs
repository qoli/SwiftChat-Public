const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const adapterScript=fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-app-shell-history.js'),'utf8');
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const item=(n,mode='chat')=>({id:id(n),title:`Fixture ${n}`,conversation_origin:mode==='chat'?null:'tpp',update_time:`2026-09-${String(n).padStart(2,'0')}T00:00:00Z`,mapping:'must not retain',snippet:'must not retain'});
const url=(mode='chat',offset=0,extra='')=>`https://chatgpt.com/backend-api/conversations?is_archived=false&is_starred=false&${mode==='chat'?'exclude_conversation_origin':'conversation_origin'}=tpp&order=updated&offset=${offset}&limit=2${extra}`;
const page=(items,offset=0,total=items.length)=>({items,offset,total,limit:2});
function fixture(){
 const calls=[];
 const ctx={window:{__SwiftChatWebsiteRuntime:{async navigate(){}}},location:{origin:'https://chatgpt.com',pathname:'/'},URL,Map,Set,Date,setTimeout,clearTimeout};
 vm.runInNewContext(adapterScript,ctx);const api=ctx.window.__SwiftChatAppShellHistory;
 function transport(run){api.configure({requestPage:(key,offset)=>{
  const requestURL=new URL('/backend-api/conversations','https://chatgpt.com');
  for(const [name,value] of JSON.parse(key))requestURL.searchParams.set(name,value);
  requestURL.searchParams.set('offset',String(offset));requestURL.searchParams.set('limit','2');
  const request={key,offset,url:requestURL.href,token:api.beginRequest(requestURL.href)};calls.push(request);
  return run?.(request) ?? Promise.resolve({ok:true});
 }});}
 const respond=(request,payload)=>api.ingest(request.url,payload,request.token);
 return {api,window:ctx.window,calls,transport,respond};
}
test('separate Chat and Work offset zero pages merge without collisions and retain only metadata',()=>{
 const {api}=fixture();api.ingest(url(),page([item(1),item(2)]));api.ingest(url('work'),page([item(3,'work')]));
 const s=api.snapshot(id(2));assert.equal(s.items.length,3);assert.equal(s.items[0].id,id(3));assert.equal(s.activeConversationID,id(2));assert.equal(s.hasMore,false);assert.equal(api.modeForID(id(3)),'work');assert.equal(JSON.stringify(s).includes('must not retain'),false);
});
test('noncontiguous pages wait for gaps and page zero refresh only retires its own stream',()=>{
 const {api}=fixture();api.ingest(url(),page([item(1),item(2)],0,6));api.ingest(url('work'),page([item(7,'work')]));api.ingest(url('chat',4),page([item(5),item(6)],4,6));assert.equal(api.snapshot().items.length,3);assert.equal(api.snapshot().hasMore,true);
 api.ingest(url('chat',2),page([item(3),item(4)],2,6));assert.equal(api.snapshot().items.length,7);assert.equal(api.snapshot().hasMore,false);
 api.ingest(url(),page([item(8)],0,1));assert.equal(api.snapshot().items.length,2);assert.equal(api.modeForID(id(1)),null);assert.equal(api.modeForID(id(7)),'work');
});
test('out of order initial page remains pending until its first page arrives',()=>{
 const {api}=fixture();api.ingest(url('chat',2),page([item(3)],2,3));assert.equal(api.snapshot().state,'loading');api.ingest(url(),page([item(1),item(2)],0,3));assert.equal(api.snapshot().items.length,3);assert.equal(api.snapshot().hasMore,false);
});
test('request dimensions stay isolated and unrelated lists never enter history',()=>{
 const {api}=fixture();assert.equal(api.ingest(url()+'&project_id=private',page([item(1)])),false);assert.equal(api.ingest(url().replace('is_archived=false','is_archived=true'),page([item(1)])),false);assert.equal(api.ingest(url().replace('chatgpt.com','example.com'),page([item(1)])),false);
 api.ingest(url('chat',0,'&hide_snorlax=true'),page([item(1),item(2)],0,3));api.ingest(url('chat',2,'&hide_snorlax=false'),page([item(3)],2,3));assert.equal(api.snapshot().items.length,2);assert.equal(api.snapshot().hasMore,true);
});
test('invalid origin, page size and missing item metadata report explicit unsupported state',()=>{
 for(const value of [page([item(1,'work')]),page([{id:id(1),title:'Fixture'}]),page([{...item(1),title:''}]),page([item(1),item(1)]),page([],0,2)]){const {api}=fixture();api.ingest(url(),value);assert.equal(api.snapshot().state,'unsupported');}
});
test('network-selected Chat and Work rows navigate through the runtime boundary without sidebar targets',async()=>{
 const {api,window}=fixture();api.ingest(url(),page([item(1),item(2)],0,3));api.ingest(url('work'),page([item(4,'work')]));
 // A later network page is not adopted by the website sidebar target store.
 api.ingest(url('chat',2),page([item(3)],2,3));const paths=[];
 window.__SwiftChatWebsiteRuntime.navigate=async value=>{paths.push(value);};
 assert.equal(await api.open(id(3)),true);assert.equal(paths[0],`/c/${id(3)}`);
 assert.equal(await api.open(id(4)),true);assert.equal(paths[1],`/c/${id(4)}`);
 assert.equal(await api.open('invalid-id'),false);assert.equal(await api.open(id(99)),false);assert.equal(paths.length,2);
 window.__SwiftChatWebsiteRuntime.navigate=async()=>{throw Error('website-runtime:router-unavailable');};
 await assert.rejects(api.open(id(3)),/router-unavailable/);assert.equal(paths.length,2);
});
test('started heads remain loading until both website streams settle and failures stay explicit',()=>{
 const {api}=fixture();const chat=api.beginRequest(url()),work=api.beginRequest(url('work'));api.ingest(url(),page([item(1)]),chat);assert.equal(api.snapshot().state,'loading');api.failedRequest(work);assert.equal(api.snapshot().state,'unsupported');const retry=api.beginRequest(url('work'));api.ingest(url('work'),page([item(2,'work')]),retry);assert.equal(api.snapshot().items.length,2);
});
test('request generations reject stale tails and stale heads after a refresh starts',()=>{
 const {api}=fixture();const first=api.beginRequest(url());api.ingest(url(),page([item(1),item(2)],0,4),first);const oldTail=api.beginRequest(url('chat',2));const fresh=api.beginRequest(url());assert.equal(api.ingest(url('chat',2),page([item(3),item(4)],2,4),oldTail),false);api.ingest(url(),page([item(8),item(9)],0,4),fresh);assert.equal(api.ingest(url(),page([item(1),item(2)],0,4),first),false);api.failedRequest(oldTail);assert.equal(api.snapshot().items.length,2);assert.equal(api.snapshot().hasMore,true);
});
test('failure diagnostics distinguish HTTP, cancellation and invalid JSON without exposing error text',()=>{
 for(const [failure,reason] of [[{status:403,message:'secret'},'website-http-403'],[{name:'AbortError',message:'secret'},'website-request-aborted'],[{kind:'invalid-json',message:'secret'},'website-response-invalid-json'],[new Error('secret'),'website-request-failed']]){
  const {api}=fixture();const token=api.beginRequest(url());api.failedRequest(token,failure);assert.equal(api.snapshot().invariant,`app-shell-history:${reason}`);assert.equal(JSON.stringify(api.snapshot()).includes('secret'),false);
 }
});
test('network pagination needs no React and preserves readiness from validated metadata',async()=>{
 const {api,window,calls,transport,respond}=fixture();delete window.__SwiftChatAppShellDOM;
 api.ingest(url(),page([item(1),item(2)],0,3));assert.equal(api.snapshot().state,'ready');assert.equal(api.snapshot().hasMore,true);assert.equal(calls.length,0);
 transport();const first=api.loadMore();assert.equal(api.loadMore(),first);assert.equal(calls.length,1);assert.equal(calls[0].offset,2);
 respond(calls[0],page([item(3)],2,3));assert.equal(await first,true);assert.equal(await api.loadMore(),false);assert.equal(calls.length,1);
});
test('20 of 21 network metadata rows requests offset 20 without any React capability',async()=>{
 const {api}=fixture();
 const requestURL=url().replace('limit=2','limit=20');const rows=Array.from({length:20},(_,i)=>item(i+1));api.ingest(requestURL,{items:rows,offset:0,limit:20,total:21});let requested;
 api.configure({requestPage:(key,offset)=>{requested={key,offset};const next=requestURL.replace('offset=0','offset=20');const token=api.beginRequest(next);api.ingest(next,{items:[item(21)],offset:20,limit:20,total:21},token);return Promise.resolve({ok:true});}});
 assert.equal(api.snapshot().hasMore,true);assert.equal(await api.loadMore(),true);assert.equal(requested.offset,20);assert.equal(JSON.parse(requested.key).find(([key])=>key==='exclude_conversation_origin')[1],'tpp');assert.equal(api.snapshot().items.length,21);assert.equal(api.snapshot().hasMore,false);
});
test('one load action schedules one page per unfinished stream and waits for every projection',async()=>{
 const {api,calls,transport,respond}=fixture();api.ingest(url(),page([item(1),item(2)],0,5));api.ingest(url('work'),page([item(6,'work'),item(7,'work')],0,3));transport();let done=false;
 const operation=api.loadMore().then(()=>{done=true;});assert.equal(calls.length,2);assert.equal(calls.every(r=>r.offset===2),true);await Promise.resolve();assert.equal(done,false);
 const chat=calls.find(r=>JSON.parse(r.key).some(([k])=>k==='exclude_conversation_origin'));const work=calls.find(r=>r!==chat);
 respond(chat,page([item(3),item(4)],2,5));await Promise.resolve();assert.equal(done,false);
 respond(work,page([item(8,'work')],2,3));await operation;assert.equal(done,true);assert.equal(calls.length,2);assert.equal(api.snapshot().hasMore,true);
});
test('synchronous first stream response cannot finish operation before second stream dispatch',async()=>{
 const {api,calls,transport,respond}=fixture();api.ingest(url(),page([item(1),item(2)],0,3));api.ingest(url('work'),page([item(4,'work'),item(5,'work')],0,3));
 transport(request=>{const work=JSON.parse(request.key).some(([k])=>k==='conversation_origin');respond(request,page([item(work?6:3,work?'work':'chat')],2,3));});
 assert.equal(await api.loadMore(),true);assert.equal(calls.length,2);assert.equal(api.snapshot().hasMore,false);
});
test('already observed next-page requests join without another transport call',async()=>{
 const {api,calls,transport}=fixture();api.ingest(url(),page([item(1),item(2)],0,3));const token=api.beginRequest(url('chat',2));transport();const operation=api.loadMore();assert.equal(calls.length,0);
 api.ingest(url('chat',2),page([item(3)],2,3),token);assert.equal(await operation,true);assert.equal(calls.length,0);
});
test('joined Chat and newly dispatched Work both must finish without duplicating either stream',async()=>{
 const {api,calls,transport,respond}=fixture();api.ingest(url(),page([item(1),item(2)],0,3));api.ingest(url('work'),page([item(4,'work'),item(5,'work')],0,3));const token=api.beginRequest(url('chat',2));transport();let done=false;
 const operation=api.loadMore().then(()=>{done=true;});assert.equal(calls.length,1);api.ingest(url('chat',2),page([item(3)],2,3),token);await Promise.resolve();assert.equal(done,false);
 respond(calls[0],page([item(6,'work')],2,3));await operation;assert.equal(calls.length,1);
});
test('an unrelated first page cannot acknowledge the requested Chat page',async()=>{
 const {api,calls,transport,respond}=fixture();api.ingest(url(),page([item(1),item(2)],0,3));transport();let done=false;const operation=api.loadMore().then(()=>{done=true;});
 const work=api.beginRequest(url('work'));api.ingest(url('work'),page([item(4,'work')]),work);await Promise.resolve();assert.equal(done,false);respond(calls[0],page([item(3)],2,3));await operation;
});
test('missing templates and rejected transport stay explicit and never retry automatically',async()=>{
 const {api,calls,transport}=fixture();api.ingest(url(),page([item(1),item(2)],0,3));await assert.rejects(api.loadMore(),/transport-unavailable/);
 let attempts=0;api.configure({requestPage:()=>{attempts++;const error=new Error('private token');error.code='request-template-unavailable';throw error;}});await assert.rejects(api.loadMore(),/request-template-unavailable/);await Promise.resolve();assert.equal(attempts,1);
 transport(request=>{api.failedRequest(request.token,{status:403});return Promise.reject(new Error('private header'));});await assert.rejects(api.loadMore(),/website-http-403/);await Promise.resolve();assert.equal(calls.length,1);assert.equal(api.snapshot().invariant,'app-shell-history:website-http-403');
});
test('refresh during active pagination rejects its operation and ignores the stale result',async()=>{
 const {api,calls,transport,respond}=fixture();api.ingest(url(),page([item(1),item(2)],0,3));transport();const operation=api.loadMore();const fresh=api.beginRequest(url());await assert.rejects(operation,/pagination-context-changed/);
 api.ingest(url(),page([item(8)]),fresh);assert.equal(respond(calls[0],page([item(3)],2,3)),false);assert.equal(api.snapshot().items.length,1);
});
test('network token handling ignores unrelated methods and failures propagate without retry',async()=>{
 const {api,calls,transport}=fixture();assert.equal(api.beginRequest('https://example.com/'),null);assert.equal(api.beginRequest(url(),{method:'POST'}),null);api.ingest(url(),page([item(1),item(2)],0,3));transport();const operation=api.loadMore();api.failedRequest(calls[0].token);await assert.rejects(operation,/website-request-failed/);assert.equal(calls.length,1);
});
test('explicit refresh requests each known stream head once without navigation and replaces old pages',async()=>{
 const {api,calls,transport,respond,window}=fixture();api.ingest(url(),page([item(1),item(2)],0,3));api.ingest(url('chat',2),page([item(3)],2,3));api.ingest(url('work'),page([item(4,'work')]));
 window.history={pushState(){throw Error('must not navigate');}};transport();assert.equal(calls.length,0);const operation=api.refresh();assert.equal(api.refresh(),operation);assert.equal(calls.length,2);assert.equal(calls.every(request=>request.offset===0),true);assert.equal(api.snapshot().state,'loading');
 respond(calls[0],page([item(8)]));assert.equal(api.snapshot().state,'loading');respond(calls[1],page([item(9,'work')]));assert.equal(await operation,true);assert.equal(api.snapshot().state,'ready');assert.equal(api.snapshot().items.length,2);assert.equal(api.modeForID(id(1)),null);assert.equal(api.modeForID(id(3)),null);assert.equal(calls.length,2);
});
test('refresh supersedes pending pagination and rejects late tail metadata',async()=>{
 const {api,calls,transport,respond}=fixture();api.ingest(url(),page([item(1),item(2)],0,3));transport();const pagination=api.loadMore();const tail=calls[0];const refresh=api.refresh();await assert.rejects(pagination,/pagination-context-changed/);assert.equal(calls.length,2);assert.equal(respond(tail,page([item(3)],2,3)),false);respond(calls[1],page([item(8)]));assert.equal(await refresh,true);assert.equal(api.snapshot().items.length,1);
});
test('refresh needs an observed transport and does not issue requests before explicit action',async()=>{
 const {api,calls,transport}=fixture();await assert.rejects(api.refresh(),/transport-unavailable/);transport();await assert.rejects(api.refresh(),/transport-unavailable/);assert.equal(calls.length,0);
 api.ingest(url(),page([item(1)]));assert.equal(calls.length,0);api.configure({requestPage:null});await assert.rejects(api.refresh(),/transport-unavailable/);assert.equal(api.snapshot().items.length,1);
});
test('refresh reports ready only after final head projection and keeps network failures explicit',async()=>{
 const {api,calls,transport,respond}=fixture();api.ingest(url(),page([item(1)]));transport();const states=[];api.configure({onChange:()=>states.push(api.snapshot().state)});
 const operation=api.refresh();respond(calls[0],page([item(2)]));await operation;assert.equal(states.at(-1),'ready');
 const failed=api.refresh();api.failedRequest(calls[1].token,{status:401});await assert.rejects(failed,/website-http-401/);assert.equal(states.at(-1),'unsupported');assert.equal(calls.length,2);
});
