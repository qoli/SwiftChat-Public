// The website upload service is the explicit transport: it performs register,
// signed upload and process_upload_stream, then registers its local uploadId.
// Keeping one upload producer avoids duplicate uploads and fabricated IDs.
(() => {
  'use strict';
  const entries = new Map();
  let options = {}, importing = false;
  const fail = code => { throw new Error(`network-attachments:${code}`); };
  const changed = () => options.onChange?.();
  const runtime = () => options.runtime ?? window.__SwiftChatWebsiteRuntime;
  function snapshot() {
    return [...entries.values()].map(entry => {
      let status = entry.error ? 'failed' : 'uploading';
      if (entry.handle && !entry.error) {
        try { const state = runtime().attachmentState(entry.handle.token); status = state.status === 'error' ? 'failed' : state.status; }
        catch { status = 'failed'; }
      }
      return {id: entry.id, name: entry.name, mimeType: entry.mimeType, size: entry.size, status,
        ...(status === 'failed' ? {error: 'ChatGPT could not confirm this attachment. Remove it and add it again.'} : {})};
    });
  }
  async function importNativeAttachment(id, name, mimeType, base64) {
    if (importing) fail('import-in-flight');
    if (typeof id !== 'string' || !id || entries.has(id)) fail('duplicate-identity');
    if (typeof name !== 'string' || !name || typeof mimeType !== 'string' || typeof base64 !== 'string') fail('invalid-file');
    if (typeof runtime()?.uploadAttachment !== 'function') fail('upload-service-unavailable');
    const file = new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, {type: mimeType});
    const entry = {id, name, mimeType, size: file.size}; entries.set(id, entry); importing = true; changed();
    try {
      entry.handle = await runtime().uploadAttachment(file);
      if (typeof entry.handle?.token !== 'string' || !entry.handle.token) fail('registration-unconfirmed');
      changed(); return snapshot();
    } catch { entry.error = true; changed(); fail('upload-failed'); }
    finally { importing = false; }
  }
  function verify(ids) {
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== entries.size || ids.some(id => !entries.has(id))) fail('draft-identity-mismatch');
    if (snapshot().some(value => value.status !== 'ready')) fail('not-ready');
    return true;
  }
  async function remove(id) {
    if (importing) fail('import-in-flight');
    const entry = entries.get(id); if (!entry) fail('unknown-identity');
    if (entry.handle) await runtime().removeAttachment(entry.handle.token);
    entries.delete(id); changed(); return true;
  }
  function submitted(ids) { for (const id of ids) { if (!entries.has(id)) fail('draft-identity-mismatch'); } for (const id of ids) entries.delete(id); changed(); }
  function attachmentTokens(ids) { verify(ids); return ids.map(id => entries.get(id).handle.token); }
  window.__SwiftChatNetworkAttachments = Object.freeze({configure(value) { options = {...value}; }, importNativeAttachment, snapshot, remove, verify, submitted, didSubmit: submitted, attachmentTokens});
})();
