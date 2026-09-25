const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-app-context-transport.js'), 'utf8');
const start = source.indexOf('\t// A one-shot context lease');
const end = source.indexOf('\tfunction prependWebAppContext', start);
assert.ok(start >= 0 && end > start, 'context transport source boundaries must exist');
const transport = source.slice(start, end);
const origin = 'https://chatgpt.com';
const endpoint = origin + '/backend-api/f/conversation';
const question = 'Explain this fixture';
const context = 'Synthetic source fixture: CLASSIC-7K2P';
function body(overrides = {}) {
  return {action:'next', conversation_id:'conversation-a', conversation_mode:{kind:'primary_assistant'},
    parent_message_id:'parent-a', model:'test-model', client_prepare_state:'preserve-me',
    messages:[{id:'question-a', author:{role:'user'}, content:{content_type:'text', parts:[question]},
      metadata:{attachments:[{id:'attachment-a'}], arbitrary:{nested:true}}}], ...overrides};
}
function fixture() {
  let mode = 'chat';
  let conversationID = 'conversation-a';
  const timers = new Set();
  const calls = [];
  const receiver = {};
  let respond = async () => new Response('data: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}});
  const ctx = vm.createContext({URL, Request, Error, SyntaxError, JSON, Promise, crypto:{randomUUID},
    location:{origin, href:origin+'/c/conversation-a', pathname:'/c/conversation-a'},
    normalizeEditorText: value => value.replace(/\r\n/g, '\n'),
    currentConversationMode: () => mode, activeConversationID: () => conversationID,
    setTimeout: fn => {timers.add(fn); return fn;}, clearTimeout: fn => timers.delete(fn)});
  vm.runInContext(transport, ctx);
  async function pageFetch(input, init) {calls.push({input, init, receiver:this}); return respond(input, init);}
  return {ctx, calls, receiver, timers,
    arm: () => ctx.armAppContext(question, context),
    send: (input = endpoint, init = {method:'POST', body:JSON.stringify(body())}) => ctx.fetchWithAppContext(pageFetch, receiver, input, init),
    setMode: value => mode = value, setConversation: value => conversationID = value,
    respond: fn => respond = fn, expire: () => {for (const fn of [...timers]) fn();}};
}

test('app shell hidden delivery explicitly supplies primary Chat mode only after website confirmation', async () => {
  const f = fixture(); f.ctx.appShellContractActive = true;
  const original = body(); delete original.conversation_mode;
  const lease = f.arm();
  await f.send(endpoint, {method:'POST', body:JSON.stringify(original)});
  await lease.promise;
  assert.equal(JSON.parse(f.calls[0].init.body).conversation_mode.kind, 'primary_assistant');
  assert.equal(JSON.parse(f.calls[0].init.body).messages.length, 2);
  for (const mode of ['work', null]) {
    const g = fixture(); g.ctx.appShellContractActive = true;
    g.arm(); g.setMode(mode);
    await assert.rejects(g.send(endpoint, {method:'POST', body:JSON.stringify(original)}), /request-conversation-mismatch/);
    assert.equal(g.calls.length, 0);
  }
});

test('string send prepends hidden context and preserves question, metadata and fetch options', async () => {
  const f = fixture(), lease = f.arm(), original = body();
  const headers = new Headers({'x-fixture-header':'retained'});
  const signal = new AbortController().signal;
  await f.send(endpoint+'?fixture=1', {method:'POST', body:JSON.stringify(original), headers, credentials:'include', signal});
  assert.equal(await lease.promise, true);
  assert.equal(f.calls.length, 1);
  const sent = f.calls[0];
  assert.equal(sent.input, origin+'/backend-api/conversation?fixture=1');
  assert.equal(sent.receiver, f.receiver);
  assert.equal(sent.init.headers, headers);
  assert.equal(sent.init.signal, signal);
  assert.equal(sent.init.credentials, 'include');
  const payload = JSON.parse(sent.init.body), hidden = payload.messages.shift();
  assert.match(hidden.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(hidden.author, {role:'user'});
  assert.deepEqual(hidden.content, {content_type:'text', parts:[context]});
  assert.deepEqual(hidden.metadata, {is_visually_hidden_from_conversation:true});
  assert.deepEqual(payload, original);
  assert.equal(lease.context, '');
  assert.equal(f.timers.size, 0);
});

test('Request send retains inherited method, headers, credentials and override options', async () => {
  const f = fixture(), lease = f.arm();
  const request = new Request(endpoint, {method:'POST', headers:{'x-fixture-header':'inherited'},
    credentials:'include', cache:'no-store', body:JSON.stringify(body())});
  await f.send(request, {redirect:'error'});
  await lease.promise;
  const sent = f.calls[0];
  assert.ok(sent.input instanceof Request);
  const effective = new Request(sent.input, sent.init);
  assert.equal(effective.url, origin+'/backend-api/conversation');
  assert.equal(effective.method, 'POST');
  assert.equal(effective.headers.get('x-fixture-header'), 'inherited');
  assert.equal(effective.credentials, 'include');
  assert.equal(effective.cache, 'no-store');
  assert.equal(effective.redirect, 'error');
  assert.equal((await effective.json()).messages[0].content.parts[0], context);
  assert.equal(request.bodyUsed, false);
});

test('unrelated fetches preserve exact input and init without consuming the lease', async () => {
  const f = fixture(), lease = f.arm();
  for (const [input, init] of [[origin+'/backend-api/conversation', {method:'GET'}],
    [origin+'/backend-api/conversation/prepare', {method:'POST'}],
    ['https://example.com/backend-api/conversation', {method:'POST'}]]) {
    await f.send(input, init);
    assert.equal(f.calls.at(-1).input, input);
    assert.equal(f.calls.at(-1).init, init);
    assert.equal(lease.claimed, false);
  }
  await f.send(); await lease.promise;
});

test('Work and unknown modes cannot arm a context lease', () => {
  for (const mode of ['work', null, 'future-mode']) {
    const f = fixture(); f.setMode(mode);
    assert.throws(f.arm, /requires-confirmed-chat-mode/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.timers.size, 0);
  }
});

test('draft, conversation and Work request mismatches never reach fetch', async () => {
  const cases = [
    [body({messages:[{author:{role:'user'}, content:{content_type:'text', parts:['different draft']}}]}), /request-draft-mismatch/],
    [body({conversation_id:'different-conversation'}), /request-conversation-mismatch/],
    [body({conversation_origin:'tpp'}), /request-conversation-mismatch/],
    [body({conversation_mode:{kind:'unknown'}}), /request-conversation-mismatch/],
    [body({messages:[]}), /request-draft-mismatch/]
  ];
  for (const [payload, error] of cases) {
    const f = fixture(), lease = f.arm();
    await assert.rejects(f.send(endpoint, {method:'POST', body:JSON.stringify(payload)}), error);
    await assert.rejects(lease.promise, error);
    assert.equal(f.calls.length, 0);
    assert.equal(lease.context, '');
  }
});

test('a completed lease is one-shot and later sends retain the original request', async () => {
  const f = fixture(), lease = f.arm();
  assert.throws(f.arm, /submission-in-flight/);
  await f.send(); await lease.promise;
  const init = {method:'POST', body:JSON.stringify(body())};
  await f.send(endpoint, init);
  assert.equal(f.calls[1].input, endpoint);
  assert.equal(f.calls[1].init, init);
  assert.equal(JSON.parse(f.calls[1].init.body).messages.length, 1);
  assert.equal(f.calls[1].init.body.includes(context), false);
});

test('HTTP errors and non-SSE responses reject submission and clear source text', async () => {
  for (const [response, error] of [
    [new Response('failure', {status:403}), /http-403/],
    [new Response('{}', {headers:{'content-type':'application/json'}}), /unexpected-response-type/]
  ]) {
    const f = fixture(), lease = f.arm(); f.respond(async () => response);
    await assert.rejects(f.send(), error);
    await assert.rejects(lease.promise, error);
    assert.equal(f.calls.length, 1);
    assert.equal(lease.context, '');
    assert.equal(f.timers.size, 0);
  }
});

test('invalid JSON and unsupported body reject before network dispatch', async () => {
  for (const [raw, error] of [['{', /invalid-request-json/], [new URLSearchParams('x=y'), /unsupported-request-body/]]) {
    const f = fixture(), lease = f.arm();
    await assert.rejects(f.send(endpoint, {method:'POST', body:raw}), typeof raw === 'string' ? SyntaxError : error);
    await assert.rejects(lease.promise, error);
    assert.equal(f.calls.length, 0);
  }
});

test('lease timeout blocks late sends and rearming until reload, but leaves unrelated fetches usable', async () => {
  const f = fixture(), lease = f.arm(); f.expire();
  await assert.rejects(lease.promise, /delivery-uncertain-reload-before-sending/);
  assert.equal(lease.context, '');
  await assert.rejects(f.send(), /delivery-uncertain-reload-before-sending/);
  assert.throws(f.arm, /delivery-uncertain-reload-before-sending/);
  assert.equal(f.calls.length, 0);
  await f.send(origin+'/backend-api/models', {method:'GET'});
  assert.equal(f.calls.length, 1);
});

test('timeout during asynchronous Request body reading prevents late network dispatch', async () => {
  const f = fixture(), lease = f.arm();
  const request = new Request(endpoint, {method:'POST', body:JSON.stringify(body())});
  let finishRead;
  request.clone = () => ({text: () => new Promise(resolve => {finishRead = resolve;})});
  const sending = f.send(request, null);
  f.expire();
  finishRead(JSON.stringify(body()));
  await assert.rejects(sending, /submission-expired/);
  await assert.rejects(lease.promise, /delivery-uncertain-reload-before-sending/);
  assert.equal(f.calls.length, 0);
});

test('navigation during asynchronous Request body reading rejects the stale submission', async () => {
  const f = fixture(), lease = f.arm();
  const request = new Request(endpoint, {method:'POST', body:JSON.stringify(body())});
  let finishRead;
  request.clone = () => ({text: () => new Promise(resolve => {finishRead = resolve;})});
  const sending = f.send(request, null);
  f.setConversation('conversation-b');
  f.ctx.location.pathname = '/c/conversation-b';
  finishRead(JSON.stringify(body()));
  await assert.rejects(sending, /conversation-changed/);
  await assert.rejects(lease.promise, /conversation-changed/);
  assert.equal(f.calls.length, 0);
  assert.equal(lease.context, '');
});

test('a duplicate send rejects only itself while the first lease remains pending', async () => {
  const f = fixture(), lease = f.arm();
  let finishResponse;
  f.respond(() => new Promise(resolve => {finishResponse = resolve;}));
  const firstSend = f.send();
  await assert.rejects(f.send(), /duplicate-request/);
  assert.equal(f.calls.length, 1);
  assert.equal(lease.context, context);
  assert.equal(f.timers.size, 1);
  const response = new Response('data: [DONE]\n\n', {headers:{'content-type':'text/event-stream'}});
  finishResponse(response);
  assert.equal(await firstSend, response);
  assert.equal(await lease.promise, true);
  assert.equal(lease.context, '');
  assert.equal(f.timers.size, 0);
});

test('a new Chat permits only home or its temporary WEB route during submission', async () => {
  for (const path of ['/', '/c/WEB:fixture', '/c/existing-other', '/g/other']) {
    const f = fixture(); f.setConversation(null); f.ctx.location.pathname = '/';
    const lease = f.arm(); f.ctx.location.pathname = path;
    const sending = f.send(endpoint, {method:'POST', body:JSON.stringify(body({conversation_id:null}))});
    if (path === '/' || path.startsWith('/c/WEB:')) {
      await sending; await lease.promise;
      assert.equal(f.calls.length, 1);
    } else {
      await assert.rejects(sending, /conversation-changed/);
      await assert.rejects(lease.promise, /conversation-changed/);
      assert.equal(f.calls.length, 0);
    }
  }
});

test('switching home to Work after arming prevents dispatch', async () => {
  const f = fixture(); f.setConversation(null); f.ctx.location.pathname = '/';
  const lease = f.arm(); f.setMode('work');
  await assert.rejects(f.send(endpoint, {method:'POST', body:JSON.stringify(body({conversation_id:null}))}), /requires-confirmed-chat-mode/);
  await assert.rejects(lease.promise, /requires-confirmed-chat-mode/);
  assert.equal(f.calls.length, 0);
});
