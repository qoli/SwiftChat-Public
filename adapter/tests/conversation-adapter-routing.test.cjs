const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-adapter.user.js'), 'utf8');

function fixture(websiteFailure, directFailure = null, navigationFailure = null) {
  const calls=[];
  const runtime={context:()=>({mode:'chat',conversationID:null,streaming:false}),
    serializeReferences:text=>text,newConversation:async()=>true,setMode:async()=>true,
    async submit(){calls.push('website');throw new Error(websiteFailure);},
    async navigate(path){calls.push(`navigate:${path}`);if(navigationFailure)throw new Error(navigationFailure);return true;},
    stop:()=>true};
  const direct={active:false,observeRequest(){},configure(){},
    async submit(){calls.push('direct');if(directFailure)throw new Error(directFailure);
      return{accepted:true,route:'direct-network',profile:'fixture',conversationID:'11111111-1111-4111-8111-111111111111'};},
    stop:()=>true};
  const noop=()=>{};
  const window={
    __SwiftChatWebsiteRuntime:runtime,
    __SwiftChatConversationDisplay:{apply:()=>({mode:'raw'}),observe:noop,setBottomInset:()=>true},
    __SwiftChatNetworkModels:{contextKey:()=>"catalog",resolve:()=>({model:{slug:'fixture'},systemHints:[]}),catalog:()=>({}),configure:noop},
    __SwiftChatAppShellHistory:{snapshot:()=>({state:'ready',items:[],hasMore:false}),configure:noop,open:noop,loadMore:noop,refresh:noop},
    __SwiftChatNetworkAttachments:{snapshot:()=>[],verify:noop,attachmentTokens:()=>[],didSubmit:noop,configure:noop},
    __SwiftChatNetworkReferences:{resolve:(_text,values)=>values,configure:noop,search:noop,invalidate:noop},
    __SwiftChatAppContextTransport:{prependWork:(text,mentions)=>({text,mentions}),arm:()=>null,
      fetch:(fetchPage,receiver,input,init)=>fetchPage.call(receiver,input,init)},
    __SwiftChatNetworkConversation:direct,
    __SwiftChatRuntimeRoots:{subscribe:noop},
    fetch:async()=>new Response(null,{status:204}),
    addEventListener:noop,
    webkit:{messageHandlers:{}}
  };
  const location={hostname:'chatgpt.com',origin:'https://chatgpt.com',pathname:'/'};
  vm.runInNewContext(source,{window,location,URL,Request,Response,crypto:webcrypto,performance,
    queueMicrotask,setTimeout,clearTimeout});
  return{adapter:window.__SwiftChatWebAdapter,calls,direct};
}

const command={kind:'send',envelope:{text:'Fixture',references:[],attachmentIDs:[],model:'model',effort:'effort'}};

test('a missing five-argument website hook selects the authorized direct route before dispatch', async () => {
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

test('exhausted fallback reports both bounded route failures', async () => {
  const f=fixture('website-runtime:paid-submit-profile-unavailable','direct-network:session-template-unavailable');
  await assert.rejects(f.adapter.perform(command),
    /send-routes-unavailable;website=paid-submit-profile-unavailable;direct=session-template-unavailable/);
  assert.deepEqual(f.calls,['website','direct']);
});
