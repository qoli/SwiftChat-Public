const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-adapter.user.js'), 'utf8');

function fixture(websiteFailure, directFailure = null, navigationFailure = null,
                 resolvedReferences = null) {
  const calls=[], envelopes=[], serializedReferences=[], statuses=[], rootListeners=new Set();
  let contextFailure=null, displayMode='raw';
  const runtime={context:()=>{
    if(contextFailure)throw new Error(contextFailure);
    return{mode:'chat',conversationID:null,streaming:false};
  },
    serializeReferences(text,references){serializedReferences.push(references);return text;},
    newConversation:async()=>true,setMode:async()=>true,
    async submit(envelope){calls.push('website');envelopes.push(envelope);
      if(websiteFailure)throw new Error(websiteFailure);
      return{accepted:true,route:'website-command',profile:'fixture'};},
    async navigate(path){calls.push(`navigate:${path}`);if(navigationFailure)throw new Error(navigationFailure);return true;},
    stop:()=>true};
  const direct={active:false,observeRequest(){},configure(){},
    async submit(){calls.push('direct');if(directFailure)throw new Error(directFailure);
      return{accepted:true,route:'direct-network',profile:'fixture',conversationID:'11111111-1111-4111-8111-111111111111'};},
    stop:()=>true};
  const noop=()=>{};
  const window={
    __SwiftChatWebsiteRuntime:runtime,
    __SwiftChatConversationDisplay:{apply:()=>({mode:displayMode}),observe:noop,setBottomInset:()=>true},
    __SwiftChatNetworkModels:{contextKey:()=>"catalog",resolve:()=>({model:{slug:'fixture'},systemHints:[]}),catalog:()=>({}),configure:noop},
    __SwiftChatAppShellHistory:{snapshot:()=>({state:'ready',items:[],hasMore:false}),configure:noop,open:noop,loadMore:noop,refresh:noop},
    __SwiftChatNetworkAttachments:{snapshot:()=>[],verify:noop,attachmentTokens:()=>[],didSubmit:noop,configure:noop},
    __SwiftChatNetworkReferences:{resolve:(_text,values)=>resolvedReferences??values,configure:noop,search:noop,invalidate:noop},
    __SwiftChatAppContextTransport:{prependWork:(text,mentions)=>({text,mentions}),arm:()=>null,
      fetch:(fetchPage,receiver,input,init)=>fetchPage.call(receiver,input,init)},
    __SwiftChatNetworkConversation:direct,
    __SwiftChatRuntimeRoots:{revision:1,diagnostics:()=>({revision:1,rootCount:1}),
      subscribe(listener){rootListeners.add(listener);return()=>rootListeners.delete(listener);}},
    fetch:async()=>new Response(null,{status:204}),
    addEventListener:noop,
    webkit:{messageHandlers:{swiftChatConversationAdapterStatus:{postMessage(value){statuses.push(value);}}}}
  };
  const location={hostname:'chatgpt.com',origin:'https://chatgpt.com',pathname:'/'};
  vm.runInNewContext(source,{window,location,URL,Request,Response,crypto:webcrypto,performance,
    queueMicrotask,setTimeout,clearTimeout});
  return{adapter:window.__SwiftChatWebAdapter,calls,direct,envelopes,serializedReferences,statuses,location,
    setContextFailure(value){contextFailure=value;},setDisplayMode(value){displayMode=value;},
    commitRoot(){for(const listener of rootListeners)listener();},
    flush:()=>new Promise(resolve=>queueMicrotask(resolve))};
}

const command={kind:'send',envelope:{text:'Fixture',references:[],attachmentIDs:[],model:'model',effort:'effort'}};

test('a ready matched conversation reports bounded context loss without returning to loading', async () => {
  const f=fixture();f.location.pathname='/c/11111111-1111-4111-8111-111111111111';f.setDisplayMode('matched');
  await f.flush();assert.equal(f.statuses.at(-1).state,'ready');
  f.setContextFailure('website-runtime:composer-owner-unavailable');f.commitRoot();await f.flush();
  const unavailable=f.statuses.at(-1);
  assert.equal(unavailable.state,'context-unavailable');
  assert.equal(unavailable.invariant,'website-runtime:composer-owner-unavailable');
  assert.equal(unavailable.displayMode,'matched');
  assert.equal(unavailable.runtimeRootCount,1);
  assert.equal('conversationMode' in unavailable,false);
  assert.equal('modelContextKey' in unavailable,false);
  assert.equal('attachments' in unavailable,false);
  f.setContextFailure(null);f.commitRoot();await f.flush();
  assert.equal(f.statuses.at(-1).state,'ready');
});

test('context loss before readiness or after a route change remains loading', async () => {
  const initial=fixture();initial.location.pathname='/c/11111111-1111-4111-8111-111111111111';
  initial.setDisplayMode('matched');initial.setContextFailure('website-runtime:committed-root-unavailable');
  await initial.flush();assert.equal(initial.statuses.at(-1).state,'loading');

  const changed=fixture();changed.location.pathname='/c/11111111-1111-4111-8111-111111111111';
  changed.setDisplayMode('matched');await changed.flush();
  changed.location.pathname='/c/22222222-2222-4222-8222-222222222222';
  changed.setContextFailure('website-runtime:composer-owner-unavailable');changed.commitRoot();await changed.flush();
  assert.equal(changed.statuses.at(-1).state,'loading');

  changed.location.pathname='/c/11111111-1111-4111-8111-111111111111';changed.commitRoot();await changed.flush();
  assert.equal(changed.statuses.at(-1).state,'loading');
});

test('ambiguous runtime ownership fails explicitly with the bounded invariant', async () => {
  const f=fixture();f.location.pathname='/c/11111111-1111-4111-8111-111111111111';f.setDisplayMode('matched');
  await f.flush();f.setContextFailure('website-runtime:composer-owner-ambiguous');f.commitRoot();await f.flush();
  assert.equal(f.statuses.at(-1).state,'unsupported');
  assert.equal(f.statuses.at(-1).invariant,'website-runtime:composer-owner-ambiguous');
});

test('a missing recognized website hook selects the authorized direct route before dispatch', async () => {
  const f=fixture('website-runtime:paid-submit-profile-unavailable');
  const result=await f.adapter.perform(command);
  assert.equal(result.route,'direct-network');assert.equal(result.navigationConverged,true);
  assert.deepEqual(f.calls,['website','direct','navigate:/c/11111111-1111-4111-8111-111111111111']);
});

test('an ambiguous website send hook also selects direct transport', async () => {
  const f=fixture('website-runtime:paid-submit-profile-ambiguous');
  assert.equal((await f.adapter.perform(command)).route,'direct-network');
  assert.deepEqual(f.calls,['website','direct','navigate:/c/11111111-1111-4111-8111-111111111111']);
});

test('an existing canonical route does not repeat navigation when React identity is missing', async () => {
  const f=fixture('website-runtime:paid-submit-profile-unavailable');
  f.location.pathname='/c/11111111-1111-4111-8111-111111111111';
  const result=await f.adapter.perform(command);
  assert.equal(result.route,'direct-network');
  assert.equal('navigationConverged' in result,false);
  assert.deepEqual(f.calls,['website','direct']);
});

test('a failed post-acceptance navigation stays accepted and is not retried', async () => {
  const f=fixture('website-runtime:paid-submit-profile-unavailable',null,
    'website-runtime:router-unavailable-or-ambiguous');
  const result=await f.adapter.perform(command);
  assert.equal(result.accepted,true);assert.equal(result.navigationConverged,false);
  assert.equal(result.navigationFailure,'router-unavailable-or-ambiguous');
  assert.deepEqual(f.calls,['website','direct','navigate:/c/11111111-1111-4111-8111-111111111111']);
});

test('post-invocation website failures never fall back and risk a duplicate send', async () => {
  const f=fixture('website-runtime:submit-return-contract-changed');
  await assert.rejects(f.adapter.perform(command),/submit-return-contract-changed/);
  assert.deepEqual(f.calls,['website']);
});

test('Plugin references stay page-local and become exact website system hints', async () => {
  const plugin={kind:'plugin',systemHint:'plugin:private-github',token:'plugin-token',location:0,length:7};
  const file={kind:'file',token:'file-token',location:12,length:5};
  const f=fixture(null,null,null,[plugin,file]);
  const result=await f.adapter.perform({kind:'send',envelope:{text:'@GitHub and @File',
    references:[{candidate:{kind:'plugin'}}],attachmentIDs:[],model:'model',effort:'effort'}});
  assert.equal(result.route,'website-command');
  assert.deepEqual(Array.from(f.envelopes[0].systemHints),['plugin:private-github']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.envelopes[0].references)),[file]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.serializedReferences[0])),[file]);
  assert.deepEqual(f.calls,['website']);
});

test('a Plugin envelope never switches to the text-only direct route', async () => {
  const plugin={kind:'plugin',systemHint:'plugin:private-github',token:'plugin-token',location:0,length:7};
  const f=fixture('website-runtime:paid-submit-profile-unavailable',null,null,[plugin]);
  await assert.rejects(f.adapter.perform({kind:'send',envelope:{text:'@GitHub',
    references:[{candidate:{kind:'plugin'}}],attachmentIDs:[],model:'model',effort:'effort'}}),
    /paid-submit-profile-unavailable/);
  assert.deepEqual(f.calls,['website']);
});

test('exhausted fallback reports both bounded route failures', async () => {
  const f=fixture('website-runtime:paid-submit-profile-unavailable','direct-network:session-template-unavailable');
  await assert.rejects(f.adapter.perform(command),
    /send-routes-unavailable;website=paid-submit-profile-unavailable;direct=session-template-unavailable/);
  assert.deepEqual(f.calls,['website','direct']);
});
