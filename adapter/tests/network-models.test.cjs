const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../chatgpt-network-models.js'), 'utf8');

function fixture() {
  const window = {}, changes = [];
  vm.runInNewContext(source, { window });
  const api = window.__SwiftChatNetworkModels;
  api.configure({ onChange: mode => changes.push(mode) });
  return { api, changes };
}
function data() {
  return {
    default_model_slug: 'fixture-model',
    categories: [],
    models: [{ slug: 'fixture-model', title: 'Fixture', default_thinking_effort: 'standard',
      thinking_efforts: [{ thinking_effort: 'min' }, { thinking_effort: 'standard' }] }],
    versions: [{ id: 'fixture-version', enabled: true, display_text_for_intelligence: 'Fixture version',
      slugs: ['fixture-model'], intelligence_presets: [
        { id: 0, title: 'Light', model_slug: 'fixture-model', lane: 'thinking', thinking_effort: 'min', preset_type: 'available' },
        { id: 1, title: 'Medium', model_slug: 'fixture-model', lane: 'thinking', thinking_effort: 'standard', preset_type: 'available' }
      ] }]
  };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('catalog projects models once and keeps reasoning efforts nested', () => {
  const {api}=fixture(), catalog=api.ingest('chat',data());
  assert.equal(Object.hasOwn(catalog,'selectedModelID'),false);
  assert.equal(catalog.models.length,1);
  assert.equal(catalog.models[0].label,'Fixture version');
  assert.equal(Object.hasOwn(catalog.models[0],'defaultEffortID'),false);
  assert.deepEqual(plain(catalog.models[0].efforts.map(value=>value.label)),['Light','Medium']);
});

test('only an explicit app-owned model and effort pair resolves a website envelope', () => {
  const {api}=fixture(), catalog=api.ingest('work',data());
  assert.deepEqual(plain(api.resolve('work',catalog.models[0].id,catalog.models[0].efforts[1].id)),{
    model:{slug:'fixture-model',versionId:'fixture-version',thinkingEffort:'standard'},systemHints:[]
  });
  assert.throws(()=>api.resolve('work','fixture-version','missing'),/selection-unavailable/);
  assert.throws(()=>api.resolve('work','missing',catalog.models[0].efforts[0].id),/selection-unavailable/);
});

test('server defaults never become native selection status', () => {
  const {api}=fixture(), body=data();
  body.default_model_slug='fixture-auto-alias';
  body.models.push({slug:'fixture-auto-alias',title:'Fixture Auto'});
  body.categories.push({default_model:'fixture-auto-alias',supported_models:['fixture-auto-alias']});
  const catalog=api.ingest('chat',body);
  assert.equal(Object.hasOwn(catalog,'selectedModelID'),false);
  assert.equal(Object.hasOwn(catalog.models[0],'defaultEffortID'),false);
});

test('multiple versions remain model rows instead of a model-effort cross product', () => {
  const {api}=fixture(), body=data();
  body.models.push({slug:'other-model',title:'Other',thinking_efforts:[{thinking_effort:'low'},{thinking_effort:'high'}]});
  body.versions.push({id:'other-version',enabled:true,display_text_for_intelligence:'Other version',slugs:['other-model'],
    intelligence_presets:[
      {title:'Low',model_slug:'other-model',lane:'thinking',thinking_effort:'low',preset_type:'available'},
      {title:'High',model_slug:'other-model',lane:'thinking',thinking_effort:'high',preset_type:'available'}
    ]});
  const catalog=api.ingest('chat',body);
  assert.deepEqual(plain(catalog.models.map(model=>model.label)),['Fixture version','Other version']);
  assert.deepEqual(plain(catalog.models.map(model=>model.efforts.length)),[2,2]);
});

test('disabled versions and unavailable presets are excluded', () => {
  const {api}=fixture(), body=data();
  body.versions.push({enabled:false});
  body.versions[0].intelligence_presets.push({preset_type:'upgrade'});
  assert.equal(api.ingest('chat',body).models.length,1);
  assert.equal(api.catalog('chat').models[0].efforts.length,2);
});

test('Chat and Work catalogs are independent and returned values are copies', () => {
  const {api,changes}=fixture(), body=data(), original=JSON.stringify(body);
  api.ingest('chat',body);api.ingest('work',body);
  const catalog=api.catalog('chat');catalog.models[0].efforts[0].label='tampered';
  assert.equal(api.catalog('chat').models[0].efforts[0].label,'Light');
  assert.equal(api.catalog('work').models[0].efforts[0].label,'Light');
  assert.equal(JSON.stringify(body),original);assert.deepEqual(changes,['chat','work']);
});

test('category-declared aliases resolve config while undeclared aliases fail explicitly', () => {
  const {api}=fixture(), body=data();
  body.versions[0].slugs=['alias'];body.versions[0].intelligence_presets.forEach(value=>{value.model_slug='alias';});
  assert.throws(()=>api.ingest('chat',body),/model-config-unavailable/);
  body.categories=[{default_model:'fixture-model',supported_models:['alias']}];
  const catalog=api.ingest('chat',body);
  assert.equal(api.resolve('chat',catalog.models[0].id,catalog.models[0].efforts[0].id).model.slug,'alias');
});

test('invalid refresh removes stale readiness and reset clears both modes', () => {
  const {api}=fixture(), body=data();
  api.ingest('chat',body);api.ingest('work',data());
  body.versions[0].intelligence_presets[0].thinking_effort='invented';
  assert.throws(()=>api.ingest('chat',body),/effort-contract-changed/);
  assert.throws(()=>api.catalog('chat'),/catalog-not-ready/);
  assert.equal(api.catalog('work').models.length,1);
  api.reset();assert.throws(()=>api.catalog('work'),/catalog-not-ready/);
});

test('Auto-only Free catalogs are rejected for the separately versioned Free adapter', () => {
  const {api}=fixture();
  const body={default_model_slug:'auto',models:[{slug:'auto',title:'Auto',enabled_tools:['reason']}],versions:[],categories:[]};
  assert.throws(()=>api.ingest('chat',body),/free-adapter-required/);
  assert.throws(()=>api.ingest('work',body),/catalog-empty/);
});

test('duplicate versions and presets fail instead of inventing identity', () => {
  const {api}=fixture(), body=data();
  body.versions.push(structuredClone(body.versions[0]));
  assert.throws(()=>api.ingest('chat',body),/version-schema-changed/);
  body.versions.pop();body.versions[0].intelligence_presets.push(structuredClone(body.versions[0].intelligence_presets[0]));
  assert.throws(()=>api.ingest('chat',body),/duplicate-preset/);
});

test('GPT-6 Pro in Latest preserves its null preset effort even with a standard model default', () => {
  const {api}=fixture(), body=data();
  body.models.push({slug:'gpt-6-pro',title:'GPT-6 Pro',default_thinking_effort:'standard',
    thinking_efforts:[{thinking_effort:'standard'}]});
  body.versions.push({id:'latest',enabled:true,display_text_for_intelligence:'Latest',slugs:['gpt-6-pro'],
    intelligence_presets:[{title:'Pro',model_slug:'gpt-6-pro',lane:'pro',preset_type:'available'}]});
  const catalog=api.ingest('chat',body), latest=catalog.models.find(model=>model.id==='latest');
  assert.equal(latest.efforts[0].id,'["gpt-6-pro",null,"pro"]');
  assert.deepEqual(plain(api.resolve('chat','latest',latest.efforts[0].id)), {
    model:{slug:'gpt-6-pro',versionId:'latest',thinkingEffort:null},systemHints:[]
  });
  assert.throws(()=>api.resolve('chat','latest','0'),/selection-unavailable/);
});
