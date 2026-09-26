// Account-scoped ChatGPT library search and opaque reference projection.
// Authorization and remote identity stay in the page; native callers receive
// only display metadata plus a document-local selection token.
(() => {
  "use strict";
  const documentID = crypto.randomUUID();
  const selections = new Map();
  const cursors = new Map();
  const defaultSource = {
    type: "library",
    filters: {lanes: ["image", "document", "folder"], library_providers: ["native"]}
  };
  let request = null, onChange = () => {}, session = null, sessionFingerprint = null;
  let source = structuredClone(defaultSource), generation = 0, pending = null;
  let capabilityFingerprint = null, capabilityPromise = null;

  const fail = code => { throw new Error(`network-references:${code}`); };
  const nonempty = value => typeof value === "string" && value.length > 0;
  const safeStrings = values => Array.isArray(values) && values.length > 0 && values.every(nonempty);
  const endpoint = "/backend-api/global/search";

  function resetScope() {
    generation += 1;
    pending?.abort();
    pending = null;
    selections.clear();
    cursors.clear();
    source = structuredClone(defaultSource);
    capabilityFingerprint = null;
    capabilityPromise = null;
  }

  function requestValue(input) {
    try { return input instanceof Request ? input.clone() : new Request(input); }
    catch { return null; }
  }

  function mergeObservedSource(candidate) {
    if (candidate?.type !== "library") return;
    const lanes = candidate.filters?.lanes;
    const providers = candidate.filters?.library_providers;
    if (!safeStrings(lanes) || !safeStrings(providers)) return;
    source = {
      type: "library",
      filters: {
        lanes: [...new Set([...source.filters.lanes, ...lanes])],
        library_providers: [...new Set([...source.filters.library_providers, ...providers])]
      }
    };
  }

  function ingestCapabilities(payload) {
    if (!Array.isArray(payload?.system_hints)) return false;
    const providers = new Set(source.filters.library_providers);
    const known = ["google_drive", "dropbox", "box", "onedrive", "sharepoint"];
    for (const hint of payload.system_hints) {
      if (hint?.is_connected !== true) continue;
      const identity = [hint.system_hint, hint.name, hint.short_label]
        .filter(value => typeof value === "string").join(" ").toLowerCase();
      for (const provider of known) {
        const aliases = provider === "google_drive" ? ["google_drive", "google drive", "gdrive"]
          : [provider];
        if (aliases.some(alias => identity.includes(alias))) providers.add(provider);
      }
    }
    source = {...source, filters: {...source.filters,
      library_providers: [...providers]}};
    onChange();
    return true;
  }

  function providerFromConnector(link) {
    if (link?.auth_status !== "ACTIVE" || !["ENABLED", "ONLY_ME"].includes(link.connector_status)) return null;
    const identity = [link.connector_id, link.connector_name, link.name, link.template_id]
      .filter(value => typeof value === "string").join(" ").toLowerCase();
    if (/google[ _-]*drive|\bgdrive\b/.test(identity)) return "google_drive";
    if (/dropbox/.test(identity)) return "dropbox";
    if (/one[ _-]*drive/.test(identity)) return "onedrive";
    if (/share[ _-]*point/.test(identity)) return "sharepoint";
    if (/(^|[^a-z])box([^a-z]|$)/.test(identity)) return "box";
    return null;
  }

  async function loadCapabilities() {
    if (!sessionFingerprint || capabilityFingerprint === sessionFingerprint) return;
    if (capabilityPromise) return capabilityPromise;
    const fingerprint = sessionFingerprint;
    capabilityPromise = (async () => {
      try {
        if (typeof request !== "function") fail("transport-unavailable");
        const headers = new Headers(session.headers);
        headers.set("content-type", "application/json");
        const response = await request(new Request(
          new URL("/backend-api/aip/connectors/links/list_accessible", location.origin), {
            method: "POST", headers, credentials: session.credentials, mode: session.mode,
            cache: session.cache, redirect: session.redirect, referrer: session.referrer,
            referrerPolicy: session.referrerPolicy,
            body: JSON.stringify({principals: [], link_refresh_strategy: "BLOCKING"})
          }));
        if (sessionFingerprint !== fingerprint) fail("capability-superseded");
        if (!response.ok) fail(`capability-http-${response.status}`);
        let body;
        try { body = await response.json(); }
        catch { fail("capability-response-invalid-json"); }
        if (!Array.isArray(body?.links)) fail("capability-response-changed");
        const providers = new Set(source.filters.library_providers);
        for (const link of body.links) {
          const provider = providerFromConnector(link);
          if (provider) providers.add(provider);
        }
        source = {...source, filters: {...source.filters,
          library_providers: [...providers]}};
        capabilityFingerprint = fingerprint;
        onChange();
      } catch (error) {
        if (error?.message?.startsWith("network-references:")) throw error;
        fail("capability-request-failed");
      }
      finally {
        capabilityPromise = null;
      }
    })();
    return capabilityPromise;
  }

  async function ingestRequest(input, init) {
    let observed;
    try { observed = input instanceof Request ? new Request(input.clone(), init) : new Request(input, init); }
    catch { return false; }
    let url;
    try { url = new URL(observed.url, location.origin); }
    catch { return false; }
    if (url.origin !== location.origin || !url.pathname.startsWith("/backend-api/")) return false;
    const authorization = observed.headers.get("authorization");
    const account = observed.headers.get("chatgpt-account-id");
    if (!nonempty(authorization) || !nonempty(account)) return false;
    const fingerprint = `${authorization}\u0000${account}`;
    if (sessionFingerprint !== null && sessionFingerprint !== fingerprint) resetScope();
    sessionFingerprint = fingerprint;
    session = {
      headers: new Headers(observed.headers),
      credentials: observed.credentials,
      mode: observed.mode,
      cache: observed.cache,
      redirect: observed.redirect,
      referrer: observed.referrer,
      referrerPolicy: observed.referrerPolicy
    };
    if (url.pathname !== endpoint || observed.method.toUpperCase() !== "POST") return true;
    try {
      const body = JSON.parse(await observed.clone().text());
      if (body?.entrypoint === "composer" && Array.isArray(body.source_requests)) {
        for (const candidate of body.source_requests) mergeObservedSource(candidate);
      }
    } catch { /* A changed website request cannot corrupt the last verified source profile. */ }
    return true;
  }

  function pageRequest(body, signal) {
    if (!session || typeof request !== "function") fail("authenticated-session-unavailable");
    const headers = new Headers(session.headers);
    headers.set("content-type", "application/json");
    return request(new Request(new URL(endpoint, location.origin), {
      method: "POST",
      headers,
      credentials: session.credentials,
      mode: session.mode,
      cache: session.cache,
      redirect: session.redirect,
      referrer: session.referrer,
      referrerPolicy: session.referrerPolicy,
      signal,
      body: JSON.stringify(body)
    }));
  }

  function providerFor(value) {
    if (!nonempty(value)) return "";
    if (value.startsWith("external-gdrive:")) return "google_drive";
    if (value.startsWith("external-dropbox:")) return "dropbox";
    if (value.startsWith("external-box:")) return "box";
    if (value.startsWith("external-onedrive:")) return "onedrive";
    if (value.startsWith("external-sharepoint:")) return "sharepoint";
    return "";
  }

  function projectFile(item) {
    const payload = item?.payload;
    if (item?.source_type !== "library" || payload?.kind !== "library_file"
      || !nonempty(payload.library_item_id) || !nonempty(payload.file_name)
      || !nonempty(payload.file_id) || !nonempty(payload.mime_type)) fail("file-schema-changed");
    const id = payload.library_item_id;
    const provider = payload.library_provider ?? payload.provider ?? providerFor(id);
    let fileID = payload.file_id;
    if (provider === "native_shared") fileID = "";
    else if (providerFor(id)) fileID = id;
    const file = {...payload, id, file_id: fileID, sourceLocation: null};
    return {
      kind: "file",
      title: payload.file_name.trim(),
      subtitle: typeof provider === "string" ? provider : "",
      runtime: {
        kind: "file",
        file,
        attrs: {
          entrypoint: "at_mention",
          fileId: fileID,
          libraryArtifactType: typeof payload.library_artifact_type === "string" ? payload.library_artifact_type : "",
          libraryFileId: id,
          mimeType: payload.mime_type,
          title: payload.file_name.trim()
        }
      }
    };
  }

  function projectFolder(item) {
    const payload = item?.payload;
    if (item?.source_type !== "library" || payload?.kind !== "library_folder"
      || payload.is_root !== false || !nonempty(payload.directory_id)
      || !nonempty(item.title)) fail("folder-schema-changed");
    let directoryID = payload.directory_id;
    if (directoryID.startsWith("external-gdrive:")
      && !directoryID.startsWith("external-gdrive:account:")
      && payload.external_account != null) {
      if (!nonempty(payload.external_account.key)) fail("folder-account-changed");
      directoryID = `external-gdrive:account:${payload.external_account.key}:${directoryID.slice(16)}`;
    }
    const provider = providerFor(directoryID);
    if (["sharepoint", "onedrive"].includes(provider)) return null;
    const title = item.title.trim();
    if (!title) fail("folder-title-invalid");
    const displayPath = `/${[...(typeof item.snippet === "string" ? item.snippet.split(" / ") : []), title].join("/")}`;
    const path = `chatgpt-library-folder://${encodeURIComponent(directoryID)}/`;
    return {kind: "folder", title, subtitle: provider, runtime: {
      kind: "folder", directoryID, attrs: {path, fsPath: path, label: displayPath}
    }};
  }

  function saveCandidate(projected) {
    if (!projected) return null;
    const selectionKey = crypto.randomUUID();
    const candidate = {
      id: selectionKey,
      title: projected.title,
      subtitle: projected.subtitle,
      kind: projected.kind,
      payload: {documentID, selectionKey}
    };
    selections.set(selectionKey, {candidate, runtime: {...projected.runtime, token: selectionKey}});
    return candidate;
  }

  function verifyResponse(body) {
    if (!Array.isArray(body?.items) || typeof body.partial_results !== "boolean"
      || !Array.isArray(body.source_statuses)
      || body.source_statuses.some(value => !nonempty(value?.status)
        || value.provider_statuses != null && !Array.isArray(value.provider_statuses))) {
      fail("search-response-changed");
    }
    const available = body.source_statuses.some(value => value.status === "ok"
      || value.provider_statuses?.some(provider => provider?.status === "ok"));
    if (!available && body.items.length === 0) fail("search-unavailable");
    if (body.cursor !== null && !nonempty(body.cursor)) fail("cursor-invalid");
  }

  async function search(rawQuery, cursor = null) {
    if (typeof rawQuery !== "string") fail("invalid-query");
    const query = rawQuery.trim();
    if (!query) return {items: [], nextCursor: null};
    if (!sessionFingerprint) fail("authenticated-session-unavailable");
    await loadCapabilities();
    let remoteCursor = null, queryID = crypto.randomUUID(), activeSource = structuredClone(source);
    if (cursor !== null) {
      if (!nonempty(cursor)) fail("cursor-invalid");
      const saved = cursors.get(cursor);
      if (!saved || saved.query !== query || saved.sessionFingerprint !== sessionFingerprint) fail("cursor-stale");
      remoteCursor = saved.remoteCursor;
      queryID = saved.queryID;
      activeSource = structuredClone(saved.source);
    }
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const active = ++generation, fingerprint = sessionFingerprint;
    try {
      const response = await pageRequest({
        cursor: remoteCursor,
        entrypoint: "composer",
        limit: 20,
        query,
        query_id: queryID,
        source_requests: [activeSource]
      }, controller.signal);
      if (generation !== active || sessionFingerprint !== fingerprint) fail("search-superseded");
      if (!response.ok) fail(`search-http-${response.status}`);
      let body;
      try { body = await response.json(); }
      catch { fail("search-response-invalid-json"); }
      verifyResponse(body);
      const seen = new Set(), items = [];
      for (const item of body.items) {
        const remoteKey = `${item?.source_type ?? ""}:${item?.id ?? ""}`;
        if (!nonempty(item?.id) || seen.has(remoteKey)) fail("candidate-ambiguous");
        seen.add(remoteKey);
        const projected = item.payload?.kind === "library_file" ? projectFile(item)
          : item.payload?.kind === "library_folder" ? projectFolder(item) : null;
        const candidate = saveCandidate(projected);
        if (candidate) items.push(candidate);
      }
      let nextCursor = null;
      if (body.cursor !== null) {
        nextCursor = crypto.randomUUID();
        cursors.set(nextCursor, {query, queryID, remoteCursor: body.cursor,
          sessionFingerprint: fingerprint, source: activeSource});
      }
      onChange();
      return {items, nextCursor};
    } catch (error) {
      if (generation !== active || sessionFingerprint !== fingerprint) fail("search-superseded");
      if (error?.message?.startsWith("network-references:")) throw error;
      fail(error?.name === "AbortError" ? "search-aborted" : "search-failed");
    } finally {
      if (pending === controller) pending = null;
    }
  }

  function resolve(text, mentions) {
    if (typeof text !== "string" || !Array.isArray(mentions)) fail("invalid-draft");
    const runtime = [];
    let end = 0;
    for (const mention of mentions) {
      const start = mention?.location, length = mention?.length, candidate = mention?.candidate;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)
        || start < end || length <= 0 || start + length > text.length) fail("invalid-range");
      const key = candidate?.payload?.documentID === documentID ? candidate.payload.selectionKey : null;
      const saved = nonempty(key) ? selections.get(key) : null;
      if (!saved || JSON.stringify(candidate) !== JSON.stringify(saved.candidate)) fail("selection-stale");
      if (text.slice(start, start + length) !== `@${saved.candidate.title}`) fail("selection-text-mismatch");
      runtime.push({...saved.runtime, location: start, length});
      end = start + length;
    }
    return runtime;
  }

  function invalidate() {
    resetScope();
    onChange();
    return true;
  }

  window.__SwiftChatNetworkReferences = Object.freeze({
    configure(options) {
      if (Object.hasOwn(options, "request")) request = options.request;
      if (Object.hasOwn(options, "onChange")) onChange = options.onChange ?? (() => {});
    },
    ingestRequest, ingestCapabilities, search, resolve, invalidate,
    capabilities: Object.freeze({file: true, folder: true})
  });
})();
