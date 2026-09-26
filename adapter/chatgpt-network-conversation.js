// Direct authenticated text transport for the paid ChatGPT website. The module
// keeps authorization and integrity material page-local and never reads message
// content from the website or exposes request credentials to native code.
(() => {
  "use strict";

  const headerNames = [
    "authorization", "chatgpt-account-id", "oai-did", "oai-language",
    "originator", "x-openai-codex-window-type", "x-openai-web-frontend"
  ];
  const templatePaths = new Set([
    "/backend-api/models", "/backend-api/tpp/models", "/backend-api/settings/user",
    "/backend-api/me", "/backend-api/accounts/optimized/check"
  ]);
  let request = (input, init) => window.fetch(input, init);
  let onChange = () => {};
  let template = null;
  let active = null;
  let deliveryUncertain = false;

  const fail = (code, cause = null) => {
    const error = new Error(`direct-network:${code}`);
    if (cause) error.cause = cause;
    throw error;
  };
  const nonempty = value => typeof value === "string" && value.length > 0;
  const randomItem = values => values.length ? values[Math.floor(Math.random() * values.length)] : null;
  const utf8Base64 = value => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  function requestValue(input, init) {
    try { return input instanceof Request ? new Request(input, init) : new Request(input, init); }
    catch { return null; }
  }

  function observeRequest(input, init) {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    // Constructing a new Request from a streaming POST transfers its body. Inspect
    // only the safe GET templates that this module is prepared to retain.
    if (String(method).toUpperCase() !== "GET") return false;
    const observed = requestValue(input, init);
    if (!observed) return false;
    const url = new URL(observed.url, location.origin);
    if (url.origin !== location.origin || !templatePaths.has(url.pathname)
      || !observed.headers.has("authorization") || !observed.headers.has("chatgpt-account-id")) return false;
    const headers = new Headers();
    for (const name of headerNames) {
      const value = observed.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    template = {
      headers,
      credentials: observed.credentials,
      mode: observed.mode,
      redirect: observed.redirect,
      referrer: observed.referrer,
      referrerPolicy: observed.referrerPolicy
    };
    onChange();
    return true;
  }

  function sessionRequest(path, options = {}) {
    if (!template) fail("session-template-unavailable");
    const headers = new Headers(template.headers);
    for (const [name, value] of new Headers(options.headers ?? [])) headers.set(name, value);
    return request(new Request(new URL(path, location.origin), {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      signal: options.signal,
      credentials: template.credentials,
      mode: template.mode,
      redirect: template.redirect,
      referrer: template.referrer,
      referrerPolicy: template.referrerPolicy,
      cache: options.cache ?? "no-store"
    }));
  }

  function fingerprint() {
    const memory = performance.memory;
    const navigationKeys = Object.keys(Object.getPrototypeOf(navigator));
    const globalKeys = Object.keys(globalThis);
    const scriptResources = performance.getEntriesByType?.("resource")
      ?.map(value => value.name).filter(value => /\.js(?:\?|$)/.test(value)) ?? [];
    return [
      (globalThis.screen?.width ?? 0) + (globalThis.screen?.height ?? 0),
      String(new Date()), memory?.jsHeapSizeLimit ?? null, Math.random(), navigator.userAgent,
      randomItem(scriptResources), template?.headers.get("x-openai-web-frontend") ?? null,
      navigator.language, navigator.languages?.join(",") ?? "", Math.random(),
      randomItem(navigationKeys), randomItem(globalKeys), randomItem(globalKeys), performance.now(),
      null, [...new URLSearchParams(location.search).keys()].join(","), navigator.hardwareConcurrency,
      performance.timeOrigin, Number("ai" in globalThis), Number("createPRNG" in globalThis),
      Number("cache" in globalThis), Number("data" in globalThis), Number("solana" in globalThis),
      Number("dump" in globalThis), Number("InstallTrigger" in globalThis)
    ];
  }

  function prepareProof() {
    const started = performance.now(), values = fingerprint();
    values[3] = 1;
    values[9] = performance.now() - started;
    return `gAAAAAC${utf8Base64(values)}`;
  }

  function proofHash(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x1000193) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
    hash ^= hash >>> 16;
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function solveProofOfWork(challenge) {
    if (!challenge?.required) return null;
    if (!nonempty(challenge.seed) || !nonempty(challenge.difficulty)) fail("proof-contract-changed");
    const started = performance.now(), values = fingerprint();
    // This bound is part of the currently observed website proof contract.
    for (let nonce = 0; nonce < 500_000; nonce++) {
      values[3] = nonce;
      values[9] = Math.round(performance.now() - started);
      const payload = utf8Base64(values);
      if (proofHash(`${challenge.seed}${payload}`).slice(0, challenge.difficulty.length)
        <= challenge.difficulty) return `gAAAAAB${payload}~S`;
    }
    fail("proof-unsolved");
  }

  function xor(value, key) {
    let output = "";
    for (let index = 0; index < value.length; index++) {
      output += String.fromCharCode(value.charCodeAt(index) ^ key.charCodeAt(index % key.length));
    }
    return output;
  }

  function solveTurnstile(challenge, key) {
    if (!challenge?.required) return Promise.resolve(null);
    if (!nonempty(challenge.dx) || !nonempty(key)) fail("turnstile-contract-changed");
    const registers = new Map();
    let instructionCount = 0, settled = false;
    const run = async instructions => {
      for (const [opcode, ...arguments_] of instructions) {
        const operation = registers.get(opcode);
        if (typeof operation !== "function") fail("turnstile-opcode-changed");
        const value = operation(...arguments_);
        if (value && typeof value.then === "function") await value;
        instructionCount += 1;
      }
    };
    return new Promise((resolve, reject) => {
      // The website VM returns its instruction count when the 500 ms budget expires.
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve(String(instructionCount)); }
      }, 500);
      const finish = (continuation, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        continuation(btoa(String(value)));
      };
      registers.set(0, value => solveTurnstile({required: true, dx: value}, String(registers.get(16))));
      registers.set(1, (target, source) => registers.set(target,
        xor(String(registers.get(target)), String(registers.get(source)))));
      registers.set(2, (target, value) => registers.set(target, value));
      registers.set(5, (target, source) => {
        const value = registers.get(target);
        Array.isArray(value) ? value.push(registers.get(source))
          : registers.set(target, value + registers.get(source));
      });
      registers.set(27, (target, source) => {
        const value = registers.get(target);
        Array.isArray(value) ? value.splice(value.indexOf(registers.get(source)), 1)
          : registers.set(target, value - registers.get(source));
      });
      registers.set(29, (target, left, right) => registers.set(target,
        Number(registers.get(left)) < Number(registers.get(right))));
      registers.set(33, (target, left, right) => registers.set(target,
        Number(registers.get(left)) * Number(registers.get(right))));
      registers.set(35, (target, left, right) => {
        const divisor = Number(registers.get(right));
        registers.set(target, divisor === 0 ? 0 : Number(registers.get(left)) / divisor);
      });
      registers.set(6, (target, object, property) => registers.set(target,
        registers.get(object)[String(registers.get(property))]));
      registers.set(7, (callable, ...arguments_) => registers.get(callable)(
        ...arguments_.map(value => registers.get(value))));
      registers.set(17, (target, callable, ...arguments_) => {
        try {
          const value = registers.get(callable)(...arguments_.map(item => registers.get(item)));
          return value && typeof value.then === "function"
            ? value.then(result => registers.set(target, result)).catch(error => registers.set(target, String(error)))
            : registers.set(target, value);
        } catch (error) { registers.set(target, String(error)); }
      });
      registers.set(13, (target, callable, ...arguments_) => {
        try { registers.get(callable)(...arguments_.map(item => registers.get(item))); }
        catch (error) { registers.set(target, String(error)); }
      });
      registers.set(8, (target, source) => registers.set(target, registers.get(source)));
      registers.set(10, globalThis);
      registers.set(11, (target, pattern) => {
        const match = performance.getEntriesByType?.("resource")
          ?.map(value => value.name.match(String(registers.get(pattern)))).find(Boolean);
        registers.set(target, match?.[0] ?? null);
      });
      registers.set(12, target => registers.set(target, registers));
      registers.set(14, (target, source) => registers.set(target, JSON.parse(String(registers.get(source)))));
      registers.set(15, (target, source) => registers.set(target, JSON.stringify(registers.get(source))));
      registers.set(18, target => registers.set(target, atob(String(registers.get(target)))));
      registers.set(19, target => registers.set(target, btoa(String(registers.get(target)))));
      registers.set(20, (left, right, callable, ...arguments_) => registers.get(left) === registers.get(right)
        ? registers.get(callable)(...arguments_) : null);
      registers.set(21, (left, right, difference, callable, ...arguments_) =>
        Math.abs(Number(registers.get(left)) - Number(registers.get(right)))
          > Number(registers.get(difference)) ? registers.get(callable)(...arguments_) : null);
      registers.set(23, (value, callable, ...arguments_) => registers.get(value) !== undefined
        ? registers.get(callable)(...arguments_) : null);
      registers.set(24, (target, object, property) => {
        const value = registers.get(object);
        registers.set(target, value[String(registers.get(property))].bind(value));
      });
      registers.set(34, (target, source) => Promise.resolve(registers.get(source))
        .then(value => registers.set(target, value)));
      registers.set(22, (target, ...instructions) => {
        const previous = registers.get(9);
        registers.set(9, [...instructions]);
        return run(registers.get(9)).catch(error => registers.set(target, String(error)))
          .finally(() => registers.set(9, previous));
      });
      for (const opcode of [25, 26, 28]) registers.set(opcode, () => {});
      registers.set(3, value => finish(resolve, value));
      registers.set(4, value => finish(reject, value));
      registers.set(30, (target, result, argumentNames, instructions) => {
        const named = Array.isArray(instructions);
        const names = named ? argumentNames : [];
        const body = (named ? instructions : argumentNames) ?? [];
        registers.set(target, (...values) => {
          if (settled) return undefined;
          if (named) names.forEach((name, index) => registers.set(name, values[index]));
          const previous = registers.get(9);
          registers.set(9, [...body]);
          return run(registers.get(9)).then(() => registers.get(result))
            .catch(error => String(error)).finally(() => registers.set(9, previous));
        });
      });
      registers.set(16, key);
      try {
        registers.set(9, JSON.parse(xor(atob(challenge.dx), key)));
        run(registers.get(9)).catch(error => finish(reject, `${instructionCount}: ${String(error)}`));
      } catch (error) { finish(reject, `${instructionCount}: ${String(error)}`); }
    });
  }

  async function chatRequirements(signal) {
    const proofKey = prepareProof();
    const prepare = await sessionRequest("/backend-api/sentinel/chat-requirements/prepare", {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({p: proofKey}), signal
    });
    if (!prepare.ok) fail(`requirements-prepare-http-${prepare.status}`);
    let requirements;
    try { requirements = await prepare.json(); }
    catch { fail("requirements-prepare-invalid-json"); }
    if (!requirements || !nonempty(requirements.prepare_token) || requirements.force_login === true) {
      fail("requirements-prepare-contract-changed");
    }
    const [proof, turnstile] = await Promise.all([
      solveProofOfWork(requirements.proofofwork),
      solveTurnstile(requirements.turnstile, proofKey)
    ]);
    const finalize = await sessionRequest("/backend-api/sentinel/chat-requirements/finalize", {
      method: "POST", headers: {"content-type": "application/json"}, signal,
      body: JSON.stringify({
        prepare_token: requirements.prepare_token,
        ...(proof ? {proofofwork: proof} : {}),
        ...(turnstile ? {turnstile} : {})
      })
    });
    if (!finalize.ok) fail(`requirements-finalize-http-${finalize.status}`);
    let completed;
    try { completed = await finalize.json(); }
    catch { fail("requirements-finalize-invalid-json"); }
    if (!completed || !nonempty(completed.token) || completed.force_login === true) {
      fail("requirements-finalize-contract-changed");
    }
    return {
      "openai-sentinel-chat-requirements-token": completed.token,
      ...(proof ? {"openai-sentinel-proof-token": proof} : {}),
      ...(turnstile ? {"openai-sentinel-turnstile-token": turnstile} : {})
    };
  }

  async function parentMessageID(conversationID, signal) {
    if (conversationID === null) return crypto.randomUUID();
    const response = await sessionRequest(
      `/backend-api/conversations/${encodeURIComponent(conversationID)}?num_turns=10&include_has_versions=true`,
      {signal}
    );
    if (!response.ok) fail(`active-conversation-http-${response.status}`);
    let body;
    try { body = await response.json(); }
    catch { fail("active-conversation-invalid-json"); }
    if (!body || body.conversation_id?.toLowerCase() !== conversationID.toLowerCase()
      || !nonempty(body.current_node)) fail("active-conversation-contract-changed");
    return body.current_node;
  }

  function submissionBody(payload, parentID) {
    const message = {
      id: crypto.randomUUID(),
      author: {role: "user", name: null, metadata: {}},
      create_time: Date.now() / 1_000,
      update_time: null,
      content: {content_type: "text", parts: [payload.serializedText]},
      status: "finished_successfully",
      end_turn: null,
      weight: 1,
      metadata: {},
      recipient: "all",
      channel: null
    };
    return {
      action: "next",
      is_do_not_remember: false,
      model: payload.model.slug,
      parent_message_id: parentID,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezone_offset_min: new Date().getTimezoneOffset(),
      messages: [message],
      supported_encodings: ["v1"],
      client_prepare_state: "none",
      ...(payload.model.thinkingEffort == null ? {} : {thinking_effort: payload.model.thinkingEffort}),
      ...(payload.conversationID === null ? {} : {conversation_id: payload.conversationID}),
      ...(payload.mode === "work" ? {conversation_origin: "tpp"} : {})
    };
  }

  function findConversationID(value) {
    if (!value || typeof value !== "object") return null;
    if (nonempty(value.conversation_id)) return value.conversation_id;
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        const found = findConversationID(child);
        if (found) return found;
      }
    }
    return null;
  }

  async function responseErrorCode(response) {
    try {
      const body = await response.clone().json();
      const values = [body?.code, body?.error?.code, body?.detail?.code, body?.detail?.error?.code];
      return values.find(value => typeof value === "string" && /^[a-z0-9_-]+$/i.test(value)) ?? null;
    } catch { return null; }
  }

  async function consumeStream(response, expectedConversationID, receiveConversationID) {
    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
      fail("unexpected-response-type");
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "", terminal = false, handoff = false;
    let conversationID = expectedConversationID;
    for (;;) {
      const {done, value} = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), {stream: !done});
      const lines = buffer.split(/\r?\n/);
      buffer = done ? "" : lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { terminal = true; continue; }
        if (!data || data === '"v1"') continue;
        let event;
        try { event = JSON.parse(data); }
        catch { continue; }
        const receivedConversationID = findConversationID(event);
        if (receivedConversationID) {
          conversationID = receivedConversationID;
          receiveConversationID(receivedConversationID);
        }
        terminal ||= event.type === "message_stream_complete";
        handoff ||= event.type === "stream_handoff";
      }
      if (done) break;
    }
    if (!terminal && !handoff) fail("stream-terminal-unavailable");
    if (expectedConversationID !== null && conversationID !== null
      && conversationID.toLowerCase() !== expectedConversationID.toLowerCase()) {
      fail("stream-conversation-mismatch");
    }
    if (expectedConversationID === null && !nonempty(conversationID)) fail("stream-conversation-identity-unavailable");
    return conversationID;
  }

  function validatePayload(payload) {
    if (!payload || typeof payload.serializedText !== "string" || !payload.serializedText
      || !["chat", "work"].includes(payload.mode)
      || (payload.conversationID !== null && !nonempty(payload.conversationID))
      || !payload.model || !nonempty(payload.model.slug)
      || !Array.isArray(payload.systemHints) || payload.systemHints.length
      || !Array.isArray(payload.references) || payload.references.length
      || !Array.isArray(payload.attachmentTokens) || payload.attachmentTokens.length) {
      fail("text-envelope-required");
    }
    const activeID = location.pathname.match(/^\/c\/([0-9a-f-]+)$/i)?.[1] ?? null;
    if (payload.conversationID === null ? location.pathname !== "/"
      : activeID?.toLowerCase() !== payload.conversationID.toLowerCase()) {
      fail("submission-context-mismatch");
    }
  }

  async function submit(payload) {
    if (deliveryUncertain) fail("delivery-uncertain-reload-before-sending");
    if (active) fail("submission-in-flight");
    validatePayload(payload);
    const controller = new AbortController();
    active = {controller, conversationID: payload.conversationID, dispatched: false, stopping: false};
    onChange();
    try {
      const [parentID, requirementsHeaders] = await Promise.all([
        parentMessageID(payload.conversationID, controller.signal),
        chatRequirements(controller.signal)
      ]);
      const headers = {
        "accept": "text/event-stream",
        "content-type": "application/json",
        ...requirementsHeaders,
        "x-oai-turn-trace-id": crypto.randomUUID(),
        "x-openai-web-sse-compression": "identity"
      };
      active.dispatched = true;
      const response = await sessionRequest("/backend-api/f/conversation", {
        method: "POST", headers, signal: controller.signal,
        body: JSON.stringify(submissionBody(payload, parentID))
      });
      if (!response.ok) {
        const code = await responseErrorCode(response);
        fail(`conversation-http-${response.status}${code ? `-${code.toLowerCase()}` : ""}`);
      }
      const conversationID = await consumeStream(response, payload.conversationID, value => {
        if (active) active.conversationID = value;
      });
      active.conversationID = conversationID;
      return {accepted: true, route: "direct-network", profile: "direct-network-text-v1",
        conversationID};
    } catch (error) {
      if (active?.stopping && nonempty(active.conversationID)) {
        return {accepted: true, route: "direct-network", profile: "direct-network-text-v1",
          conversationID: active.conversationID, stopped: true};
      }
      if (active?.dispatched && !/^direct-network:conversation-http-\d+(?:-[a-z0-9_-]+)?$/.test(error?.message ?? "")) {
        deliveryUncertain = true;
        fail("delivery-uncertain-reload-before-sending");
      }
      if (error?.message?.startsWith("direct-network:")) throw error;
      fail(error?.name === "AbortError" ? "request-aborted" : "request-failed", error);
    } finally {
      active = null;
      onChange();
    }
  }

  async function stop() {
    if (!active) fail("no-active-generation");
    if (!nonempty(active.conversationID)) fail("stop-identity-unavailable");
    const submission = active;
    const response = await sessionRequest("/backend-api/stop_conversation", {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({conversation_id: submission.conversationID, exclude_async_types: []})
    });
    if (!response.ok) fail(`stop-http-${response.status}`);
    submission.stopping = true;
    submission.controller.abort();
    return true;
  }

  window.__SwiftChatNetworkConversation = Object.freeze({
    configure(options = {}) {
      request = options.request ?? request;
      onChange = options.onChange ?? (() => {});
    },
    observeRequest,
    get available() { return template !== null && !deliveryUncertain; },
    get active() { return active !== null; },
    submit,
    stop
  });
})();
