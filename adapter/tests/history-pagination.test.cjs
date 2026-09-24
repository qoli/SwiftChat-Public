const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-conversation-adapter.user.js'), 'utf8');
const modes = source.slice(source.indexOf('\tvar conversationModes'), source.indexOf('\tfunction currentConversationMode'));
const history = modes + source.slice(source.indexOf('\tvar CONVERSATION_LIST_PATH'), source.indexOf('\n\tvar observer = null;'));
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
function fixture() {
  const events = new EventTarget();
  const styles = new Map();
  const nav = {scrollTop: 5, scrollHeight: 500, querySelector: () => ({})};
  const sidebar = {querySelectorAll: () => [nav], getAttribute: () => 'display: none',
    setAttribute: (_, value) => {sidebar.restored = value}, removeAttribute: () => {},
    style: {setProperty: (k,v) => styles.set(k,v)}};
  const ctx = vm.createContext({URL, Map, Set, Error, Promise, Number, CustomEvent,
    window: events, location: {origin:'https://chatgpt.com', pathname:`/c/${id(1)}`},
    document:{querySelectorAll:()=>[sidebar]}, getComputedStyle:()=>({overflowY:'auto'}),
    requestAnimationFrame: cb => setImmediate(cb), setTimeout, clearTimeout});
  vm.runInContext(history, ctx);
  const ingest = async (offset, ids, total = 4) => ctx.ingestHistoryResponse({
    url:'https://chatgpt.com/backend-api/conversations?is_archived=false&is_starred=false',
    clone:()=>({json:async()=>({offset, limit:2, total, items:ids.map(n=>({id:id(n),title:`Title ${n}`}))})})
  });
  return {ctx, ingest, sidebar, nav};
}
test('merges contiguous pages, deduplicates IDs, keeps active state and ends at total', async()=>{
  const {ctx,ingest}=fixture();
  await ingest(0,[1,2]);
  assert.equal(ctx.currentHistoryProjection().hasMore,true);
  await ingest(2,[2,3]);
  const p=ctx.currentHistoryProjection();
  assert.equal(p.items.length,3);
  assert.equal(p.items[0].active,true);
  assert.equal(p.hasMore,false);
  assert.equal(await ctx.loadMoreHistory(),false);
});
test('out of order pages wait for gaps; first page refresh drops old pages',async()=>{
  const {ctx,ingest}=fixture();
  await ingest(0,[1,2],6);await ingest(4,[5,6],6);
  assert.equal(ctx.currentHistoryProjection().items.length,2);
  await ingest(2,[3,4],6);
  assert.equal(ctx.currentHistoryProjection().items.length,6);
  await ingest(0,[7,8],2);
  assert.equal(ctx.currentHistoryProjection().items.length,2);
  assert.equal(ctx.currentHistoryProjection().items[0].id,id(7));
});
test('concurrent requests share transport; completion restores hidden sidebar',async()=>{
  const {ctx,ingest,sidebar,nav}=fixture();
  await ingest(0,[1,2]);
  const a=ctx.loadMoreHistory(),b=ctx.loadMoreHistory();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(nav.scrollTop,500);
  await ingest(2,[3,4]);
  assert.deepEqual(await Promise.all([a,b]),[true,true]);
  assert.equal(sidebar.restored,'display: none');assert.equal(nav.scrollTop,5);
});
test('empty page fails without deleting existing history and allows retry',async()=>{
  const {ctx,ingest,sidebar}=fixture();await ingest(0,[1,2]);
  const pending=ctx.loadMoreHistory();
  const rejected=assert.rejects(pending,/empty-page/);
  await ingest(2,[]);await rejected;
  assert.equal(ctx.currentHistoryProjection().items.length,2);
  assert.equal(sidebar.restored,'display: none');
  const retry=ctx.loadMoreHistory();await ingest(2,[3,4]);assert.equal(await retry,true);
});
