// Positively identifies the smallest observed conversation content object.
// React-owned nodes remain in their original parents and every mutation is reversible.
(() => {
  "use strict";
  const selectors = Object.freeze({
    timeline: "[data-app-action-timeline-scroll]",
    messageList: "[data-thread-user-message-navigation-content]",
    messageContent: "[data-chatgpt-conversation-selection-target]",
    legacyThread: "#thread",
    legacyTurn: "article[data-testid^=\"conversation-turn-\"]"
  });
  const scope = crypto.randomUUID();
  const hiddenAttribute = "data-swiftchat-display-hidden";
  const transcriptAttribute = "data-swiftchat-display-transcript";
  const surfaceAttribute = "data-swiftchat-display-surface";
  const overlaySelectors = ["[data-radix-popper-content-wrapper]", "[role=\"menu\"]", "[role=\"tooltip\"]", "[role=\"dialog\"]", "[role=\"alertdialog\"]"];
  const saved = new Map();
  let stylesheet = null;
  let observer = null;
  let bottomInset = 0;
  let documentScroll = null;

  function stopDocumentScrolling() {
    if (!documentScroll) return;
    documentScroll.resize.disconnect();
    document.removeEventListener("scroll", documentScroll.onScroll);
    cancelAnimationFrame(documentScroll.frame);
    documentScroll = null;
  }
  function mountDocumentScrolling(transcript, offset) {
    if (window.__SwiftChatNativeDocumentScrolling !== true) return;
    if (documentScroll?.transcript === transcript && documentScroll.path === location.pathname) return;
    const following = documentScroll?.transcript === transcript ? documentScroll.following : null;
    stopDocumentScrolling();
    const root = document.scrollingElement;
    const state = {transcript, path: location.pathname, following: false, frame: 0};
    // Match the existing renderer's one-line tolerance for fractional scroll positions.
    const atBottom = () => root.scrollHeight - root.clientHeight - root.scrollTop <= 26;
    state.onScroll = () => { state.following = atBottom(); };
    state.resize = new ResizeObserver(() => {
      if (!state.following) return;
      cancelAnimationFrame(state.frame);
      state.frame = requestAnimationFrame(() => {
        if (documentScroll === state && state.following) root.scrollTop = root.scrollHeight;
      });
    });
    documentScroll = state;
    state.frame = requestAnimationFrame(() => {
      root.scrollTop = offset;
      state.following = following ?? atBottom();
      document.addEventListener("scroll", state.onScroll, {passive: true});
      state.resize.observe(transcript);
    });
  }

  const raw = reason => ({mode: "raw", reason});
  function commonParent(elements) {
    let parent = elements[0]?.parentElement;
    while (parent && !elements.every(element => parent.contains(element))) parent = parent.parentElement;
    return parent;
  }
  function probe() {
    const timelines = [...document.querySelectorAll(selectors.timeline)];
    let transcript, variant;
    if (timelines.length) {
      if (timelines.length !== 1) return raw("timeline-ambiguous");
      const lists = [...timelines[0].querySelectorAll(selectors.messageList)];
      if (lists.length !== 1 || !lists[0].querySelectorAll(selectors.messageContent).length) return raw("message-list-unmatched");
      transcript = lists[0];
      if (!timelines[0].contains(transcript)) return raw("transcript-hierarchy-unmatched");
      variant = "app-shell";
    } else {
      const threads = [...document.querySelectorAll(selectors.legacyThread)];
      if (threads.length !== 1) return raw(threads.length ? "thread-ambiguous" : "transcript-unmatched");
      const turns = [...threads[0].querySelectorAll(selectors.legacyTurn)];
      if (!turns.length) return raw("transcript-unmatched");
      transcript = commonParent(turns);
      if (!transcript || !threads[0].contains(transcript)) return raw("transcript-hierarchy-unmatched");
      variant = "legacy";
    }
    if (!document.body?.contains(transcript) || transcript === document.body) return raw("transcript-detached");
    return {mode: "matched", variant, transcript};
  }
  function restoreAttribute(element, name, value) {
    if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
  }
  function isLiveStatus(element) {
    if (element.getAttribute("role") !== "status") return false;
    const live = element.getAttribute("aria-live");
    return live === "polite" || live === "assertive";
  }
  function restore(reason = "requested") {
    stopDocumentScrolling();
    for (const [element, attributes] of saved) {
      for (const [name, value] of attributes) restoreAttribute(element, name, value);
    }
    saved.clear();
    stylesheet?.remove();
    stylesheet = null;
    return raw(reason);
  }
  function ensureStylesheet() {
    if (!stylesheet?.isConnected) {
      stylesheet = document.createElement("style");
      document.head.appendChild(stylesheet);
    }
    const documentCSS = window.__SwiftChatNativeDocumentScrolling === true ? `
      [${surfaceAttribute}="${scope}"] {
        height: auto !important;
        min-height: 0 !important;
        max-height: none !important;
        overflow: visible !important;
      }
      html[${surfaceAttribute}="${scope}"] { overflow-y: auto !important; }
      [${transcriptAttribute}="${scope}"] { min-height: 100vh !important; }
    ` : "";
    const css = `
      ${documentCSS}
      [${transcriptAttribute}="${scope}"] {
        padding-bottom: ${bottomInset}px !important;
        box-sizing: border-box !important;
      }
      [${surfaceAttribute}="${scope}"] {
        background: transparent !important;
        --app-shell-main-content-frame-top-offset: 0px !important;
      }
      [${hiddenAttribute}="${scope}"] { display: none !important; }
    `;
    if (stylesheet.textContent !== css) stylesheet.textContent = css;
  }
  function apply() {
    const result = probe();
    if (result.mode !== "matched") return restore(result.reason);
    const path = new Set();
    for (let element = result.transcript; element; element = element.parentElement) {
      path.add(element);
      if (element === document.body) break;
    }
    if (!path.has(document.body)) return restore("transcript-path-detached");
    for (const element of path) {
      if (element === result.transcript) continue;
      if ([...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) {
        return restore("unwrapped-content-on-path");
      }
    }
    // Capture the visible position before releasing the website's inner scrollport.
    let offset = 0;
    if (window.__SwiftChatNativeDocumentScrolling === true) {
      const scrollport = result.transcript.closest(selectors.timeline) ?? result.transcript.closest(selectors.legacyThread);
      offset = documentScroll?.transcript === result.transcript
        ? document.scrollingElement.scrollTop
        : Math.max(0, scrollport.getBoundingClientRect().top - result.transcript.getBoundingClientRect().top);
    }
    const desired = new Map();
    const mark = (element, name, value) => {
      if (!desired.has(element)) desired.set(element, new Map());
      desired.get(element).set(name, value);
    };
    // Website controls portal their panels outside the transcript. Retain those
    // roots and their ancestor paths without styling them as transcript surfaces.
    const roots = new Set([result.transcript]);
    const retained = new Set(path);
    for (const selector of overlaySelectors) for (const overlay of document.querySelectorAll(selector)) {
      roots.add(overlay);
      for (let element = overlay; element && !retained.has(element); element = element.parentElement) {
        retained.add(element);
        if (element === document.body) break;
      }
    }
    for (const parent of retained) {
      if ([...roots].some(root => root.contains(parent))) continue;
      for (const child of parent.children) {
        if (!retained.has(child) && !isLiveStatus(child)) mark(child, hiddenAttribute, scope);
      }
    }
    // Only the positively identified transcript and its ancestors form the surface.
    // Message bubbles, code blocks and other transcript children retain their styling.
    for (const element of path) mark(element, surfaceAttribute, scope);
    mark(document.documentElement, surfaceAttribute, scope);
    mark(result.transcript, transcriptAttribute, scope);
    for (const [element, attributes] of saved) {
      for (const [name, value] of attributes) if (!desired.get(element)?.has(name)) {
        restoreAttribute(element, name, value);
        attributes.delete(name);
      }
      if (!attributes.size) saved.delete(element);
    }
    ensureStylesheet();
    for (const [element, attributes] of desired) for (const [name, value] of attributes) {
      if (!saved.has(element)) saved.set(element, new Map());
      if (!saved.get(element).has(name)) saved.get(element).set(name, element.getAttribute(name));
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
    mountDocumentScrolling(result.transcript, offset);
    return result;
  }
  function observe(listener) {
    observer?.disconnect();
    let active = true;
    const start = () => {
      if (!active || !document.documentElement) return;
      observer = new MutationObserver(() => listener());
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["role", "aria-live", "data-radix-popper-content-wrapper"]
      });
      listener();
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, {once: true});
    return () => {
      active = false;
      document.removeEventListener("DOMContentLoaded", start);
      observer?.disconnect();
      observer = null;
    };
  }
  function setBottomInset(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("conversation-display:invalid-bottom-inset");
    }
    bottomInset = value;
    return apply();
  }
  window.__SwiftChatConversationDisplay = Object.freeze({probe, apply, restore, observe, setBottomInset});
})();
