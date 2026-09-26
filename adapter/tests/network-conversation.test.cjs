const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-network-conversation.js'), 'utf8');

const origin = 'https://chatgpt.com';
const conversationID = '11111111-1111-4111-8111-111111111111';
const btoa = value => Buffer.from(value, 'binary').toString('base64');
const atob = value => Buffer.from(value, 'base64').toString('binary');
const xor = (value, key) => {
  let output = '';
  for (let index = 0; index < value.length; index++) {
    output += String.fromCharCode(value.charCodeAt(index) ^ key.charCodeAt(index % key.length));
  }
  return output;
};

function fixture(pathname = '/') {
  const calls = [];
  let uuid = 0, now = 0;
  const location = {origin, pathname, search: ''};
  const request = async input => {
    const value = input instanceof Request ? input : new Request(input);
    const url = new URL(value.url);
    const body = value.method === 'GET' ? null : JSON.parse(await value.clone().text());
    calls.push({path:url.pathname, method:value.method, headers:Object.fromEntries(value.headers), body});
    if (url.pathname === '/backend-api/sentinel/chat-requirements/prepare') {
      const instructions = [[3, 'ok']];
      return Response.json({prepare_token:'prepare-token', proofofwork:{required:true,seed:'fixture',difficulty:'ffffffff'},
        turnstile:{required:true,dx:btoa(xor(JSON.stringify(instructions),body.p))}});
    }
    if (url.pathname === '/backend-api/sentinel/chat-requirements/finalize') {
      assert.match(body.proofofwork, /^gAAAAAB/);
      assert.equal(body.turnstile, btoa('ok'));
      return Response.json({token:'requirements-token'});
    }
    if (url.pathname.startsWith('/backend-api/conversations/')) {
      return Response.json({conversation_id:conversationID,current_node:'parent-message'});
    }
    if (url.pathname === '/backend-api/f/conversation') {
      const id = body.conversation_id ?? conversationID;
      return new Response(`data: ${JSON.stringify({type:'message_stream_complete',conversation_id:id})}\n\ndata: [DONE]\n\n`,
        {status:200,headers:{'content-type':'text/event-stream'}});
    }
    if (url.pathname === '/backend-api/stop_conversation') return Response.json({status:'ok'});
    throw new Error(`unexpected ${url.pathname}`);
  };
  const window = {fetch:request};
  const context = vm.createContext({
    window, location, Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, Intl, Date, setTimeout, clearTimeout, btoa, atob,
    crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`},
    navigator:{userAgent:'Fixture',language:'en',languages:['en'],hardwareConcurrency:8},
    screen:{width:1000,height:800},
    performance:{now:()=>++now,timeOrigin:1,memory:{jsHeapSizeLimit:1},
      getEntriesByType:()=>[{name:`${origin}/fixture.js`}]},
    Math
  });
  vm.runInContext(source, context);
  const api = window.__SwiftChatNetworkConversation;
  api.configure({request});
  api.observeRequest(new Request(`${origin}/backend-api/models`, {headers:{
    authorization:'Bearer fixture', 'chatgpt-account-id':'fixture-account', 'oai-did':'fixture-device',
    'x-openai-web-frontend':'fixture-build'
  }}));
  return {api,calls,location,request};
}

function envelope(overrides = {}) {
  return {text:'Fixture',serializedText:'Fixture',mode:'chat',conversationID:null,
    model:{slug:'fixture-model',versionId:'fixture-version',thinkingEffort:'high'},
    systemHints:[],references:[],attachmentTokens:[],...overrides};
}

test('unavailable website command can publish a text envelope through the authenticated direct route', async () => {
  const f=fixture();
  const result=await f.api.submit(envelope({mode:'work'}));
  assert.equal(result.accepted,true);assert.equal(result.route,'direct-network');
  assert.equal(result.profile,'direct-network-text-v1');assert.equal(result.conversationID,conversationID);
  const sent=f.calls.find(call=>call.path==='/backend-api/f/conversation');
  assert.equal(sent.headers.authorization,'Bearer fixture');
  assert.equal(sent.headers['openai-sentinel-chat-requirements-token'],'requirements-token');
  assert.match(sent.headers['openai-sentinel-proof-token'],/^gAAAAAB/);
  assert.equal(sent.headers['openai-sentinel-turnstile-token'],btoa('ok'));
  assert.equal(sent.body.conversation_origin,'tpp');assert.equal(sent.body.thinking_effort,'high');
  assert.equal(sent.body.messages[0].content.parts[0],'Fixture');
  assert.deepEqual(sent.body.supported_encodings,['v1']);
});

test('existing conversation direct sends refetch the current parent before dispatch', async () => {
  const f=fixture(`/c/${conversationID}`);
  const result=await f.api.submit(envelope({conversationID}));
  assert.equal(result.conversationID,conversationID);
  const detail=f.calls.find(call=>call.path.startsWith('/backend-api/conversations/'));
  const sent=f.calls.find(call=>call.path==='/backend-api/f/conversation');
  assert.ok(detail);assert.equal(sent.body.parent_message_id,'parent-message');
  assert.equal(sent.body.conversation_id,conversationID);
});

test('direct fallback refuses attachments and references instead of silently dropping them', async () => {
  const f=fixture();
  await assert.rejects(f.api.submit(envelope({attachmentTokens:['attachment']})),/direct-network:text-envelope-required/);
  await assert.rejects(f.api.submit(envelope({references:[{token:'reference'}]})),/direct-network:text-envelope-required/);
  assert.equal(f.calls.length,0);
});

test('an accepted response without a terminal stream blocks automatic resend as uncertain delivery', async () => {
  const f=fixture(), original=f.api;
  original.configure({request:async input=>{
    const value=input instanceof Request?input:new Request(input), url=new URL(value.url);
    if(url.pathname==='/backend-api/f/conversation') return new Response('not an event stream',{status:200});
    const recorded=f.calls;
    const body=value.method==='GET'?null:JSON.parse(await value.clone().text());
    recorded.push({path:url.pathname,method:value.method,headers:Object.fromEntries(value.headers),body});
    if(url.pathname.endsWith('/prepare')) return Response.json({prepare_token:'prepare',proofofwork:{required:false},turnstile:{required:false}});
    if(url.pathname.endsWith('/finalize')) return Response.json({token:'token'});
    throw new Error(`unexpected ${url.pathname}`);
  }});
  await assert.rejects(original.submit(envelope()),/direct-network:delivery-uncertain-reload-before-sending/);
  await assert.rejects(original.submit(envelope()),/direct-network:delivery-uncertain-reload-before-sending/);
});

test('a new direct generation adopts its streamed identity before stop', async () => {
  const f=fixture();
  f.api.configure({request:async input=>{
    const value=input instanceof Request?input:new Request(input), url=new URL(value.url);
    if(url.pathname!=='/backend-api/f/conversation') return f.request(input);
    const stream=new ReadableStream({start(controller){
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({type:'message_stream',conversation_id:conversationID})}\n\n`));
      value.signal.addEventListener('abort',()=>controller.error(
        Object.assign(new Error('stopped'),{name:'AbortError'})));
    }});
    return new Response(stream,{status:200,headers:{'content-type':'text/event-stream'}});
  }});
  const submission=f.api.submit(envelope());
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(await f.api.stop(),true);
  const result=await submission;
  assert.equal(result.accepted,true);assert.equal(result.stopped,true);
  assert.equal(result.conversationID,conversationID);
  const stop=f.calls.find(call=>call.path==='/backend-api/stop_conversation');
  assert.equal(stop.body.conversation_id,conversationID);
});
