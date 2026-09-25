// Metadata-only projection of the app shell's website-owned history requests.
(() => {
  'use strict';
  const streams = new Map();
  const inFlight = new Set();
  const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let onChange = () => {}, requestPage = null, pending = null;
  const fail = code => new Error(`app-shell-history:${code}`);
  function requestScope(value) {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || url.pathname !== '/backend-api/conversations') return null;
    if (url.searchParams.get('is_archived') !== 'false' || url.searchParams.get('is_starred') !== 'false') return null;
    if ([...url.searchParams.keys()].some(key=>!['is_archived','is_starred','exclude_conversation_origin','conversation_origin','expand','hide_snorlax','order','offset','limit'].includes(key))) return null;
    const chat = url.searchParams.get('exclude_conversation_origin') === 'tpp' && !url.searchParams.has('conversation_origin');
    const work = url.searchParams.get('conversation_origin') === 'tpp' && !url.searchParams.has('exclude_conversation_origin');
    if (!chat && !work) return null;
    for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) throw fail('ambiguous-query');
    const entries = [...url.searchParams].filter(([key]) => key !== 'offset' && key !== 'limit').sort(([a], [b]) => a.localeCompare(b));
    return {key: JSON.stringify(entries), mode: chat ? 'chat' : 'work', offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit')};
  }
  function ensureStream(scope) {
    let stream=streams.get(scope.key);
    if (!stream) {stream={mode:scope.mode,pages:new Map(),error:null,generation:0,headPending:false};streams.set(scope.key,stream);}
    return stream;
  }
  function beginRequest(input, init) {
    const method=init?.method ?? (typeof input === 'object' ? input.method : null) ?? 'GET';
    if (String(method).toUpperCase() !== 'GET') return null;
    const value=typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof value !== 'string') return null;
    const scope=requestScope(value); if (!scope) return null;
    const stream=ensureStream(scope), offset=Number(scope.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) throw fail('request-offset-invalid');
    if (offset === 0) {
      stream.generation++;stream.headPending=true;stream.pages.clear();stream.error=null;
      if(pending?.offsets.has(scope.key)) {
        if(pending.kind==='refresh' && !pending.claimedHeads.has(scope.key))pending.claimedHeads.add(scope.key);
        else pending.finish(fail('pagination-context-changed'));
      }
    }
    const token={key:scope.key,generation:stream.generation,offset,
      operation:pending?.offsets.get(scope.key) === offset ? pending : null};
    inFlight.add(token);
    onChange();return token;
  }
  function failedRequest(token, failure = null) {
    if (!token) return;
    inFlight.delete(token);
    const stream=streams.get(token.key);
    if (!stream || stream.generation !== token.generation) return;
    const reason=Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599 ? `website-http-${failure.status}` : failure?.name === 'AbortError' ? 'website-request-aborted' : failure?.kind === 'invalid-json' ? 'website-response-invalid-json' : failure?.kind === 'unexpected-response' ? 'website-response-unexpected' : 'website-request-failed';
    stream.headPending=false;stream.error=fail(reason).message;
    onChange();if(pending && token.operation===pending)pending.finish(fail(reason));
  }
  function parse(payload, scope) {
    if (!payload || !Array.isArray(payload.items)) throw fail('items-invalid');
    for (const key of ['offset', 'limit', 'total']) if (!Number.isSafeInteger(payload[key]) || payload[key] < 0) throw fail('pagination-invalid');
    if (!payload.limit || String(payload.offset) !== scope.offset || String(payload.limit) !== scope.limit || payload.items.length > payload.limit || payload.offset + payload.items.length > payload.total) throw fail('pagination-mismatch');
    const seen = new Set();
    const items = payload.items.map(item => {
      if (!item || typeof item.id !== 'string' || !idPattern.test(item.id)) throw fail('id-invalid');
      const id = item.id.toLowerCase();
      if (seen.has(id)) throw fail('duplicate-id');
      seen.add(id);
      if (typeof item.title !== 'string' || !item.title.trim()) throw fail('title-invalid');
      const mode = item.conversation_origin === null ? 'chat' : item.conversation_origin === 'tpp' ? 'work' : null;
      if (mode !== scope.mode) throw fail('origin-mismatch');
      const updated = item.update_time == null ? null : Date.parse(item.update_time);
      if (updated !== null && !Number.isFinite(updated)) throw fail('updated-time-invalid');
      return {id, title:item.title.trim(), mode, updated};
    });
    if (!items.length && payload.offset < payload.total) throw fail('empty-page');
    return {items, offset:payload.offset, total:payload.total};
  }
  function contiguous(stream) {
    const items = [], seen = new Set(); let offset = 0, total = stream.pages.get(0)?.total ?? null;
    while (stream.pages.has(offset)) {
      const page = stream.pages.get(offset); total = page.total;
      for (const item of page.items) if (!seen.has(item.id)) {seen.add(item.id); items.push(item);}
      if (!page.items.length) break;
      offset += page.items.length;
    }
    return {items, offset, hasMore:total === null || offset < total};
  }
  function snapshot(activeID = null) {
    if (!streams.size || pending?.kind==='refresh') return {state:'loading'};
    const merged = new Map(); let hasMore=false;
    for (const stream of streams.values()) {
      if (stream.headPending) return {state:'loading'};
      if (stream.error) return {state:'unsupported', invariant:stream.error};
      if (!stream.pages.has(0)) continue;
      const page = contiguous(stream);hasMore ||= page.hasMore;
      for (const item of page.items) {
        const old = merged.get(item.id);
        if (old && (old.mode !== item.mode || old.title !== item.title)) return {state:'unsupported', invariant:'app-shell-history:conflicting-stream-item'};
        merged.set(item.id,item);
      }
    }
    if (![...streams.values()].some(s=>s.pages.has(0))) return {state:'loading'};
    const active = typeof activeID === 'string' ? activeID.toLowerCase() : null;
    const items = [...merged.values()].sort((a,b)=>a.updated !== null && b.updated !== null ? b.updated-a.updated : 0).map(({id,title})=>({id,title,path:`/c/${id}`,active:id===active}));
    return {state:'ready',items,activeConversationID:items.some(i=>i.active)?active:null,hasMore};
  }
  function ingest(responseURL,payload,token = null) {
    const scope = requestScope(responseURL); if (!scope) return false;
    const stream=ensureStream(scope);
    if(token)inFlight.delete(token);
    if (token && (token.key !== scope.key || token.generation !== stream.generation || String(token.offset) !== scope.offset)) return false;
    try {
      const page = parse(payload,scope);
      if (!token && page.offset === 0 && stream.pages.has(0)) stream.pages.clear();
      stream.pages.set(page.offset,page); stream.error=null;
      if(page.offset === 0)stream.headPending=false;
      onChange();
      if (pending && token?.operation===pending && pending.offsets.get(scope.key)===page.offset) {
        const progress=contiguous(stream);
        if(progress.offset > page.offset || !progress.hasMore) {
          pending.completed.add(scope.key);
          pending.checkCompletion();
        }
      }
      return true;
    } catch(error) {stream.headPending=false;stream.error=error.message;onChange();if(pending && token?.operation===pending)pending.finish(error);return true;}
  }
  function modeForID(id) {
    const normalized = typeof id === 'string' ? id.toLowerCase() : '';
    const modes = new Set([...streams.values()].flatMap(s=>contiguous(s).items).filter(i=>i.id===normalized).map(i=>i.mode));
    return modes.size === 1 ? [...modes][0] : null;
  }
  async function open(id) {
    const state=snapshot(); const item=state.items?.find(i=>i.id===id?.toLowerCase());
    if (state.state !== 'ready' || !item) return false;
    await window.__SwiftChatWebsiteRuntime.navigate(item.path);
    return true;
  }
  function loadMore() {
    if (pending) return pending.promise;
    const state=snapshot(); if (state.state !== 'ready') return Promise.reject(fail('not-ready'));
    if (!state.hasMore) return Promise.resolve(false);
    const offsets=new Map([...streams].flatMap(([key,stream])=>{
      const page=contiguous(stream);return stream.pages.has(0) && page.hasMore ? [[key,page.offset]] : [];
    }));
    const existing=[...inFlight].filter(token=>token.offset > 0 && offsets.get(token.key)===token.offset && streams.get(token.key)?.generation===token.generation);
    return requestPages(offsets,'pagination',existing);
  }
  function refresh() {
    if(pending?.kind==='refresh')return pending.promise;
    if(typeof requestPage!=='function' || !streams.size)return Promise.reject(fail('transport-unavailable'));
    pending?.finish(fail('pagination-context-changed'));
    return requestPages(new Map([...streams.keys()].map(key=>[key,0])),'refresh',[]);
  }
  function requestPages(offsets,kind,existing) {
    const joinedKeys=new Set(existing.map(token=>token.key));
    if(typeof requestPage!=='function' && [...offsets.keys()].some(key=>!joinedKeys.has(key))) return Promise.reject(fail('transport-unavailable'));
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const operation={promise,offsets,kind,claimedHeads:new Set(),completed:new Set(),dispatching:true,
      finish(error){
        if(pending!==operation)return;
        clearTimeout(timer);pending=null;if(kind==='refresh')onChange();error?reject(error):resolve(true);
      },
      checkCompletion(){
        if(!operation.dispatching && [...offsets.keys()].every(key=>operation.completed.has(key)))operation.finish();
      }};
    const timer=setTimeout(()=>operation.finish(fail('response-timeout')),15000);
    pending=operation;
    for(const token of existing)token.operation=operation;
    const transportFailed=error=>{
      const code=['transport-unavailable','request-template-unavailable','request-context-changed'].includes(error?.code) ? error.code : 'website-pagination-failed';
      operation.finish(fail(code));
    };
    // One explicitly requested page per unfinished stream. The injected page
    // transport preserves the website request and emits begin/ingest callbacks.
    // A returned HTTP response alone never acknowledges metadata projection.
    for(const [key,offset] of offsets) {
      if(pending!==operation)break;
      if(joinedKeys.has(key))continue;
      try {Promise.resolve(requestPage(key,offset)).catch(transportFailed);}
      catch(error){transportFailed(error);}
    }
    operation.dispatching=false;
    operation.checkCompletion();
    return promise;
  }
  window.__SwiftChatAppShellHistory={configure(options){onChange=options.onChange??(()=>{});if(Object.hasOwn(options,'requestPage'))requestPage=options.requestPage;},beginRequest,failedRequest,ingest,snapshot,modeForID,open,loadMore,refresh};
})();
