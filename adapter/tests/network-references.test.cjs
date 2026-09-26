const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const source = fs.readFileSync(
  require('node:path').join(__dirname, '../chatgpt-network-references.js'), 'utf8');
const pluginCapabilitiesURL =
  'https://chatgpt.com/backend-api/system_hints?exclude_logo=false&mode=plugins&suggestions=true';

function fixture(links = [], pluginHints = []) {
  const calls = [];
  const window = {};
  const context = vm.createContext({window, crypto: webcrypto, structuredClone,
    Request, Response, Headers, URL, AbortController, Error,
    location: {origin: 'https://chatgpt.com'}});
  vm.runInContext(source, context);
  const api = window.__SwiftChatNetworkReferences;
  api.configure({request: async request => {
    const path = new URL(request.url).pathname;
    const text = await request.clone().text();
    const body = text ? JSON.parse(text) : null;
    calls.push({request, body, path});
    if (path.endsWith('/system_hints')) {
      return new Response(JSON.stringify({system_hints: pluginHints}), {status: 200,
        headers: {'content-type': 'application/json'}});
    }
    if (path.endsWith('/aip/connectors/links/list_accessible')) {
      return new Response(JSON.stringify({links}), {status: 200,
        headers: {'content-type': 'application/json'}});
    }
    const items = body.cursor ? [] : [
      {id: 'remote-file-result', source_type: 'library', title: 'Fixture File', snippet: null,
        payload: {kind: 'library_file', library_item_id: 'remote-library-file',
          file_id: 'remote-file', file_name: 'Fixture File', mime_type: 'text/plain',
          library_artifact_type: null, file_extension: 'txt', file_size_bytes: 7,
          state: 'ready'}},
      {id: 'remote-folder-result', source_type: 'library', title: 'Fixture Folder', snippet: 'Root',
        payload: {kind: 'library_folder', is_root: false,
          directory_id: 'native-folder', external_account: null}}
    ];
    return new Response(JSON.stringify({items, partial_results: false,
      cursor: body.cursor ? null : 'remote-cursor', source_statuses: [
        {status: 'ok', provider_statuses: [{status: 'ok'}]}
      ]}), {status: 200, headers: {'content-type': 'application/json'}});
  }});
  return {api, calls};
}

async function authorize(api, account = 'account-a', authorization = 'private-authorization',
                         url = 'https://chatgpt.com/backend-api/models') {
  await api.ingestRequest(new Request(url, {
    headers: {authorization, 'chatgpt-account-id': account,
      originator: 'web'}
  }));
}

function ingestPlugins(api, system_hints) {
  return api.ingestCapabilities({system_hints}, pluginCapabilitiesURL);
}

test('search reuses page authorization while projecting only document-local selections', async () => {
  const f = fixture();
  await authorize(f.api);
  const page = await f.api.search('fixture', null);
  const search = f.calls.find(call => call.body?.query === 'fixture');
  assert.equal(page.items.length, 2);
  assert.ok(page.nextCursor);
  assert.equal(search.request.headers.get('authorization'), 'private-authorization');
  assert.deepEqual(Array.from(search.body.source_requests[0].filters.lanes),
    ['image', 'document', 'folder']);
  assert.deepEqual(Array.from(search.body.source_requests[0].filters.library_providers),
    ['native']);
  const bridged = JSON.stringify(page);
  for (const privateValue of ['private-authorization', 'remote-library-file',
    'remote-file-result', 'native-folder', 'remote-cursor']) {
    assert.equal(bridged.includes(privateValue), false);
  }
  const file = page.items.find(item => item.kind === 'file');
  const folder = page.items.find(item => item.kind === 'folder');
  assert.equal(file.title, 'Fixture File');
  assert.equal(folder.title, 'Fixture Folder');
  const text = `Use @${file.title} and @${folder.title}`;
  const fileStart = text.indexOf('@Fixture File');
  const folderStart = text.indexOf('@Fixture Folder');
  const resolved = f.api.resolve(text, [
    {location: fileStart, length: '@Fixture File'.length, candidate: file},
    {location: folderStart, length: '@Fixture Folder'.length, candidate: folder}
  ]);
  assert.equal(resolved[0].kind, 'file');
  assert.equal(resolved[0].attrs.libraryFileId, 'remote-library-file');
  assert.equal(resolved[1].kind, 'folder');
  assert.equal(resolved[1].attrs.path,
    `chatgpt-library-folder://${encodeURIComponent('native-folder')}/`);
});

test('observing a Request never consumes the website transport body', async () => {
  const f=fixture(), request=new Request('https://chatgpt.com/backend-api/f/conversation', {
    method:'POST',headers:{authorization:'Bearer fixture','chatgpt-account-id':'account'},
    body:JSON.stringify({messages:[]})
  });
  await f.api.ingestRequest(request);
  assert.equal(request.bodyUsed,false);
  assert.deepEqual(JSON.parse(await request.text()),{messages:[]});
});

test('pagination keeps the query identity and remote cursor inside the page module', async () => {
  const f = fixture();
  await authorize(f.api);
  const first = await f.api.search('fixture', null);
  const second = await f.api.search('fixture', first.nextCursor);
  const searches = f.calls.filter(call => call.body?.query === 'fixture');
  assert.deepEqual(JSON.parse(JSON.stringify(second)), {items: [], nextCursor: null});
  assert.equal(searches[1].body.cursor, 'remote-cursor');
  assert.equal(searches[1].body.query_id, searches[0].body.query_id);
});

test('connected Plugins are local opaque candidates for empty and matching queries', async () => {
  const f = fixture([], [
    {name: 'GitHub', short_label: 'GitHub', system_hint: 'plugin:private-github',
      is_plugin: true, is_connected: true, can_connect: false,
      hide_from_initial_selection: false, aliases: [], keyword_invocations: null},
    {name: 'Slack', short_label: 'Slack', system_hint: 'plugin:private-slack',
      is_plugin: true, is_connected: false, can_connect: true,
      hide_from_initial_selection: false, aliases: [], keyword_invocations: null}
  ]);
  await authorize(f.api);
  const empty = await f.api.search('', null);
  assert.equal(f.calls.filter(call => call.path.endsWith('/system_hints')).length, 1);
  assert.equal(f.calls.some(call => call.path.endsWith('/global/search')), false);
  assert.deepEqual(JSON.parse(JSON.stringify(empty.items.map(item => [item.title, item.kind]))),
    [['GitHub', 'plugin']]);
  assert.equal(JSON.stringify(empty).includes('plugin:private-github'), false);

  const page = await f.api.search('git', null);
  assert.equal(page.items.some(item => item.kind === 'plugin' && item.title === 'GitHub'), true);
  assert.equal(page.items.some(item => item.kind === 'file'), true);
  assert.equal(page.items.some(item => item.kind === 'folder'), true);
  const candidate = page.items.find(item => item.kind === 'plugin');
  const roundTripped = {kind: candidate.kind, title: candidate.title, id: candidate.id,
    payload: {selectionKey: candidate.payload.selectionKey,
      documentID: candidate.payload.documentID}, subtitle: candidate.subtitle};
  const resolved = f.api.resolve(`@${candidate.title}`, [
    {location: 0, length: candidate.title.length + 1, candidate: roundTripped}
  ]);
  assert.equal(resolved[0].kind, 'plugin');
  assert.equal(resolved[0].systemHint, 'plugin:private-github');
  assert.equal(resolved[0].token, candidate.id);
  assert.equal(resolved[0].location, 0);
  assert.equal(resolved[0].length, candidate.title.length + 1);
});

test('a Plugin selection fails closed after account or capability context changes', async () => {
  const f = fixture();
  await authorize(f.api, 'account-a');
  ingestPlugins(f.api, [{name: 'GitHub', short_label: 'GitHub',
    system_hint: 'plugin:private-github', is_plugin: true, is_connected: true,
    can_connect: false, hide_from_initial_selection: false, aliases: [], keyword_invocations: null}]);
  const candidate = (await f.api.search('', null)).items[0];
  await authorize(f.api, 'account-b', 'private-authorization', pluginCapabilitiesURL);
  assert.throws(() => f.api.resolve('@GitHub', [
    {location: 0, length: 7, candidate}
  ]), /selection-stale/);

  ingestPlugins(f.api, [{name: 'GitHub', short_label: 'GitHub',
    system_hint: 'plugin:private-github', is_plugin: true, is_connected: true,
    can_connect: false, hide_from_initial_selection: false, aliases: [], keyword_invocations: null}]);
  const second = (await f.api.search('', null)).items[0];
  ingestPlugins(f.api, [{name: 'GitHub', short_label: 'GitHub',
    system_hint: 'plugin:private-github', is_plugin: true, is_connected: false,
    can_connect: true, hide_from_initial_selection: false, aliases: [], keyword_invocations: null}]);
  assert.throws(() => f.api.resolve('@GitHub', [
    {location: 0, length: 7, candidate: second}
  ]), /selection-stale/);
});

test('reduced Plugin responses and catalog ordering cannot stale an unchanged selection', async () => {
  const f = fixture();
  await authorize(f.api);
  const github = {name: 'GitHub', short_label: 'GitHub',
    system_hint: 'plugin:private-github', is_plugin: true, is_connected: true,
    can_connect: false, hide_from_initial_selection: false, aliases: [], keyword_invocations: null};
  const notion = {name: 'Notion', short_label: 'Notion',
    system_hint: 'plugin:private-notion', is_plugin: true, is_connected: true,
    can_connect: false, hide_from_initial_selection: false, aliases: [], keyword_invocations: null};
  ingestPlugins(f.api, [github, notion]);
  const candidate = (await f.api.search('', null)).items.find(item => item.title === 'GitHub');
  await authorize(f.api, 'account-a', 'rotated-private-authorization');
  assert.equal(f.api.resolve('@GitHub', [
    {location: 0, length: 7, candidate}
  ])[0].systemHint, 'plugin:private-github');
  await authorize(f.api, 'background-account', 'background-authorization');
  assert.equal(f.api.resolve('@GitHub', [
    {location: 0, length: 7, candidate}
  ])[0].systemHint, 'plugin:private-github');
  f.api.ingestCapabilities({system_hints: [{name: 'Visualize', short_label: 'Visualize',
    system_hint: 'plugin:visualize', is_plugin: true, is_connected: true,
    can_connect: false, hide_from_initial_selection: false, aliases: [], keyword_invocations: null}]},
  'https://chatgpt.com/backend-api/system_hints?exclude_logo=true&mode=plugins');
  ingestPlugins(f.api, [notion, github]);
  assert.equal(f.api.resolve('@GitHub', [
    {location: 0, length: 7, candidate}
  ])[0].systemHint, 'plugin:private-github');
});

test('connected capability projection extends the provider request without exposing account state', async () => {
  const f = fixture();
  await authorize(f.api);
  assert.equal(f.api.ingestCapabilities({system_hints: [
    {system_hint: 'plugin:google_drive', name: 'Drive', short_label: 'Drive', is_connected: true},
    {system_hint: 'plugin:dropbox', name: 'Dropbox', short_label: 'Dropbox', is_connected: false}
  ]}), true);
  await f.api.search('fixture', null);
  const search = f.calls.find(call => call.body?.query === 'fixture');
  assert.deepEqual(Array.from(search.body.source_requests[0].filters.library_providers),
    ['native', 'google_drive']);
});

test('page-local connector discovery adds only active library providers', async () => {
  const f = fixture([
    {connector_id: 'connector-drive', connector_name: 'Google Drive', name: 'Drive',
      connector_status: 'ENABLED', auth_status: 'ACTIVE'},
    {connector_id: 'connector-dropbox', connector_name: 'Dropbox', name: 'Dropbox',
      connector_status: 'ENABLED', auth_status: 'REVOKED'}
  ]);
  await authorize(f.api);
  await f.api.search('fixture', null);
  const search = f.calls.find(call => call.body?.query === 'fixture');
  assert.deepEqual(Array.from(search.body.source_requests[0].filters.library_providers),
    ['native', 'google_drive']);
});

test('account change invalidates selections and cursors explicitly', async () => {
  const f = fixture();
  await authorize(f.api, 'account-a');
  const page = await f.api.search('fixture', null);
  const candidate = page.items[0];
  await authorize(f.api, 'account-b', 'private-authorization', pluginCapabilitiesURL);
  assert.throws(() => f.api.resolve(`@${candidate.title}`, [
    {location: 0, length: candidate.title.length + 1, candidate}
  ]), /selection-stale/);
  await assert.rejects(f.api.search('fixture', page.nextCursor), /cursor-stale/);
});

test('empty query stays local and malformed library response state fails closed', async () => {
  const f = fixture();
  await authorize(f.api);
  assert.deepEqual(JSON.parse(JSON.stringify(await f.api.search('', null))),
    {items: [], nextCursor: null});
  assert.equal(f.calls.some(call => call.path.endsWith('/global/search')), false);
  f.api.configure({request: async request => {
    if (new URL(request.url).pathname.endsWith('/system_hints')) {
      return new Response(JSON.stringify({system_hints: []}), {status: 200});
    }
    if (new URL(request.url).pathname.endsWith('/aip/connectors/links/list_accessible')) {
      return new Response(JSON.stringify({links: []}), {status: 200});
    }
    return new Response(JSON.stringify({items: [],
      partial_results: true, cursor: null, source_statuses: []}), {status: 200});
  }});
  await assert.rejects(f.api.search('fixture', null), /search-unavailable/);
});
