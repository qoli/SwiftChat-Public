// Versioned page-runtime commands. This module reads committed React state and
// calls website-owned commands. It never queries or mutates DOM.
(() => {
  "use strict";
  const roots = window.__SwiftChatRuntimeRoots;
  const handles = new Map();
  const referenceHandles = new Map();
  let submissionInFlight = false;

  const fail = code => { throw new Error(`website-runtime:${code}`); };
  const modeForOrigin = value => value === null ? "chat" : value === "tpp" ? "work" : null;
  const sameModel = (left, right) => left?.slug === right?.slug
    && (left?.versionId ?? null) === (right?.versionId ?? null)
    && (left?.thinkingEffort ?? null) === (right?.thinkingEffort ?? null);

  function fibers() {
    if (!roots) fail("root-hook-unavailable");
    const current = roots.current();
    if (current.length !== 1) fail("committed-root-unavailable-or-ambiguous");
    const result = [], seen = new Set(), stack = [...current];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      result.push(fiber);
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return result;
  }
  function currentProps() {
    return fibers().flatMap(fiber => [fiber.memoizedProps, fiber.pendingProps])
      .filter(value => value && typeof value === "object");
  }
  function oneDistinct(values, code) {
    const unique = [...new Set(values)];
    if (unique.length !== 1) fail(code);
    return unique[0];
  }
  function composerBinding() {
    const props = currentProps();
    const owners = props.filter(value => value.composerController && Array.isArray(value.attachments)
      && value.selectedModel && typeof value.selectedModel.slug === "string"
      && value.models && typeof value.onModelChange === "function"
      && Array.isArray(value.selectedSystemHints) && typeof value.onSystemHintsChange === "function"
      && typeof value.onAttachmentRemove === "function"
      && typeof value.isSubmitting === "boolean" && typeof value.submissionBlocked === "boolean"
      && (value.conversationOrigin === null || value.conversationOrigin === "tpp")
      && Object.prototype.hasOwnProperty.call(value, "conversationId"));
    if (!owners.length) fail("composer-owner-unavailable");
    const controller = oneDistinct(owners.map(value => value.composerController), "composer-owner-ambiguous");
    const matches = owners.filter(value => value.composerController === controller);
    const mode = oneDistinct(matches.map(value => modeForOrigin(value.conversationOrigin)), "conversation-mode-ambiguous");
    if (!mode) fail("conversation-mode-unavailable");
    const conversationIDs = new Set(matches.map(value => value.conversationId ?? null));
    if (conversationIDs.size !== 1) fail("conversation-identity-ambiguous");
    const owner = matches.find(value => value === owners[0]) ?? matches[0];
    return {
      owner,
      mode,
      conversationID: [...conversationIDs][0],
      onModelChange: oneDistinct(matches.map(value => value.onModelChange), "model-command-ambiguous"),
      onSystemHintsChange: oneDistinct(matches.map(value => value.onSystemHintsChange), "system-hints-command-ambiguous"),
      onAttachmentRemove: oneDistinct(matches.map(value => value.onAttachmentRemove), "attachment-removal-command-ambiguous"),
      props
    };
  }
  function fileInputBinding(binding) {
    const profiles = binding.props.filter(value => value !== binding.owner
      && value.attachments === binding.owner.attachments
      && value.selectedSystemHints === binding.owner.selectedSystemHints
      && typeof value.fileInputRef === "function"
      && typeof value.fileAttachmentDisabled === "boolean"
      && typeof value.fileUploadLimitReached === "boolean"
      && typeof value.filesOnly === "boolean"
      && typeof value.onFilesSelected === "function" && value.onFilesSelected.length === 1);
    if (!profiles.length) fail("upload-profile-unavailable");
    const command = oneDistinct(profiles.map(value => value.onFilesSelected), "upload-command-ambiguous");
    const states = new Set(profiles.map(value => JSON.stringify([
      value.fileAttachmentDisabled, value.fileUploadLimitReached, value.filesOnly
    ])));
    if (states.size !== 1) fail("upload-profile-ambiguous");
    return {profile: profiles[0], command};
  }
  function referenceBinding(binding) {
    const profiles = binding.props.filter(value => value.composerController === binding.owner.composerController
      && typeof value.onLibraryFileMentionSelected === "function"
      && value.onLibraryFileMentionSelected.length === 1);
    const command = oneDistinct(profiles.map(value => value.onLibraryFileMentionSelected),
      "reference-command-unavailable-or-ambiguous");
    const controller = binding.owner.composerController;
    const schema = controller?.view?.state?.schema;
    if (!schema?.nodes?.doc || !schema.nodes.paragraph || !schema.nodes.chatGptLibraryFileMention
      || !schema.nodes.atMention || typeof controller.markdownEditor?.serialize !== "function"
      || typeof controller.parsePromptText !== "function") fail("reference-serializer-unavailable");
    return {controller, schema, command};
  }
  function sendBinding(composer) {
    const candidates = composer.props.filter(value => typeof value.onSubmit === "function"
      && value.onSubmit.length === 5 && typeof value.prompt === "string"
      && typeof value.canSubmit === "boolean"
      && (value.conversationId ?? null) === composer.conversationID);
    if (!candidates.length) fail("paid-submit-profile-unavailable");
    const command = oneDistinct(candidates.map(value => value.onSubmit), "paid-submit-profile-ambiguous");
    return {profile: "paid-on-submit-5-v1", command};
  }
  function context() {
    const binding = composerBinding();
    return {
      mode: binding.mode,
      conversationID: binding.conversationID,
      model: {
        slug: binding.owner.selectedModel.slug,
        versionId: binding.owner.selectedModel.versionId ?? null,
        thinkingEffort: binding.owner.selectedModel.thinkingEffort ?? null
      },
      streaming: binding.owner.isStreaming === true,
      submitting: binding.owner.isSubmitting === true
    };
  }
  function waitFor(read, reason) {
    const initial = read();
    if (initial) return Promise.resolve(initial);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const changed = () => {
        try { const value = read(); if (value) finish(value); }
        catch (error) { finish(null, error); }
      };
      const unsubscribe = roots.subscribe(changed);
      const timer = setTimeout(() => finish(null, new Error(`website-runtime:${reason}`)), 10000);
      changed();
    });
  }
  async function applyEnvelope(binding, payload) {
    if (!payload.model || typeof payload.model.slug !== "string" || !payload.model.slug) fail("invalid-model");
    if (!Array.isArray(payload.systemHints) || payload.systemHints.some(value => typeof value !== "string")) fail("invalid-system-hints");
    if (payload.systemHints.length) fail("paid-system-hint-profile-unverified");
    if (!sameModel(binding.owner.selectedModel, payload.model)) {
      binding.onModelChange({
        slug: payload.model.slug,
        versionId: payload.model.versionId ?? null,
        thinkingEffort: payload.model.thinkingEffort ?? null
      });
      await waitFor(() => {
        const current = composerBinding();
        if (current.mode !== binding.mode || current.conversationID !== binding.conversationID) fail("submission-context-changed");
        return sameModel(current.owner.selectedModel, payload.model) ? current : null;
      }, "model-not-confirmed");
    }
    return composerBinding();
  }
  function checkedAttachments(binding, tokens) {
    if (!Array.isArray(tokens) || new Set(tokens).size !== tokens.length) fail("invalid-attachment-selection");
    return tokens.map(token => {
      const handle = handles.get(token);
      if (!handle || handle.controller !== binding.owner.composerController
        || handle.conversationID !== binding.conversationID) fail("attachment-context-changed");
      const descriptor = binding.owner.attachments.find(value => matchesDescriptor(value, handle));
      if (!descriptor) fail("attachment-no-longer-registered");
      if (descriptor.status !== "ready") fail("attachment-not-ready");
      return handle;
    });
  }
  function referenceNode(profile, reference) {
    if (!reference || typeof reference.token !== "string" || !reference.token) fail("invalid-reference");
    if (reference.kind === "file") {
      const attrs = reference.attrs;
      if (!attrs || ![attrs.entrypoint, attrs.fileId, attrs.libraryArtifactType,
        attrs.libraryFileId, attrs.mimeType, attrs.title].every(value => typeof value === "string")
        || !attrs.libraryFileId || !attrs.title || !reference.file || reference.file.id !== attrs.libraryFileId) {
        fail("invalid-file-reference");
      }
      return profile.schema.nodes.chatGptLibraryFileMention.create(attrs);
    }
    if (reference.kind === "folder") {
      const attrs = reference.attrs;
      if (!attrs || ![attrs.path, attrs.fsPath, attrs.label].every(value => typeof value === "string")
        || attrs.path !== attrs.fsPath || !attrs.label
        || !attrs.path.startsWith("chatgpt-library-folder://") || !attrs.path.endsWith("/")) {
        fail("invalid-folder-reference");
      }
      return profile.schema.nodes.atMention.create(attrs);
    }
    fail("reference-kind-unavailable");
  }
  function sameReferenceNode(node, reference) {
    if (reference.kind === "file") {
      return node.type?.name === "chatGptLibraryFileMention"
        && ["entrypoint", "fileId", "libraryArtifactType", "libraryFileId", "mimeType", "title"]
          .every(key => node.attrs?.[key] === reference.attrs[key]);
    }
    return node.type?.name === "atMention"
      && ["path", "fsPath", "label"].every(key => node.attrs?.[key] === reference.attrs[key]);
  }
  function serializeReference(profile, reference) {
    const node = referenceNode(profile, reference);
    const paragraph = profile.schema.nodes.paragraph.create(null, [node]);
    const document = profile.schema.nodes.doc.create(null, [paragraph]);
    const marker = profile.controller.markdownEditor.serialize(document);
    if (typeof marker !== "string" || !marker || /[\r\n]/.test(marker)) fail("reference-marker-changed");
    const parsed = profile.controller.parsePromptText(marker);
    const matches = [];
    parsed?.descendants?.(candidate => { if (sameReferenceNode(candidate, reference)) matches.push(candidate); });
    if (matches.length !== 1) fail("reference-round-trip-changed");
    return marker;
  }
  function serializeDraft(binding, text, references) {
    if (!Array.isArray(references)) fail("invalid-references");
    if (!references.length) return text;
    const profile = referenceBinding(binding);
    let result = text, end = 0;
    for (const reference of references) {
      if (!Number.isSafeInteger(reference.location) || !Number.isSafeInteger(reference.length)
        || reference.location < end || reference.length <= 0
        || reference.location + reference.length > text.length) fail("invalid-reference-range");
      end = reference.location + reference.length;
    }
    for (const reference of [...references].reverse()) {
      const marker = serializeReference(profile, reference);
      result = result.slice(0, reference.location) + marker
        + result.slice(reference.location + reference.length);
    }
    const parsed = profile.controller.parsePromptText(result);
    const found = new Set();
    parsed?.descendants?.(node => {
      for (const reference of references) if (sameReferenceNode(node, reference)) found.add(reference.token);
    });
    if (found.size !== references.length) fail("reference-draft-round-trip-changed");
    return result;
  }
  function libraryDescriptor(binding, libraryFileID) {
    const matches = binding.owner.attachments.filter(value => value?.source === "library"
      && (value.libraryFileId === libraryFileID || value.mountedLibraryFileId === libraryFileID));
    if (matches.length > 1) fail("reference-attachment-ambiguous");
    return matches[0] ?? null;
  }
  async function removeReferenceHandle(binding, handle) {
    const descriptor = libraryDescriptor(binding, handle.libraryFileID);
    if (descriptor) {
      const id = descriptor.uploadId ?? descriptor.id;
      if (typeof id !== "string" || !id) fail("reference-attachment-identity-unavailable");
      binding.onAttachmentRemove(id);
      await waitFor(() => {
        const current = composerBinding();
        if (current.owner.composerController !== binding.owner.composerController
          || current.conversationID !== binding.conversationID) fail("reference-context-changed");
        return libraryDescriptor(current, handle.libraryFileID) ? null : current;
      }, "reference-removal-unconfirmed");
    }
    referenceHandles.delete(handle.token);
  }
  async function prepareReferences(binding, references) {
    const desired = new Set(references.map(value => value.token));
    if (desired.size !== references.length) fail("duplicate-reference");
    for (const handle of [...referenceHandles.values()]) {
      if (handle.controller === binding.owner.composerController
        && handle.conversationID === binding.conversationID && !desired.has(handle.token)) {
        await removeReferenceHandle(binding, handle);
      }
    }
    if (!references.some(value => value.kind === "file")) return composerBinding();
    const profile = referenceBinding(binding);
    for (const reference of references) {
      if (reference.kind !== "file") continue;
      let current = composerBinding();
      if (current.owner.composerController !== binding.owner.composerController
        || current.conversationID !== binding.conversationID) fail("reference-context-changed");
      let descriptor = libraryDescriptor(current, reference.attrs.libraryFileId);
      if (!descriptor) {
        if (await profile.command(reference.file) !== true) fail("reference-registration-rejected");
        descriptor = await waitFor(() => {
          const changed = composerBinding();
          if (changed.owner.composerController !== binding.owner.composerController
            || changed.conversationID !== binding.conversationID) fail("reference-context-changed");
          return libraryDescriptor(changed, reference.attrs.libraryFileId);
        }, "reference-registration-unconfirmed");
      }
      if (descriptor.status !== "ready") fail("reference-attachment-not-ready");
      referenceHandles.set(reference.token, {token: reference.token,
        controller: binding.owner.composerController, conversationID: binding.conversationID,
        libraryFileID: reference.attrs.libraryFileId});
    }
    return composerBinding();
  }
  function checkedReferences(binding, references) {
    for (const reference of references) {
      if (reference.kind !== "file") continue;
      const handle = referenceHandles.get(reference.token);
      if (!handle || handle.controller !== binding.owner.composerController
        || handle.conversationID !== binding.conversationID
        || !libraryDescriptor(binding, handle.libraryFileID)) fail("reference-attachment-missing");
    }
  }
  function descriptorIdentity(descriptor) {
    const id = typeof descriptor?.id === "string" && descriptor.id ? descriptor.id : null;
    const uploadId = typeof descriptor?.uploadId === "string" && descriptor.uploadId ? descriptor.uploadId : null;
    return id || uploadId ? {id, uploadId} : null;
  }
  function matchesDescriptor(descriptor, handle) {
    if (descriptor === handle.descriptor) return true;
    const current = descriptorIdentity(descriptor), identity = handle.identity;
    if (!current || !identity) return false;
    return (identity.uploadId && current.uploadId === identity.uploadId)
      || (identity.id && current.id === identity.id);
  }
  async function submit(payload) {
    if (submissionInFlight) fail("submission-in-flight");
    if (!payload || typeof payload.text !== "string" || !["chat", "work"].includes(payload.mode)) fail("invalid-submission");
    if (!Array.isArray(payload.references)) fail("invalid-references");
    let binding = composerBinding();
    if (binding.mode !== payload.mode || (payload.conversationID ?? null) !== binding.conversationID) fail("submission-context-mismatch");
    // submitDisabled describes the website editor's empty local draft. SwiftChat
    // supplies the text directly to the website command, so only semantic
    // submission blockers apply here.
    if (binding.owner.readOnly === true || binding.owner.submissionBlocked || binding.owner.isSubmitting
      || binding.owner.isStreaming === true) fail("submission-blocked");
    if (binding.owner.commentAttachments?.length || binding.owner.selectedTextAttachments?.length
      || binding.owner.targetedReply) fail("unreviewed-website-context");
    const serializedText = serializeDraft(binding, payload.text, payload.references);
    if (payload.serializedText !== serializedText) fail("serialized-reference-draft-mismatch");
    binding = await applyEnvelope(binding, payload);
    binding = await prepareReferences(binding, payload.references);
    checkedAttachments(binding, payload.attachmentTokens ?? []);
    checkedReferences(binding, payload.references);
    const send = sendBinding(binding);
    submissionInFlight = true;
    try {
      const result = send.command(serializedText, {
        model: {...payload.model},
        systemHints: [...payload.systemHints]
      }, undefined, performance.now(), false);
      if (!result || typeof result.then !== "function") fail("submit-return-contract-changed");
      if (await result !== true) fail("submit-rejected");
      for (const token of payload.attachmentTokens ?? []) handles.delete(token);
      for (const reference of payload.references) referenceHandles.delete(reference.token);
      return {accepted: true, route: "website-command", profile: send.profile};
    } finally { submissionInFlight = false; }
  }
  function stop() {
    const binding = composerBinding();
    if (binding.owner.isStreaming !== true) fail("no-active-generation");
    const owners = binding.props.filter(value => value.composerController === binding.owner.composerController
      && value.stopEnabled === true
      && typeof value.onStop === "function" && value.onStop.length === 0);
    const command = oneDistinct(owners.map(value => value.onStop), "paid-stop-profile-unavailable-or-ambiguous");
    command();
    return true;
  }
  function router() {
    const routers = currentProps().map(value => value.value).filter(value => value?.basename === "/"
      && value.static === false && value.router?.window === window
      && typeof value.router.navigate === "function").map(value => value.router);
    return oneDistinct(routers, "router-unavailable-or-ambiguous");
  }
  async function navigate(path) {
    if (typeof path !== "string" || !/^\/(?:$|c\/[0-9a-f-]+$)/i.test(path)) fail("invalid-navigation-target");
    await router().navigate(path);
    return true;
  }
  async function setMode(mode) {
    if (!['chat', 'work'].includes(mode) || location.pathname !== "/") fail("mode-requires-home");
    const current = composerBinding();
    if (current.mode === mode) return true;
    const owners = current.props.filter(value => value.composerController === current.owner.composerController
      && ["chat", "work"].includes(value.mode) && value.canSwitchMode === true
      && typeof value.onModeChange === "function" && (mode !== "work" || value.workModeAllowed === true));
    const command = oneDistinct(owners.map(value => value.onModeChange), "mode-command-unavailable-or-ambiguous");
    command(mode, "mode_picker");
    await waitFor(() => location.pathname === "/" && composerBinding().mode === mode, "mode-not-confirmed");
    return true;
  }
  async function newConversation(mode) {
    const previousPath = location.pathname;
    const previous = composerBinding();
    await navigate("/");
    await waitFor(() => {
      if (location.pathname !== "/") return null;
      let current;
      try { current = composerBinding(); }
      catch (error) {
        if (["website-runtime:composer-owner-unavailable",
          "website-runtime:committed-root-unavailable-or-ambiguous"].includes(error?.message)) return null;
        throw error;
      }
      if (previousPath !== "/"
        && current.owner.composerController === previous.owner.composerController
        && current.conversationID === previous.conversationID) return null;
      return current;
    }, "home-composer-not-ready");
    return setMode(mode);
  }
  async function uploadAttachment(file) {
    if (!(file instanceof File)) fail("invalid-file");
    const binding = composerBinding();
    if (submissionInFlight || binding.owner.isSubmitting || binding.owner.isStreaming === true || binding.owner.readOnly === true) fail("upload-unavailable");
    const input = fileInputBinding(binding);
    if (input.profile.fileAttachmentDisabled || input.profile.fileUploadLimitReached) fail("upload-unavailable");
    const before = new Set(binding.owner.attachments);
    input.command([file]);
    const descriptor = await waitFor(() => {
      const current = composerBinding();
      if (current.owner.composerController !== binding.owner.composerController
        || current.conversationID !== binding.conversationID) fail("attachment-context-changed");
      const added = current.owner.attachments.filter(value => !before.has(value)
        && value?.name === file.name && value?.size === file.size && value?.mimeType === file.type);
      if (added.length > 1) fail("upload-registration-ambiguous");
      return added[0] ?? null;
    }, "upload-registration-unconfirmed");
    const token = crypto.randomUUID();
    const identity = descriptorIdentity(descriptor);
    if (!identity) fail("attachment-identity-unavailable");
    handles.set(token, {token, controller: binding.owner.composerController,
      conversationID: binding.conversationID, descriptor, identity});
    return {token};
  }
  function attachmentState(token) {
    const handle = handles.get(token);
    if (!handle) fail("attachment-handle-unavailable");
    const binding = composerBinding();
    if (binding.owner.composerController !== handle.controller || binding.conversationID !== handle.conversationID) fail("attachment-context-changed");
    const descriptor = binding.owner.attachments.find(value => matchesDescriptor(value, handle));
    if (!descriptor) fail("attachment-no-longer-registered");
    if (!["uploading", "ready", "error", "failed"].includes(descriptor.status)) fail("attachment-status-unavailable");
    return {status: ["error", "failed"].includes(descriptor.status) ? "failed" : descriptor.status};
  }
  async function removeAttachment(token) {
    const handle = handles.get(token);
    if (!handle) fail("attachment-handle-unavailable");
    const binding = composerBinding();
    if (binding.owner.composerController !== handle.controller || binding.conversationID !== handle.conversationID) fail("attachment-context-changed");
    const descriptor = binding.owner.attachments.find(value => matchesDescriptor(value, handle));
    if (descriptor) {
      const websiteID = handle.identity.uploadId ?? handle.identity.id;
      if (!websiteID) fail("attachment-identity-unavailable");
      binding.onAttachmentRemove(websiteID);
      await waitFor(() => !composerBinding().owner.attachments.some(value => matchesDescriptor(value, handle)), "attachment-removal-unconfirmed");
    }
    handles.delete(token);
    return true;
  }

  window.__SwiftChatWebsiteRuntime = Object.freeze({
    context, navigate, newConversation, setMode, submit, stop,
    serializeReferences(text, references) { return serializeDraft(composerBinding(), text, references); },
    uploadAttachment, attachmentState, removeAttachment
  });
})();
