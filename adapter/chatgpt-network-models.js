// Pure paid-plan projections of the two website model HTTP response bodies.
// Native owns the selected model and effort; this module only validates catalogs
// and resolves an explicit native selection into the website model envelope.
(() => {
  'use strict';
  const states = new Map();
  let onChange = () => {};
  const fail = code => { throw Error(`network-models:${code}`); };
  const text = value => typeof value === 'string' && value.length > 0;
  const modeCheck = mode => { if (!['chat', 'work'].includes(mode)) fail('invalid-mode'); };
  const copy = value => JSON.parse(JSON.stringify(value));
  const optionID = option => JSON.stringify([option.slug, option.thinkingEffort, option.lane]);

  function parse(mode, data) {
    if (!data || !Array.isArray(data.models)) fail('catalog-schema-changed');
    const configs = new Map();
    for (const model of data.models) {
      if (!text(model.slug) || !text(model.title) || configs.has(model.slug)) fail('model-schema-changed');
      configs.set(model.slug, model);
    }
    const categories = data.categories ?? [];
    if (!Array.isArray(categories)) fail('category-schema-changed');
    function config(slug) {
      if (configs.has(slug)) return configs.get(slug);
      // Only an explicit server category relation can resolve a model alias.
      const aliases = categories.filter(category => Array.isArray(category.supported_models)
        && category.supported_models.includes(slug) && configs.has(category.default_model));
      const targets = new Set(aliases.map(category => category.default_model));
      if (targets.size !== 1) fail('model-config-unavailable');
      return configs.get([...targets][0]);
    }
    const auto = mode === 'chat' && configs.get('auto');
    if (auto && data.default_model_slug === 'auto' && (!data.versions || data.versions.length === 0)) {
      fail('free-adapter-required');
    }
    if (!Array.isArray(data.versions)) fail('versions-unavailable');
    const versions = [], ids = new Set();
    for (const version of data.versions) {
      if (version.enabled === false) continue;
      if (version.enabled !== true || !text(version.id) || ids.has(version.id)
        || !Array.isArray(version.slugs) || !Array.isArray(version.intelligence_presets)) fail('version-schema-changed');
      ids.add(version.id);
      const label = version.display_text_for_intelligence ?? version.display_text_full ?? version.display_text;
      if (!text(label)) fail('version-label-unavailable');
      const options = [];
      for (const preset of version.intelligence_presets) {
        if (preset.preset_type !== 'available') continue;
        if (!text(preset.model_slug) || !version.slugs.includes(preset.model_slug) || !text(preset.title)
          || !text(preset.lane) || (preset.thinking_effort != null && !text(preset.thinking_effort))) fail('preset-schema-changed');
        const model = config(preset.model_slug);
        if (model.enabled === false) continue;
        const effort = preset.thinking_effort ?? null;
        if (effort !== null && (!Array.isArray(model.thinking_efforts)
          || !model.thinking_efforts.some(item => item.thinking_effort === effort))) fail('effort-contract-changed');
        const option = { slug: preset.model_slug, title: preset.title,
          thinkingEffort: effort, lane: preset.lane };
        option.id = optionID(option);
        if (options.some(item => item.id === option.id)) fail('duplicate-preset');
        options.push(option);
      }
      if (options.length) versions.push({ id: version.id, label, options });
    }
    if (!versions.length) fail('catalog-empty');
    return { versions };
  }

  function state(mode) {
    modeCheck(mode);
    const value = states.get(mode);
    if (!value) fail('catalog-not-ready');
    return value;
  }
  function ingest(mode, payload) {
    modeCheck(mode);
    let value;
    try { value = parse(mode, payload); }
    catch (error) { states.delete(mode); onChange(mode); throw error; }
    states.set(mode, value);
    onChange(mode);
    return catalog(mode);
  }
  function catalog(mode) {
    const value = state(mode);
    const models = value.versions.map(version => ({
      id: version.id,
      label: version.label,
      selectionKind: 'intelligencePreset',
      efforts: version.options.map(option => ({ id: option.id, label: option.title }))
    }));
    return { mode, workUnavailable: false, models };
  }
  function resolve(mode, versionID, effortID) {
    const value = state(mode), version = value.versions.find(item => item.id === versionID);
    const option = version?.options.find(item => item.id === effortID);
    if (!version || !option) fail('selection-unavailable');
    return { model: { slug: option.slug, versionId: version.id, thinkingEffort: option.thinkingEffort }, systemHints: [] };
  }
  function contextKey(mode) {
    const value = state(mode);
    return JSON.stringify(value.versions.map(version => [version.id, version.options.map(option => option.id)]));
  }

  window.__SwiftChatNetworkModels = {
    configure(options = {}) { onChange = options.onChange ?? (() => {}); },
    reset() { states.clear(); onChange(null); },
    ingest,
    catalog: mode => copy(catalog(mode)),
    resolve: (mode, versionID, effortID) => copy(resolve(mode, versionID, effortID)),
    contextKey
  };
})();
