// Composes network projections, versioned website commands and the Display adapter
// behind one semantic command interface for the native shell.
(() => {
  "use strict";
  if (location.hostname !== "chatgpt.com" && !location.hostname.endsWith(".chatgpt.com")) return;

  const ADAPTER_VERSION = "3.7.0";
  const documentID = crypto.randomUUID();
  const runtime = window.__SwiftChatWebsiteRuntime;
  const display = window.__SwiftChatConversationDisplay;
  const models = window.__SwiftChatNetworkModels;
  const historyProjection = window.__SwiftChatAppShellHistory;
  const attachments = window.__SwiftChatNetworkAttachments;
  const referencesProjection = window.__SwiftChatNetworkReferences;
  const contextTransport = window.__SwiftChatAppContextTransport;
  const directConversation = window.__SwiftChatNetworkConversation;
  const freeAdapter = window.__SwiftChatFreeAdapter;
  const roots = window.__SwiftChatRuntimeRoots;
  const pageFetch = window.fetch;
  const requestTemplates = new Map();
  let lastState = "", lastHistory = "", scheduled = false, submitting = false;
  let catalogFailure = null, generation = false, activeRoute = null;
  let observedPath = location.pathname, matchedAvailablePath = null;

  const post = (name, payload) => window.webkit?.messageHandlers?.[name]?.postMessage(payload);
  const fail = code => { throw new Error(`native-adapter:${code}`); };
  const activeConversationID = () => location.pathname.match(/^\/c\/([0-9a-f-]+)$/i)?.[1]?.toLowerCase() ?? null;
  const safeRun = run => { try { Promise.resolve(run()).catch(() => {}); } catch {} };
  const websiteRouteUnavailable = new Set([
    "website-runtime:paid-submit-profile-unavailable",
    "website-runtime:paid-submit-profile-ambiguous"
  ]);
  const freeWebsiteRouteUnavailable = new Set([
    "website-runtime:free-composer-owner-unavailable",
    "website-runtime:free-composer-owner-ambiguous",
    "website-runtime:free-conversation-identity-ambiguous",
    "website-runtime:free-system-hint-state-ambiguous",
    "website-runtime:free-system-hint-state-unavailable",
    "website-runtime:free-submission-context-mismatch",
    "website-runtime:free-submit-profile-unavailable",
    "website-runtime:free-submit-profile-ambiguous",
    "website-runtime:free-hint-removal-profile-unavailable-or-ambiguous",
    "website-runtime:free-hint-removal-failed",
    "website-runtime:free-hint-removal-not-confirmed"
  ]);
  const recoverableContextFailures = new Set([
    "website-runtime:committed-root-unavailable",
    "website-runtime:composer-owner-unavailable"
  ]);
  const recoverableFreeFailures = new Set([
    "free-adapter:catalog-not-ready"
  ]);
  const boundedFailure = (error, prefix) => {
    const message = typeof error?.message === "string" ? error.message : "";
    return new RegExp(`^${prefix}:[a-z0-9-]+$`).test(message) ? message.slice(prefix.length + 1) : "unknown";
  };
  const boundedFreeFallbackFailure = error => {
    const message = typeof error?.message === "string" ? error.message : "";
    return message.startsWith("direct-network:")
      ? boundedFailure(error, "direct-network") : boundedFailure(error, "free-adapter");
  };

  function endpoint(input) {
    try {
      const value = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      const url = new URL(value, location.origin);
      if (url.origin !== location.origin) return null;
      if (url.pathname === "/backend-api/models") return "chat-models";
      if (url.pathname === "/backend-api/tpp/models" || url.pathname === "/backend-api/tpp/models/") return "work-models";
      if (url.pathname.startsWith("/backend-api/accounts/check/")) return "account";
      if (url.pathname === "/backend-api/conversations") return "history";
      if (url.pathname === "/backend-api/system_hints") return "reference-capabilities";
      if (/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return "conversation";
      return null;
    } catch { return null; }
  }
  function cloneRequest(input, init) {
    try {
      return input instanceof Request ? new Request(input, init) : new Request(input, init);
    } catch { return null; }
  }
  function historyScope(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname !== "/backend-api/conversations") return null;
      const chat = url.searchParams.get("exclude_conversation_origin") === "tpp" && !url.searchParams.has("conversation_origin");
      const work = url.searchParams.get("conversation_origin") === "tpp" && !url.searchParams.has("exclude_conversation_origin");
      if (!chat && !work) return null;
      const entries = [...url.searchParams].filter(([key]) => key !== "offset" && key !== "limit")
        .sort(([left], [right]) => left.localeCompare(right));
      return JSON.stringify(entries);
    } catch { return null; }
  }
  async function requestHistoryPage(key, offset) {
    const template = requestTemplates.get(key);
    if (!template) fail("history-request-template-unavailable");
    const url = new URL(template.url);
    url.searchParams.set("offset", String(offset));
    const request = new Request(url, {
      method: template.method,
      headers: template.headers,
      credentials: template.credentials,
      mode: template.mode,
      cache: template.cache,
      redirect: template.redirect,
      referrer: template.referrer,
      referrerPolicy: template.referrerPolicy,
      integrity: template.integrity,
      keepalive: template.keepalive
    });
    return window.fetch(request);
  }
  function ingestResponse(kind, response, historyToken) {
    if (!response.ok) {
      if (historyToken) historyProjection.failedRequest(historyToken, {status: response.status});
      return;
    }
    if (!["account", "chat-models", "work-models", "history", "reference-capabilities"].includes(kind)) return;
    safeRun(async () => {
      let payload;
      try { payload = await response.clone().json(); }
      catch {
        if (historyToken) historyProjection.failedRequest(historyToken, {kind: "invalid-json"});
        return;
      }
      if (kind === "account") {
        freeAdapter?.ingest("account", payload);
      } else if (kind === "chat-models" || kind === "work-models") {
        if (kind === "chat-models") freeAdapter?.ingest("models", payload);
        try {
          models.ingest(kind === "chat-models" ? "chat" : "work", payload);
          catalogFailure = null;
        } catch (error) {
          const message = typeof error?.message === "string" && /^network-models:[a-z0-9-]+$/.test(error.message)
            ? error.message : "network-models:catalog-schema-changed";
          catalogFailure = message;
        }
      } else if (kind === "reference-capabilities") {
        referencesProjection.ingestCapabilities(payload, response.url);
      } else if (kind === "history") {
        historyProjection.ingest(response.url, payload, historyToken);
      }
      schedule();
    });
  }

  window.fetch = async function(input, init) {
    const kind = endpoint(input);
    safeRun(() => directConversation.observeRequest(input, init));
    safeRun(() => referencesProjection.ingestRequest(input, init));
    let historyToken = null;
    let template = null;
    if (kind === "history") {
      try {
        historyToken = historyProjection.beginRequest(input, init);
        template = cloneRequest(input, init);
      } catch {}
    }
    const fetchPage = async function(actualInput, actualInit) {
      const response = await pageFetch.call(this, actualInput, actualInit);
      if (historyToken && template) {
        const key = historyScope(template);
        if (key) requestTemplates.set(key, template);
      }
      ingestResponse(kind, response, historyToken);
      if (kind === "conversation" && response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
        generation = true;
        schedule();
        safeRun(async () => {
          try {
            const reader = response.clone().body.getReader();
            while (!(await reader.read()).done) {}
          } finally { generation = false; activeRoute = null; schedule(); }
        });
      }
      return response;
    };
    try { return await contextTransport.fetch(fetchPage, this, input, init); }
    catch (error) {
      if (historyToken) historyProjection.failedRequest(historyToken, error);
      throw error;
    }
  };

  function currentContext() {
    if (freeAdapter?.selected === true) {
      try { return {value: freeAdapter.context(), invariant: null, adapterKind: "free"}; }
      catch (error) {
        return {value: null, invariant: `free-adapter:${boundedFailure(error, "free-adapter")}`,
          adapterKind: "free"};
      }
    }
    try { return {value: runtime.context(), invariant: null, adapterKind: "paid"}; }
    catch (error) {
      return {value: null, invariant: `website-runtime:${boundedFailure(error, "website-runtime")}`,
        adapterKind: "paid"};
    }
  }
  function modelCatalogContext(mode, adapterKind) {
    try { return adapterKind === "free" ? freeAdapter.contextKey() : models.contextKey(mode); }
    catch { return null; }
  }
  function runtimeDiagnostics() {
    try {
      const value = roots?.diagnostics?.();
      return Number.isInteger(value?.revision) && value.revision >= 0
        && Number.isInteger(value?.rootCount) && value.rootCount >= 0 ? value : null;
    } catch { return null; }
  }
  function reportHistory() {
    const payload = {...historyProjection.snapshot(activeConversationID()), adapterVersion: ADAPTER_VERSION};
    const serialized = JSON.stringify(payload);
    if (serialized !== lastHistory) {
      lastHistory = serialized;
      post("swiftChatConversationAdapterHistory", payload);
    }
  }
  function reportCurrentState(force = false) {
    if (observedPath !== location.pathname) {
      observedPath = location.pathname;
      matchedAvailablePath = null;
    }
    const observedContext = currentContext();
    const context = observedContext.value;
    const catalogContext = context ? modelCatalogContext(context.mode, observedContext.adapterKind) : null;
    const view = display.apply();
    let state;
    if (context && catalogContext) {
      state = generation || context.streaming ? "generating" : submitting ? "sending" : "ready";
      if (view.mode === "matched") matchedAvailablePath = location.pathname;
    } else if (!context && observedContext.adapterKind === "paid"
      && recoverableContextFailures.has(observedContext.invariant)
      && matchedAvailablePath === location.pathname && view.mode === "matched") {
      state = "context-unavailable";
    } else if (!context && observedContext.adapterKind === "free"
      && recoverableFreeFailures.has(observedContext.invariant)) {
      state = "loading";
    } else if (!context && !recoverableContextFailures.has(observedContext.invariant)) {
      state = "unsupported";
    } else {
      state = "loading";
    }
    const invariant = context ? (!catalogContext ? (catalogFailure ?? "network-models:catalog-not-ready") : undefined)
      : observedContext.invariant;
    const rootDiagnostic = runtimeDiagnostics();
    const payload = {
      state,
      documentID,
      adapterVersion: ADAPTER_VERSION,
      displayMode: view.mode,
      adapterKind: observedContext.adapterKind,
      freeAccountState: freeAdapter?.accountState ?? "unavailable",
      conversationPath: location.pathname,
      ...(context ? {conversationMode: context.mode,
        attachments: observedContext.adapterKind === "free" ? [] : attachments.snapshot()} : {}),
      ...(context && catalogContext
        ? {modelContextKey: JSON.stringify([context.mode, context.conversationID, catalogContext])} : {}),
      ...(rootDiagnostic ? {runtimeRevision: rootDiagnostic.revision,
        runtimeRootCount: rootDiagnostic.rootCount} : {}),
      ...(invariant ? {invariant} : {})
    };
    const serialized = JSON.stringify(payload);
    if (force || serialized !== lastState) {
      lastState = serialized;
      post("swiftChatConversationAdapterStatus", payload);
    }
    reportHistory();
    return payload;
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; reportCurrentState(); });
  }
  function operation(name, run) {
    const operationID = crypto.randomUUID(), started = performance.now();
    const report = outcome => post("swiftChatConversationAdapterStatus", {
      state: "operation-diagnostic", documentID, adapterVersion: ADAPTER_VERSION,
      operationDiagnostic: {operationID, operation: name, stage: "operation", outcome,
        elapsedMS: Math.round(performance.now() - started)}
    });
    report("begin");
    return Promise.resolve().then(run).then(value => { report("end"); return value; }, error => {
      report("failed"); throw error;
    }).finally(schedule);
  }
  async function submitNativeDraft(payload) {
    if (submitting) fail("submission-in-flight");
    const usingFreeAdapter = freeAdapter?.selected === true;
    if (!payload || typeof payload.text !== "string" || !Array.isArray(payload.references)
      || !Array.isArray(payload.attachmentIDs) || typeof payload.model !== "string"
      || (usingFreeAdapter ? typeof payload.thinking !== "boolean" : typeof payload.effort !== "string")) {
      fail("invalid-submission-envelope");
    }
    const context = usingFreeAdapter ? freeAdapter.context() : runtime.context();
    const selection = usingFreeAdapter
      ? freeAdapter.resolve(context.mode, payload.model, payload.thinking)
      : models.resolve(context.mode, payload.model, payload.effort);
    let text = payload.text, references = payload.references;
    let contextLease = null;
    if (payload.appContext) {
      if (context.mode === "work") ({text, mentions: references} = contextTransport.prependWork(text, references, payload.appContext));
      else if (context.mode !== "chat") fail("conversation-mode-unavailable");
    }
    const resolvedReferences = referencesProjection.resolve(text, references);
    const libraryReferences = [], pluginSystemHints = [];
    for (const reference of resolvedReferences) {
      if (reference?.kind === "plugin") {
        if (typeof reference.systemHint !== "string" || !reference.systemHint) fail("plugin-reference-invalid");
        pluginSystemHints.push(reference.systemHint);
      } else if (reference?.kind === "file" || reference?.kind === "folder") {
        libraryReferences.push(reference);
      } else fail("reference-kind-unavailable");
    }
    const systemHints = [];
    for (const hint of [...selection.systemHints, ...pluginSystemHints]) {
      if (typeof hint !== "string" || !hint) fail("system-hint-invalid");
      if (!systemHints.includes(hint)) systemHints.push(hint);
    }
    if (usingFreeAdapter && (libraryReferences.length || payload.attachmentIDs.length)) {
      fail("free-capability-unavailable");
    }
    const serializedText = usingFreeAdapter ? text : runtime.serializeReferences(text, libraryReferences);
    if (payload.appContext && context.mode === "chat") {
      contextLease = contextTransport.arm(serializedText, payload.appContext);
    }
    if (!usingFreeAdapter) attachments.verify(payload.attachmentIDs);
    const attachmentTokens = usingFreeAdapter ? [] : attachments.attachmentTokens(payload.attachmentIDs);
    submitting = true;
    schedule();
    try {
      const envelope = {text, serializedText, references: libraryReferences, attachmentTokens,
        model: selection.model, systemHints, mode: context.mode, conversationID: context.conversationID};
      let result;
      if (usingFreeAdapter) {
        try {
          result = await runtime.submitFree(envelope);
        } catch (websiteError) {
          if (!freeWebsiteRouteUnavailable.has(websiteError?.message)) throw websiteError;
          activeRoute = "free-direct-network";
          try {
            result = {...await freeAdapter.submit(envelope),
              websiteFailure: boundedFailure(websiteError, "website-runtime")};
          } catch (directError) {
            if (!directConversation.active) activeRoute = null;
            throw new Error(`native-adapter:send-routes-unavailable;website=${boundedFailure(websiteError, "website-runtime")};direct=${boundedFreeFallbackFailure(directError)}`);
          }
        }
      } else {
        try {
          result = await runtime.submit(envelope);
        } catch (websiteError) {
          const directEligible = !envelope.systemHints.length && !envelope.references.length
            && !envelope.attachmentTokens.length;
          if (!websiteRouteUnavailable.has(websiteError?.message) || !directEligible) throw websiteError;
          activeRoute = "direct-network";
          try {
            result = await directConversation.submit(envelope);
          } catch (directError) {
            if (!directConversation.active) activeRoute = null;
            throw new Error(`native-adapter:send-routes-unavailable;website=${boundedFailure(websiteError, "website-runtime")};direct=${boundedFailure(directError, "direct-network")}`);
          }
        }
      }
      if (result.route === "direct-network" && activeConversationID() === null
        && typeof result.conversationID === "string") {
        try {
          await runtime.navigate(`/c/${result.conversationID}`);
          result = {...result, navigationConverged: true};
        } catch (error) {
          // The server has already accepted the turn. Report navigation separately
          // instead of turning a confirmed send into a retryable failure.
          result = {...result, navigationConverged: false,
            navigationFailure: boundedFailure(error, "website-runtime")};
        }
      }
      activeRoute = ["direct-network", "free-direct-network"].includes(result.route) ? null : result.route;
      if (contextLease) await contextLease.promise;
      if (!usingFreeAdapter) attachments.didSubmit(payload.attachmentIDs);
      return result;
    } catch (error) {
      contextLease?.finish(error);
      throw error;
    } finally { submitting = false; schedule(); }
  }
  async function perform(command) {
    if (!command || typeof command.kind !== "string") fail("invalid-command");
    switch (command.kind) {
    case "reportSnapshot": return reportCurrentState(true);
    case "startConversation": return operation("conversation.mode", () => freeAdapter?.selected === true
      ? freeAdapter.newConversation(command.mode) : runtime.newConversation(command.mode));
    case "setMode": return operation("conversation.mode", () => freeAdapter?.selected === true
      ? freeAdapter.setMode(command.mode) : runtime.setMode(command.mode));
    case "catalog": return operation("conversation.catalog", () => freeAdapter?.selected === true
      ? freeAdapter.catalog(command.mode) : models.catalog(command.mode));
    case "setThinking":
      if (freeAdapter?.selected !== true) throw new Error("native-adapter:free-adapter-required");
      return operation("model.thinking", () => freeAdapter.setThinking(command.enabled));
    case "openConversation": return historyProjection.open(command.id);
    case "loadMoreHistory": return historyProjection.loadMore();
    case "refreshHistory": return historyProjection.refresh();
    case "searchReferences": return referencesProjection.search(command.query, command.cursor);
    case "invalidateReferenceCache": return referencesProjection.invalidate();
    case "setDisplayInset": return display.setBottomInset(command.height);
    case "attachmentSnapshot": return freeAdapter?.selected === true ? [] : attachments.snapshot();
    case "uploadAttachment":
      if (freeAdapter?.selected === true) fail("free-capability-unavailable");
      return attachments.importNativeAttachment(command.id, command.name, command.mimeType, command.base64);
    case "removeAttachment":
      if (freeAdapter?.selected === true) fail("free-capability-unavailable");
      return attachments.remove(command.id);
    case "send": return operation("conversation.submit", () => submitNativeDraft(command.envelope));
    case "stop":
      if (activeRoute === "free-direct-network") return freeAdapter.stop();
      if (activeRoute === "free-website-command") return runtime.stopFree();
      if (activeRoute === "direct-network") return directConversation.stop();
      if (activeRoute && activeRoute !== "website-command") fail("stop-route-mismatch");
      return runtime.stop();
    default: fail("unknown-command");
    }
  }

  historyProjection.configure({requestPage: requestHistoryPage, onChange: schedule});
  models.configure({onChange: schedule});
  attachments.configure({runtime, onChange: schedule});
  referencesProjection.configure({request: (input, init) => pageFetch.call(window, input, init), onChange: schedule});
  directConversation.configure({request: (input, init) => window.fetch(input, init), onChange: schedule});
  freeAdapter?.configure({
    onChange: schedule,
    navigate: path => runtime.navigate(path),
    request: (input, init) => pageFetch.call(window, input, init)
  });
  roots?.subscribe(schedule);
  display.observe(schedule);
  window.addEventListener("popstate", schedule);
  window.__SwiftChatWebAdapter = Object.freeze({version: ADAPTER_VERSION, perform, snapshot: () => reportCurrentState(true)});
  schedule();
})();
