// Captures committed React roots at document start. Runtime consumers traverse
// these roots directly and never discover React through a DOM node.
(() => {
  "use strict";
  const roots = new Map();
  const listeners = new Set();
  let revision = 0;

  function committed(rendererID, root) {
    roots.set(rendererID, root);
    revision += 1;
    for (const listener of listeners) {
      try { listener(revision); } catch { /* Observation cannot affect React. */ }
    }
  }

  const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (existing) {
    const original = existing.onCommitFiberRoot;
    existing.onCommitFiberRoot = function(rendererID, root, ...rest) {
      committed(rendererID, root);
      return original?.call(this, rendererID, root, ...rest);
    };
  } else {
    let nextRendererID = 0;
    Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      configurable: true,
      value: {
        supportsFiber: true,
        renderers: new Map(),
        inject(renderer) {
          const rendererID = ++nextRendererID;
          this.renderers.set(rendererID, renderer);
          return rendererID;
        },
        onCommitFiberRoot: committed,
        onCommitFiberUnmount() {},
        onPostCommitFiberRoot() {},
        checkDCE() {}
      }
    });
  }

  window.__SwiftChatRuntimeRoots = Object.freeze({
    current() { return [...roots.values()].map(root => root.current).filter(Boolean); },
    get revision() { return revision; },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
})();
