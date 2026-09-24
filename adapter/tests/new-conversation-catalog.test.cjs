const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-adapter.user.js'),'utf8');
const functions=source.slice(source.indexOf('\tfunction newConversationWebsiteState('),source.indexOf('\tfunction unmountConversationAdapter()'));
function fixture(){
 const ctx=vm.createContext({Map,Set,Number,String,Object,Array,Error});vm.runInContext(functions,ctx);ctx.waitForWebsiteState=async(read,invariant)=>{if(!read())throw Error(invariant);return true;};return ctx;
}
function data(){return {models:new Map([['instant',{}],['thinking',{}]]),categories:[{supportedModels:['instant','thinking'],disabledByAdmin:false}],versions:[{id:'5.6',displayTextForIntelligence:'GPT-5.6 Sol',enabled:true,intelligencePresets:[{id:0,title:'Instant',model_slug:'instant',preset_type:'available'},{id:6,title:'Extra high',model_slug:'thinking',thinking_effort:'max',preset_type:'available'}]}]};}
test('catalog preserves website version IDs, preset IDs and model/effort pair without inventing slider offsets',()=>{
 const result=fixture().projectNewConversationCatalog('chat',data(),'5.6');
 assert.equal(result.models[0].id,'5.6');assert.equal(result.models[0].efforts[1].id,'6');
 assert.equal(result.models[0].efforts[1].modelSlug,'thinking');assert.equal(result.models[0].efforts[1].thinkingEffort,'max');
 assert.equal(result.models[0].efforts[0].thinkingEffort,null);assert.equal(result.models[0].efforts[1].value,undefined);
 assert.equal(result.selectedModelID,'5.6');
});
test('catalog excludes unavailable models, admin-disabled categories and upgrade presets',()=>{
 const input=data();input.versions[0].intelligencePresets.push({id:9,title:'Upgrade',model_slug:'thinking',preset_type:'upgrade'});
 input.models.delete('instant');const result=fixture().projectNewConversationCatalog('work',input);
 assert.equal(result.models[0].efforts.length,1);assert.equal(result.models[0].efforts[0].id,'6');
 input.categories[0].disabledByAdmin=true;assert.throws(()=>fixture().projectNewConversationCatalog('work',input),/empty-or-ambiguous/);
});
test('catalog rejects ambiguous IDs, malformed schema, and unsupported modes',()=>{
 const ctx=fixture(),input=data();input.versions.push(input.versions[0]);assert.throws(()=>ctx.projectNewConversationCatalog('chat',input),/ambiguous/);
 assert.throws(()=>ctx.projectNewConversationCatalog('chat',{}),/schema/);assert.throws(()=>ctx.projectNewConversationCatalog('other',data()),/invalid-mode/);
});
test('draft catalog is a cache-only read and does not call selection controls',()=>{
 const ctx=fixture();ctx.currentConversationMode=()=> 'work';let reads=0;
 ctx.newConversationWebsiteState=()=>({client:{getQueryCache:()=>({getAll:()=>{reads++;return[{queryKey:['models','account'],state:{status:'success',data:data()}}];}})},picker:{composerIntelligencePickerState:{selectedVersionEntry:{id:'6 Astra'}}}});
 ctx.openHiddenModelControl=()=>{throw Error('must not open menu');};ctx.selectNewConversationMode=()=>{throw Error('must not select mode');};
 const result=ctx.newConversationCatalog('chat');assert.equal(reads,1);assert.equal(result.selectedModelID,null);assert.equal(result.mode,'chat');
});
test('missing or ambiguous cached catalog fails explicitly',()=>{
 const ctx=fixture();ctx.currentConversationMode=()=> 'chat';ctx.newConversationWebsiteState=()=>({client:{getQueryCache:()=>({getAll:()=>[]})}});
 assert.throws(()=>ctx.newConversationCatalog('chat'),/not-ready-or-ambiguous/);
});
test('commit rejects existing conversations before opening any menu',async()=>{
 const ctx=fixture();ctx.location={pathname:'/c/existing'};ctx.currentConversationMode=()=> 'chat';
 await assert.rejects(ctx.applyNewConversationSelection('chat','5.6','6'),/requires-confirmed-empty-mode/);
});
test('commit passes the verified website selection object and checks resulting selection',async()=>{
 const ctx=fixture();ctx.location={pathname:'/'};ctx.currentConversationMode=()=> 'chat';
 const selection={bucket:6,modelSlug:'thinking',thinkingEffort:'max',availability:{status:'available'}};
 const state={selectedVersionEntry:{id:'5.6'},currentSelection:null};let closed=0;
 ctx.newConversationCatalog=()=>ctx.projectNewConversationCatalog('chat',data());
 ctx.newConversationWebsiteState=()=>({picker:{composerIntelligencePickerState:state},fibers:[{memoizedProps:{selections:[selection],onSelectSliderSelection:actual=>{assert.equal(actual,selection);state.currentSelection=actual;}}}]});
 ctx.openHiddenModelControl=async()=>true;ctx.closeHiddenModelControl=async()=>{closed++;return true;};
 ctx.waitForWebsiteState=async(read,invariant)=>{if(!read())throw Error(invariant);return true;};
 assert.equal(await ctx.applyNewConversationSelection('chat','5.6','6'),true);assert.equal(closed,1);
});
test('rejected commit closes menu and does not report success',async()=>{
 const ctx=fixture();ctx.location={pathname:'/'};ctx.currentConversationMode=()=> 'chat';let closed=0;
 ctx.newConversationCatalog=()=>ctx.projectNewConversationCatalog('chat',data());ctx.newConversationWebsiteState=()=>({picker:{composerIntelligencePickerState:{selectedVersionEntry:{id:'5.6'}}},fibers:[]});
 ctx.openHiddenModelControl=async()=>true;ctx.closeHiddenModelControl=async()=>{closed++;return true;};
 await assert.rejects(ctx.applyNewConversationSelection('chat','5.6','6'),/preset-control-ambiguous/);assert.equal(closed,1);
});
test('catalog defaults only to the observed available selection in the same mode and version',()=>{
 const ctx=fixture();ctx.currentConversationMode=()=> 'chat';
 const current={bucket:6,modelSlug:'thinking',thinkingEffort:'max',availability:{status:'available'}};
 ctx.newConversationWebsiteState=()=>({client:{getQueryCache:()=>({getAll:()=>[{queryKey:['models','account'],state:{status:'success',data:data()}}]})},picker:{composerIntelligencePickerState:{selectedVersionEntry:{id:'5.6'},currentSelection:current}}});
 assert.equal(ctx.newConversationCatalog('chat').models[0].defaultEffortID,'6');
 current.availability.status='unavailable';assert.equal(ctx.newConversationCatalog('chat').models[0].defaultEffortID,null);
 current.availability.status='available';ctx.currentConversationMode=()=> 'work';assert.equal(ctx.newConversationCatalog('chat').models[0].defaultEffortID,null);
});
test('website boundary diagnostics distinguish missing picker from ambiguous ownership',()=>{
 const ctx=fixture();const root={memoizedProps:{client:{getQueryCache(){}}}};const host={'__reactFiber$fixture':{stateNode:{current:root}}};
 ctx.exactlyOne=()=>host;ctx.document={};ctx.SELECTORS={editor:'editor'};ctx.currentConversationMode=()=> 'work';ctx.isModelControlExpanded=()=>false;
 assert.throws(()=>ctx.newConversationWebsiteState(),/clients=1:pickers=0:mode=work:menu=false/);
});
test('commit waits for home picker hydration before reading catalog or opening menu',async()=>{
 const ctx=fixture();ctx.location={pathname:'/'};ctx.currentConversationMode=()=> 'work';
 let ready=false,opened=false,waited=false;
 const selection={bucket:6,modelSlug:'thinking',thinkingEffort:'max',availability:{status:'available'}};
 const state={selectedVersionEntry:{id:'5.6'},currentSelection:null};
 ctx.newConversationWebsiteState=allowPending=>{
  if(!ready){assert.equal(allowPending,"pending");return null;}
  return {picker:{composerIntelligencePickerState:state},fibers:[{memoizedProps:{selections:[selection],onSelectSliderSelection:s=>state.currentSelection=s}}]};
 };
 ctx.waitForWebsiteState=async(read,invariant)=>{if(invariant==='new-conversation:picker-not-ready'){assert.equal(read(),null);assert.equal(opened,false);ready=true;waited=true;}assert.ok(read());};
 ctx.newConversationCatalog=()=>{assert.equal(waited,true);return ctx.projectNewConversationCatalog('work',data());};
 ctx.openHiddenModelControl=async()=>{opened=true;return true;};ctx.closeHiddenModelControl=async()=>true;
 assert.equal(await ctx.applyNewConversationSelection('work','5.6','6'),true);
});
test('pending picker option accepts only zero picker with one client, never multiple owners',()=>{
 const ctx=fixture();const root={memoizedProps:{client:{getQueryCache(){}}}};const host={'__reactFiber$fixture':{stateNode:{current:root}}};
 ctx.exactlyOne=()=>host;ctx.document={};ctx.SELECTORS={editor:'editor'};ctx.currentConversationMode=()=> 'work';ctx.isModelControlExpanded=()=>false;
 assert.equal(ctx.newConversationWebsiteState("pending"),null);
 root.child={memoizedProps:{dropdownContent:{props:{composerIntelligencePickerState:{},modelsData:{}}}},sibling:{memoizedProps:{dropdownContent:{props:{composerIntelligencePickerState:{},modelsData:{}}}}}};
 assert.throws(()=>ctx.newConversationWebsiteState("pending"),/clients=1:pickers=2/);
});
test('website readiness observer rejects hard contract errors and disconnects instead of leaving an unhandled exception',async()=>{
 let notify,disconnected=0;const ctx=vm.createContext({Promise,Error,setTimeout,clearTimeout,document:{documentElement:{}},MutationObserver:class{constructor(callback){notify=callback;}observe(){}disconnect(){disconnected++;}}});
 vm.runInContext(source.slice(source.indexOf('\tfunction waitForWebsiteState('),source.indexOf('\tasync function selectNewConversationMode(')),ctx);
 let pending=true;const result=ctx.waitForWebsiteState(()=>{if(pending)return null;throw Error('website-state-ambiguous:pickers=2');},'not-ready');
 pending=false;notify();await assert.rejects(result,/pickers=2/);assert.equal(disconnected,1);
});

test('commit uses website-resolved model and effort for the requested preset',async()=>{
 for(const selection of [
  {bucket:0,modelSlug:'resolved-instant',availability:{status:'available'}},
  {bucket:6,modelSlug:'resolved-thinking',thinkingEffort:'standard',availability:{status:'available'}}
 ]){
  const ctx=fixture();ctx.location={pathname:'/'};ctx.currentConversationMode=()=> 'chat';
  const state={selectedVersionEntry:{id:'5.6'},currentSelection:null};
  ctx.newConversationCatalog=()=>ctx.projectNewConversationCatalog('chat',data());
  ctx.newConversationWebsiteState=()=>({picker:{composerIntelligencePickerState:state},fibers:[{memoizedProps:{selections:[selection],onSelectSliderSelection:actual=>{assert.equal(actual,selection);state.currentSelection=actual;}}}]});
  ctx.openHiddenModelControl=async()=>true;ctx.closeHiddenModelControl=async()=>true;
  assert.equal(await ctx.applyNewConversationSelection('chat','5.6',String(selection.bucket)),true);
 }
});
test('resolved preset rejects duplicates, unavailable controls, and incorrect applied state',async()=>{
 for(const failure of ['duplicate','unavailable','wrong-result']){
  const ctx=fixture();ctx.location={pathname:'/'};ctx.currentConversationMode=()=> 'chat';let calls=0,closed=0;
  const selection={bucket:0,modelSlug:'resolved-instant',availability:{status:failure==='unavailable'?'unavailable':'available'}};
  const state={selectedVersionEntry:{id:'5.6'},currentSelection:null};
  ctx.newConversationCatalog=()=>ctx.projectNewConversationCatalog('chat',data());
  ctx.newConversationWebsiteState=()=>({picker:{composerIntelligencePickerState:state},fibers:[{memoizedProps:{selections:failure==='duplicate'?[selection,{...selection}]:[selection],onSelectSliderSelection:actual=>{calls++;state.currentSelection={...actual,modelSlug:'wrong-model'};}}}]});
  ctx.openHiddenModelControl=async()=>true;ctx.closeHiddenModelControl=async()=>{closed++;return true;};
  await assert.rejects(ctx.applyNewConversationSelection('chat','5.6','0'),failure==='wrong-result'?/preset-not-confirmed/:/preset-control-ambiguous/);
  assert.equal(calls,failure==='wrong-result'?1:0);assert.equal(closed,1);
 }
});
test('catalog recognizes selected preset when website resolves a different model slug',()=>{
 const ctx=fixture();ctx.currentConversationMode=()=> 'chat';
 ctx.newConversationWebsiteState=()=>({client:{getQueryCache:()=>({getAll:()=>[{queryKey:['models'],state:{status:'success',data:data()}}]})},picker:{composerIntelligencePickerState:{selectedVersionEntry:{id:'5.6'},currentSelection:{bucket:0,modelSlug:'resolved-instant',availability:{status:'available'}}}}});
 assert.equal(ctx.newConversationCatalog('chat').models[0].defaultEffortID,'0');
});
test('read-only catalog does not require an active website model picker',()=>{
 const ctx=fixture();let cacheReads=0;
 const root={memoizedProps:{client:{getQueryCache:()=>({getAll:()=>{cacheReads++;return [{queryKey:['models'],state:{status:'success',data:data()}}];}})}}};
 const host={'__reactFiber$fixture':{stateNode:{current:root}}};
 ctx.exactlyOne=()=>host;ctx.document={};ctx.SELECTORS={editor:'editor'};ctx.currentConversationMode=()=>null;ctx.isModelControlExpanded=()=>false;
 const catalog=ctx.newConversationCatalog('chat');
 assert.equal(cacheReads,1);assert.equal(catalog.models[0].id,'5.6');assert.equal(catalog.selectedModelID,null);assert.equal(catalog.models[0].defaultEffortID,null);
});
test('catalog diagnostics distinguish pending cache data from ambiguous successful queries',()=>{
 const ctx=fixture();let queries=[{queryKey:['models'],state:{status:'pending',fetchStatus:'fetching'}}];
 ctx.newConversationWebsiteState=()=>({client:{getQueryCache:()=>({getAll:()=>queries})}});
 assert.throws(()=>ctx.newConversationCatalog('chat'),/catalog-not-ready-or-ambiguous:queries=1:ready=0:states=pending\/fetching/);
 queries=[{queryKey:['models'],state:{status:'success',fetchStatus:'idle'}},{queryKey:['models'],state:{status:'success',fetchStatus:'idle'}}];
 assert.throws(()=>ctx.newConversationCatalog('chat'),/catalog-not-ready-or-ambiguous:queries=2:ready=2:states=success\/idle,success\/idle/);
});
test('catalog load waits only for the existing pending website fetch',async()=>{
 const ctx=fixture();const query={queryKey:['models'],state:{status:'pending',fetchStatus:'fetching'}};
 let notification,unsubscribed=0,reads=0;
 const cache={getAll:()=>[query],subscribe:callback=>{notification=callback;return()=>unsubscribed++;}};
 ctx.newConversationWebsiteState=()=>({client:{getQueryCache:()=>cache}});
 ctx.newConversationCatalog=()=>{reads++;assert.equal(query.state.status,'success');return {mode:'chat',models:[]};};
 ctx.waitForWebsiteState=(read,invariant,diagnostic,subscribe)=>new Promise((resolve,reject)=>{
  assert.equal(read(),null);const stop=subscribe(()=>{try{const result=read();stop();resolve(result);}catch(error){stop();reject(error);}});
 });
 const result=ctx.loadNewConversationCatalog('chat');assert.equal(reads,0);
 query.state={status:'success',fetchStatus:'idle'};notification();
 assert.equal((await result).mode,'chat');assert.equal(reads,1);assert.equal(unsubscribed,1);
});
test('catalog load preserves missing, failed, paused and ambiguous cache failures',async()=>{
 for(const queries of [[],[{queryKey:['models'],state:{status:'error',fetchStatus:'idle'}}],[{queryKey:['models'],state:{status:'pending',fetchStatus:'paused'}}],[{queryKey:['models'],state:{status:'pending',fetchStatus:'fetching'}},{queryKey:['models'],state:{status:'pending',fetchStatus:'fetching'}}]]){
  const ctx=fixture(),cache={getAll:()=>queries};ctx.newConversationWebsiteState=()=>({client:{getQueryCache:()=>cache}});
  await assert.rejects(async()=>ctx.loadNewConversationCatalog('chat'),/catalog-not-ready-or-ambiguous/);
 }
});
test('catalog fetch wait rejects a replaced website cache',async()=>{
 const ctx=fixture();const cache={getAll:()=>[{queryKey:['models'],state:{status:'pending',fetchStatus:'fetching'}}]};let current=cache;
 ctx.newConversationWebsiteState=()=>({client:{getQueryCache:()=>current}});
 ctx.waitForWebsiteState=async read=>{assert.equal(read(),null);current={getAll:()=>[]};read();};
 await assert.rejects(async()=>ctx.loadNewConversationCatalog('chat'),/catalog-context-changed/);
});
test('website state waits unsubscribe query observers on completion and deadline',async()=>{
 for(const outcome of ['ready','deadline','subscribe-error']){
  let notify,deadline,stopped=0,cleared=0,ready=false;
  const ctx=vm.createContext({Promise,Error,setTimeout:callback=>{deadline=callback;return 1;},clearTimeout:()=>cleared++});
  vm.runInContext(source.slice(source.indexOf('\tfunction waitForWebsiteState('),source.indexOf('\tasync function selectNewConversationMode(')),ctx);
  const waiting=ctx.waitForWebsiteState(()=>ready,'catalog-deadline',null,callback=>{
   if(outcome==='subscribe-error')throw Error('observer unavailable');
   notify=callback;return()=>stopped++;
  });
  if(outcome==='ready'){ready=true;notify();assert.equal(await waiting,true);}
  else if(outcome==='deadline'){deadline();await assert.rejects(waiting,/catalog-deadline/);}
  else await assert.rejects(waiting,/observer unavailable/);
  assert.equal(stopped,outcome==='subscribe-error'?0:1);assert.equal(cleared,1);
 }
});
