# ChatGPT Web host contract: 0.1.0-alpha.1

This document describes the exported adapter, not a stable SDK. Alpha revisions
may break signatures and payloads. `ADAPTER_VERSION` identifies the implementation;
`publicProtocol` in the manifest identifies this public contract. They are separate
version namespaces. The implementation and synthetic fixtures are the exact source
of truth for payload details.

## Host requirements

Use a WebKit page on the permitted ChatGPT origin with its website-owned account
session. Register the following WKScriptMessageHandler names in the page content
world before injecting the adapter at document start, main frame only:

- `swiftChatConversationAdapterStatus`: readiness, compatibility invariants,
  attachment state, document identity, mode and operation diagnostics.
- `swiftChatConversationAdapterHistory`: projected conversation-list metadata
  fetched by the website, including pagination and mode information.

The adapter exposes `window.__SwiftChatConversationAdapter`. Its `version` must
match the host's tested implementation. The host must validate message origin,
main frame, document identity, expected payload shapes and lifecycle before
applying results. Install only in the conversation WebView; authentication windows
and ordinary browser tabs must remain adapter-free. The adapter's hostname check
is not a replacement for the host's navigation/origin policy.

The host supplies native navigation, history, model controls, composer, attachment
UI, errors and window chrome. The adapter hides corresponding website controls
and uses the mounted website composer as transport. It cannot provide a useful
standalone user interface. Keep the conversation WebView mounted and visible for
operations that await website animation frames; a loaded document alone does not
establish composer readiness. Optional `window.__SwiftChatNativeDocumentScrolling`
enables the native document scrolling integration.

## Exposed operations

| Area | Methods |
| --- | --- |
| Readiness | `reportCurrentState` |
| Conversation creation | `selectNewConversationMode`, `newConversationCatalog`, `applyNewConversationSelection` |
| Submission | `submitNativeDraft(text, mentions = [], appContext = "", attachmentIDs = [])`, `stopNativeGeneration` |
| References | `searchMentions(query, cursor = null)`, `invalidateMentionCache` |
| Attachments | `forwardAttachmentPicker`, `importNativeAttachment(id, name, mimeType, base64)`, `removeNativeAttachment`, `nativeAttachmentSnapshot` |
| History | `openHistoryConversation`, `loadMoreHistory` |
| Model controls | `openNativeModelControl`, `nativeModelControlSnapshot`, `selectNativeModel`, `setNativeReasoningValue` |

Operations can return promises, false, or throw compatibility errors. Hosts must
handle the actual operation contract, preserve drafts on failure, and reject stale
asynchronous results after navigation. Never treat the mere existence of the
JavaScript object as success. Reference ranges use UTF-16 coordinates; handles
are document/account scoped and cannot be replayed after their context changes.

## Ownership and privacy

ChatGPT owns authentication, model/tool availability, messages, streaming and
history. The adapter projects metadata required by native UI, rather than copying
assistant output or creating another history client. The host must not extract
cookies or credentials or persist a shadow transcript of ChatGPT output.

The exported implementation has two explicit context transports. In confirmed
**Chat** mode, a one-shot scoped interceptor inserts a separate hidden message
into the matching website-owned outgoing request. In confirmed **Work** mode,
this snapshot prepends context as a fenced JSON string to the website composer
text and rebases reference ranges. This makes the context visible in the sent
website message. It is not a retry path after hidden delivery fails. Unknown or
changed mode rejects submission.

Hosts must disclose which transport they enable and enforce their product's
context-delivery policy before calling `submitNativeDraft`. In particular, a host
that promises hidden-only context must reject Work mode before submission. The
host captures sources afresh on send, retains the submitted snapshot with its own
message state, and preserves the draft if capture or preparation fails. Stale
handles, changed contracts and mismatched requests must surface explicit errors.

Diagnostics contain lifecycle and state only. Do not log credentials, prompts,
assistant output, uploaded files or captured app text. Report sanitized URL host
and path only, without query or fragment.

## Pairing and acceptance

Bundle a reviewed adapter snapshot with its tested native host release. Record the
implementation version and manifest hashes with that release. The application does
**not** fetch or execute a new adapter from this repository at runtime. Adapter
updates ship through a signed application update, allowing native bridge and
JavaScript changes to be validated together.

Fixtures cover context transport, attachments, mode, history pagination, mentions,
new-conversation catalogs, diagnostics and browser context. Passing them proves
those synthetic contracts only. Release verification additionally requires the
actual signed-in WebKit page, creation and navigation, submit/stop, attachments,
references, explicit failures and applicable Chat/Work behavior. Website changes
may invalidate a previously verified snapshot at any time.
