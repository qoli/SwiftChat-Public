
// Directly bundled as an Xcode resource. This file has no runtime or build dependencies.
(() => {
	"use strict";
	var ADAPTER_VERSION = "2.16.9";
	var documentID = crypto.randomUUID();
	var SELECTORS = {
		thread: "#thread",
		bottom: "#thread-bottom",
		form: "#thread-bottom form",
		editor: "#prompt-textarea[role=\"textbox\"]",
		send: "button[data-testid=\"send-button\"]",
		stop: "button[data-testid=\"stop-button\"]",
		modelControl: "button[aria-haspopup=\"menu\"]:not([data-testid=\"composer-plus-btn\"])",
		photos: "input[data-testid=\"upload-photos-input\"]",
		media: "input[data-testid=\"upload-media-input\"]"
	};
	// Only project explicit website mode state; unknown origins remain unknown.
	var conversationModes = new Map();
	var submittedHomeMode = null;
	function modeForOrigin(item) {
		if (!Object.prototype.hasOwnProperty.call(item, "conversation_origin")) return null;
		if (item.conversation_origin === "tpp") return "work";
		if (item.conversation_origin === null) return "chat";
		return null;
	}
	function currentConversationMode() {
		if (location.pathname === "/") {
			const controls = document.querySelectorAll('[data-tpp-toggle-value][role="radio"][aria-checked="true"]');
			if (controls.length === 0) return freeWebsiteConversationMode();
			if (controls.length !== 1) return null;
			const value = controls[0].getAttribute("data-tpp-toggle-value");
			return value === "work" ? "work" : value === "chatgpt" ? "chat" : null;
		}
		const id = activeConversationID();
		if (!id) return null;
		if (submittedHomeMode !== null && !conversationModes.has(id)) {
			conversationModes.set(id, submittedHomeMode);
			submittedHomeMode = null;
		}
		return conversationModes.get(id) ?? null;
	}
	function modelContextKey() {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return null;
		// Context metadata is unavailable while the fiber root/composer controls transition.
		// Explicit snapshot and mutation operations retain their contract errors.
		let auto;
		try { auto = freeAutoThinkingState(); } catch { return null; }
		if (auto) return JSON.stringify([location.pathname, currentConversationMode(), "autoThinking", auto.modelID, auto.thinkingEnabled]);
		const control = uniqueControl(probe.anchors.form, SELECTORS.modelControl);
		if (!control) return null;
		return JSON.stringify([location.pathname, currentConversationMode(), control.textContent.trim()]);
	}
	// Diagnostics observe website control flow; they never read editor/message text.
	function diagnoseOperation(operation, run) {
		const operationID = crypto.randomUUID();
		const started = performance.now();
		let stage = "operation";
		const report = (nextStage, outcome) => {
			stage = nextStage;
			window.webkit?.messageHandlers?.swiftChatConversationAdapterStatus?.postMessage({
				state: "operation-diagnostic", documentID, adapterVersion: ADAPTER_VERSION,
				operationDiagnostic: {
					operationID, operation, stage, outcome,
					elapsedMS: Math.round(performance.now() - started),
					visibility: document.visibilityState, readyState: document.readyState,
					editorCount: document.querySelectorAll(SELECTORS.editor).length,
					menuExpanded: isModelControlExpanded()
				}
			});
		};
		const visibilityChanged = () => report(stage, "waiting");
		document.addEventListener("visibilitychange", visibilityChanged);
		const finish = (outcome) => {
			report(stage, outcome);
			document.removeEventListener("visibilitychange", visibilityChanged);
		};
		report("operation", "begin");
		try {
			const result = run(report);
			if (result && typeof result.then === "function") {
				return result.then(value => {
					finish(value === false ? "failed" : "succeeded"); return value;
				}, error => { finish("failed"); throw error; });
			}
			finish(result === false ? "failed" : "succeeded");
			return result;
		} catch (error) { finish("failed"); throw error; }
	}
	function waitForWebsiteState(read, invariant, diagnostic, subscribe) {
		diagnostic?.(invariant, "waiting");
		const value = read();
		if (value) return Promise.resolve(value);
		return new Promise((resolve, reject) => {
			let stopObserving = () => {}, settled = false;
			const finish = (value, error) => {
				if (settled) return;
				settled = true;
				stopObserving(); clearTimeout(timeout);
				if (error) reject(error); else resolve(value);
			};
			const changed = () => {
				try { const value = read(); if (value) finish(value); }
				catch (error) { finish(null, error); }
			};
			// A UI transition must either confirm its state or surface a bounded failure.
			const timeout = setTimeout(() => finish(null, new Error(invariant)), 10000);
			try {
				if (subscribe) stopObserving = subscribe(changed);
				else {
					const observer = new MutationObserver(changed);
					observer.observe(document.documentElement, {subtree:true, childList:true, attributes:true, characterData:true});
					stopObserving = () => observer.disconnect();
				}
				if (settled) stopObserving();
				else changed(); // Close the gap between the first read and subscribing.
			} catch (error) { finish(null, error); }
		});
	}
	async function selectNewConversationMode(mode, diagnostic) {
		if (location.pathname !== "/" || !["chat", "work"].includes(mode)) return false;
		const value = mode === "chat" ? "chatgpt" : "work";
		const readControl = () => exactlyOne(document, `[data-tpp-toggle-value="${value}"][role="radio"]`);
		try {
			// Some free-account surfaces expose mode through their composer state
			// without a mode switch. Confirm the requested state; never invent one.
			if (currentConversationMode() === mode && probeChatGPTComposer().ok) return true;
			await waitForWebsiteState(readControl, "new-conversation:mode-control-missing", diagnostic);
			if (currentConversationMode() !== mode) {
				// The website renders disabled toggles before they become interactive.
				// Clicking then is ignored; re-read the live control when it is enabled.
				const control = await waitForWebsiteState(() => {
					const control = readControl();
					return control && !control.disabled ? control : null;
				}, "new-conversation:mode-control-not-ready", diagnostic);
				control.click();
			}
			return await waitForWebsiteState(
				() => currentConversationMode() === mode && probeChatGPTComposer().ok,
				"new-conversation:mode-not-confirmed", diagnostic
			);
		} catch (error) {
			throw new Error(`${error.message}:requested=${mode}:observed=${currentConversationMode()}:composer=${probeChatGPTComposer().invariant ?? "ready"}:control-disabled=${readControl()?.disabled ?? "missing"}`);
		}
	}
	var pendingAttachmentListeners = /* @__PURE__ */ new WeakMap();
	function attachmentControl(kind) {
		const selector = kind === "image" ? SELECTORS.photos : SELECTORS.media;
		return exactlyOne(document, selector);
	}
	function isChatGPTOrigin() {
		return location.hostname === "chatgpt.com" || location.hostname.endsWith(".chatgpt.com");
	}
	function isInactiveRoute() {
		const path = location.pathname.toLowerCase();
		if (/^(\/auth|\/login|\/signup)(\/|$)/.test(path)) return true;
		return [
			"a[href*=\"/auth/login\"]",
			"a[href*=\"/auth/signup\"]",
			"button[data-testid=\"login-button\"]",
			"input[autocomplete=\"current-password\"]",
			"input[autocomplete=\"one-time-code\"]",
			"form[action*=\"/auth/\"]"
		].some((selector) => document.querySelector(selector) !== null);
	}
	function exactlyOne(root, selector) {
		const matches = root.querySelectorAll(selector);
		return matches.length === 1 ? matches[0] : null;
	}
	function countInvariant(root, selector, name) {
		const count = root.querySelectorAll(selector).length;
		return count === 1 ? null : `${name}:expected-1:found-${count}`;
	}
	function probeChatGPTComposer() {
		if (!isChatGPTOrigin()) return {
			ok: false,
			status: "unsupported",
			invariant: "origin:not-chatgpt",
			inactive: true
		};
		if (isInactiveRoute()) return {
			ok: false,
			status: "unsupported",
			invariant: "route:non-chat",
			inactive: true
		};
		const requirements = [
			[SELECTORS.thread, "thread"],
			[SELECTORS.bottom, "thread-bottom"],
			[SELECTORS.form, "thread-bottom-form"],
			[SELECTORS.editor, "prompt-textarea"]
		];
		for (const [selector, name] of requirements) {
			const invariant = countInvariant(document, selector, name);
			if (invariant) return {
				ok: false,
				status: "unsupported",
				invariant
			};
		}
		const anchors = {
			thread: exactlyOne(document, SELECTORS.thread),
			bottom: exactlyOne(document, SELECTORS.bottom),
			form: exactlyOne(document, SELECTORS.form),
			editor: exactlyOne(document, SELECTORS.editor)
		};
		if (!anchors.thread.contains(anchors.bottom) || !anchors.bottom.contains(anchors.form) || !anchors.form.contains(anchors.editor)) return {
			ok: false,
			status: "unsupported",
			invariant: "anchor-hierarchy:mismatch"
		};
		return {
			ok: true,
			status: "ready",
			anchors
		};
	}
	function uniqueControl(form, selector) {
		return exactlyOne(form, selector);
	}
	function normalizeEditorText(value) {
		return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
	}
	function editorDraftText(editor) {
		return Array.from(editor.children, (paragraph) => paragraph.textContent ?? "").join("\n");
	}
	function syncDraftToSite(text) {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		const editor = probe.anchors.editor;
		// Rich-text parsers collapse literal newlines inside text nodes. Represent
		// each line as a paragraph, including empty and trailing lines.
		const paragraphs = text.replace(/\r\n?/g, "\n").split("\n").map((line) => {
			const paragraph = document.createElement("p");
			if (line) paragraph.textContent = line;
			else paragraph.append(document.createElement("br"));
			return paragraph;
		});
		editor.replaceChildren(...paragraphs);
		editor.dispatchEvent(new InputEvent("input", {
			bubbles: true,
			inputType: "insertText",
			data: text
		}));
		editor.dispatchEvent(new Event("change", { bubbles: true }));
		return normalizeEditorText(editorDraftText(editor)) === normalizeEditorText(text);
	}
	// Native mentions use the mounted website's query/selection services. No editor
	// text, selection, focus or popup is changed while searching. The website owns
	// authentication, account-scoped caches, eligibility and search cancellation.
	var mentionSelections = new Map();
	var mentionSearchGeneration = 0;
	var mentionSearchFailure = null;
	var mentionPillFactory = null;
	function mentionError(invariant) { return new Error(`mentions:${invariant}`); }
	function websiteMentionState() {
		const editor = exactlyOne(document, SELECTORS.editor);
		if (!editor) throw mentionError("editor-unavailable");
		let host = editor;
		while (host && !Object.keys(host).some(key => key.startsWith("__reactFiber$"))) host = host.parentElement;
		if (!host) throw mentionError("react-root-unavailable");
		let root = host[Object.keys(host).find(key => key.startsWith("__reactFiber$"))];
		while (root.return) root = root.return;
		root = root.stateNode?.current;
		if (!root) throw mentionError("current-react-root-unavailable");
		const menus = new Map(), views = new Set(), stores = new Set(), accounts = new Map();
		const stack = [root];
		while (stack.length) {
			const fiber = stack.pop(), props = fiber.memoizedProps;
			if (props?.composerController && typeof props.gptsAndAppsSlashCommands$ === "function" && typeof props.onSearchQueryChange === "function") menus.set(props.composerController, props);
			if (typeof props?.value?.files$ === "function") stores.add(props.value);
			if (props?.account?.id && props.account.normalizedAccountUserId) accounts.set(`${props.account.id}:${props.account.normalizedAccountUserId}`, props.account);
			for (let hook = fiber.memoizedState; hook && Object.hasOwn(hook, "next"); hook = hook.next) {
				if (hook.memoizedState?.dom === editor && typeof hook.memoizedState.dispatch === "function") views.add(hook.memoizedState);
			}
			if (fiber.sibling) stack.push(fiber.sibling);
			if (fiber.child) stack.push(fiber.child);
		}
		if (menus.size !== 1 || views.size !== 1 || stores.size !== 1 || accounts.size !== 1) throw mentionError("composer-service-boundary-ambiguous");
		const menu = [...menus.values()][0], view = [...views][0], store = [...stores][0], account = [...accounts.values()][0];
		if (!Array.isArray(menu.fileLibraryPathSuggestions) || !Array.isArray(menu.libraryFolderPathSuggestions) || typeof store.files$.set !== "function") throw mentionError("composer-service-contract-changed");
		const scope = JSON.stringify([documentID, account.id, account.normalizedAccountUserId, menu.conversation.id, location.pathname, modelContextKey()]);
		// Upload ownership survives a model-control label change. The website remains
        // responsible for whether the current model can submit these files.
        const attachmentScope = JSON.stringify([documentID, account.id, account.normalizedAccountUserId, menu.conversation.id, location.pathname]);
        return { menu, view, store, scope, attachmentScope };
	}
	function mentionQueryKey(menu) {
		if (menu.librarySearchKey === null) return null;
		try { return JSON.parse(menu.librarySearchKey)[0]; }
		catch { throw mentionError("search-key-contract-changed"); }
	}
	function waitForMentionState(read, invariant) {
		return new Promise((resolve, reject) => {
			const deadline = Date.now() + 10000;
			function check() {
				try {
					const result = read();
					if (result) { resolve(result); return; }
					if (Date.now() >= deadline) throw mentionError(invariant);
					requestAnimationFrame(check);
				} catch (error) { reject(error); }
			}
			check();
		});
	}
	function projectMentionItem(item, kind, scope) {
		if (typeof item.id !== "string" || typeof item.title !== "string" || typeof item.onSelect !== "function") throw mentionError("candidate-contract-changed");
		const semanticKey = JSON.stringify([kind, item.id, item.title, item.insertText, item.meta]);
		for (const saved of mentionSelections.values()) {
			if (saved.scope === scope && saved.semanticKey === semanticKey) { saved.item = item; return saved.candidate; }
		}
		const selectionKey = crypto.randomUUID();
		const candidate = { id: item.id, title: item.title, subtitle: typeof item.secondary === "string" ? item.secondary : "", kind, payload: { documentID, selectionKey } };
		mentionSelections.set(selectionKey, { item, candidate, scope, semanticKey });
		return candidate;
	}
	async function searchMentions(query, cursor = null) {
		if (typeof query !== "string") throw mentionError("invalid-query");
		query = query.trim();
		if (cursor !== null) throw mentionError("website-suggestions-not-paginated");
		const generation = ++mentionSearchGeneration;
		const initial = websiteMentionState(), scope = initial.scope;
		mentionSearchFailure = null;
		// This is the same service callback used by the website's @ menu. Its
		// effect cancels the preceding request with AbortController on query change.
		initial.menu.onSearchQueryChange(query, "@", false);
		const state = await waitForMentionState(() => {
			if (generation !== mentionSearchGeneration) throw mentionError("search-superseded");
			const current = websiteMentionState();
			if (current.scope !== scope) throw mentionError("context-changed");
			if (mentionSearchFailure?.generation === generation) throw mentionError(mentionSearchFailure.invariant);
			if (!query.trim()) return current;
			return mentionQueryKey(current.menu) === query && !current.menu.isFileLibrarySearchPending ? current : null;
		}, "search-not-settled");
		const normalized = query.trim().toLocaleLowerCase();
		const pluginItems = state.menu.gptsAndAppsSlashCommands$();
		if (!Array.isArray(pluginItems)) throw mentionError("plugin-catalog-contract-changed");
		const plugins = pluginItems.filter(item => {
			if (item.meta?.isApp !== true || item.meta?.isConnected !== true || item.disabled) return false;
			if (item.meta.mention != null && (item.meta.mention.kind !== "system-hint" || item.meta.mention.representation !== "inline-pill")) throw mentionError("plugin-representation-unsupported");
			if (item.meta.mention == null && (!state.view.state.schema.marks.ecosystemMentionMark || typeof item.meta.systemHintType !== "string")) throw mentionError("legacy-plugin-contract-changed");
			if (!Array.isArray(item.searchParameters?.targets) || !item.searchParameters.targets.every(value => typeof value === "string")) throw mentionError("plugin-search-targets-missing");
			return item.searchParameters.targets.some(value => value.toLocaleLowerCase().includes(normalized));
		});
		const files = query.trim() ? state.menu.fileLibraryPathSuggestions.filter(item => !item.disabled) : [];
		const folders = query.trim() ? state.menu.libraryFolderPathSuggestions.filter(item => !item.disabled) : [];
		return { items: [...plugins.map(item => projectMentionItem(item, "plugin", scope)), ...files.map(item => projectMentionItem(item, "file", scope)), ...folders.map(item => projectMentionItem(item, "folder", scope))] };
	}
	async function invalidateMentionCache() {
		++mentionSearchGeneration;
		mentionSearchFailure = null;
		// Query caches remain account-owned by the website. Drop this adapter's
		// query state; selected draft references remain valid in the same context.
		websiteMentionState().menu.onSearchQueryChange("", undefined, false);
		await waitForMentionState(() => mentionQueryKey(websiteMentionState().menu) === null, "search-reset-not-settled");
		return true;
	}
	function mentionRequestQuery(input, init) {
		const raw = typeof input === "string" ? input : input?.url;
		if (!raw || new URL(raw, location.origin).pathname !== "/backend-api/global/search") return null;
		if (typeof init?.body !== "string") return null;
		try { const body = JSON.parse(init.body); return body.entrypoint === "composer" && typeof body.query === "string" ? body.query : null; }
		catch { return null; }
	}
	async function observeMentionSearchResponse(query, generation, response) {
		if (query === null || generation !== mentionSearchGeneration) return;
		try {
			if (!response.ok) throw mentionError("search-http-failed");
			const body = await response.clone().json();
			if (!Array.isArray(body.items) || body.partial_results || body.source_statuses?.some(source => source.status === "error" || source.provider_statuses?.some(provider => provider.status === "error"))) throw mentionError("search-incomplete");
		} catch (error) {
			if (generation === mentionSearchGeneration) mentionSearchFailure = { generation, invariant: error.message.startsWith("mentions:") ? error.message.slice(9) : "search-response-invalid" };
		}
	}
	async function websiteMentionPillFactory() {
		if (mentionPillFactory) return mentionPillFactory;
		const links = [...document.querySelectorAll('link[rel="modulepreload"]')].map(link => new URL(link.href)).filter(url => url.origin === location.origin && /^\/cdn\/assets\/conversation-small-[^/]+\.js$/.test(url.pathname));
		if (links.length !== 1) throw mentionError("pill-module-unavailable");
		const module = await import(links[0].href);
		const factories = Object.values(module).filter(value => typeof value === "function" && /mentionId:/.test(Function.prototype.toString.call(value)) && /mentionValue:/.test(Function.prototype.toString.call(value)) && /systemHintType:/.test(Function.prototype.toString.call(value)));
		if (factories.length !== 1) throw mentionError("pill-factory-contract-changed");
		mentionPillFactory = factories[0];
		return mentionPillFactory;
	}
	function validateNativeMentions(text, mentions, scope) {
		if (typeof text !== "string" || !Array.isArray(mentions)) throw mentionError("invalid-draft");
		let end = 0;
		return mentions.map(mention => {
			const { location: start, length, candidate } = mention;
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < end || length <= 0 || start + length > text.length) throw mentionError("invalid-range");
			const saved = candidate?.payload?.documentID === documentID ? mentionSelections.get(candidate.payload.selectionKey) : null;
			if (!saved || saved.scope !== scope) throw mentionError("selection-stale");
			if (candidate.id !== saved.candidate.id || candidate.title !== saved.candidate.title || text.slice(start, start + length) !== `@${saved.candidate.title}`) throw mentionError("selection-text-mismatch");
			end = start + length;
			return { start, end, saved };
		});
	}
	function buildMentionDocument(text, ranges, schema, makePill) {
		const paragraphs = [], children = [];
		function appendText(value) {
			const lines = value.replace(/\r\n?/g, "\n").split("\n");
			lines.forEach((line, index) => {
				if (index) { paragraphs.push(schema.nodes.paragraph.create(null, children.splice(0))); }
				if (line) children.push(schema.text(line));
			});
		}
		let end = 0;
		for (const range of ranges) {
			appendText(text.slice(end, range.start));
			const item = range.saved.item, mention = item.meta?.mention;
			if (mention) {
				if (mention.representation !== "inline-pill" || typeof item.insertText !== "string") throw mentionError("selection-representation-unsupported");
				const pill = makePill(schema.nodes.inline_selection_pill, { mention, mentionId: item.meta.systemHintType ?? item.id, mentionValue: item.insertText, systemHintType: item.meta.systemHintType });
				if (!pill) throw mentionError("selection-pill-invalid");
				children.push(pill);
			} else if (range.saved.candidate.kind === "plugin") {
				// The website's legacy @ path uses a marked text node, not a pill.
				const mark = schema.marks.ecosystemMentionMark;
				if (!mark || typeof item.meta.systemHintType !== "string") throw mentionError("legacy-plugin-contract-changed");
				const keyword = typeof item.insertText === "string" ? item.insertText.replace(/^@/, "").trimEnd() : item.title;
				children.push(schema.text(`@${keyword}`, [mark.create({ id: item.meta.systemHintType, keyword, kind: "at-mention", iconUrl: item.meta.mentionIconUrl, iconDarkUrl: item.meta.mentionIconDarkUrl })]));
			} else if (range.saved.candidate.kind !== "file") throw mentionError("selection-representation-unsupported");
			// Image/audio/video selections are website attachments, not inline pills.
			end = range.end;
		}
		appendText(text.slice(end));
		paragraphs.push(schema.nodes.paragraph.create(null, children));
		return schema.nodes.doc.create(null, paragraphs);
	}
	function legacyHintRows(state) {
		if (!Array.isArray(state.menu.systemHints)) throw mentionError("legacy-hint-commands-unavailable");
		const commands = [...state.menu.gptsAndAppsSlashCommands$(), ...state.menu.systemHints];
		if (state.menu.thinkingSlashCommand) commands.push(state.menu.thinkingSlashCommand);
		const rows = new Map();
		for (const item of commands) {
			if (typeof item.meta?.systemHintType !== "string") continue;
			if (typeof item.onSelect !== "function") throw mentionError("legacy-hint-callback-unavailable");
			rows.set(item.meta.systemHintType, item);
		}
		return rows;
	}
	function selectedLegacyHints(state) {
		return new Set([...legacyHintRows(state)].filter(([, item]) => item.color === "selected").map(([id]) => id));
	}
	function sameMentionIDs(left, right) { return left.size === right.size && [...left].every(id => right.has(id)); }
	async function setLegacyHintSelected(scope, id, selected) {
		const state = websiteMentionState();
		if (state.scope !== scope) throw mentionError("context-changed");
		const row = legacyHintRows(state).get(id);
		if (!row || row.disabled) throw mentionError("legacy-hint-no-longer-available");
		if ((row.color === "selected") === selected) return;
		row.onSelect();
		await waitForMentionState(() => {
			const current = websiteMentionState();
			if (current.scope !== scope) throw mentionError("context-changed");
			return selectedLegacyHints(current).has(id) === selected;
		}, "legacy-hint-selection-not-confirmed");
	}
	async function prepareNativeMentions(text, mentions) {
		const state = websiteMentionState(), ranges = validateNativeMentions(text, mentions, state.scope);
		const factory = ranges.some(range => range.saved.item.meta?.mention != null) ? await websiteMentionPillFactory() : null;
		if (websiteMentionState().scope !== state.scope) throw mentionError("context-changed");
		const doc = buildMentionDocument(text, ranges, state.view.state.schema, factory);
		const previousDoc = state.view.state.doc, previousFiles = state.store.files$();
		const legacy = ranges.filter(range => range.saved.candidate.kind === "plugin" && range.saved.item.meta?.mention == null);
		const previousHints = legacy.length ? selectedLegacyHints(state) : null;
		async function rollback() {
			if (websiteMentionState().scope !== state.scope) return;
			if (previousHints !== null) {
				for (const id of selectedLegacyHints(websiteMentionState())) if (!previousHints.has(id)) await setLegacyHintSelected(state.scope, id, false);
				for (const id of previousHints) await setLegacyHintSelected(state.scope, id, true);
				if (!sameMentionIDs(previousHints, selectedLegacyHints(websiteMentionState()))) throw mentionError("legacy-hint-rollback-mismatch");
			}
			state.view.dispatch(state.view.state.tr.replaceWith(0, state.view.state.doc.content.size, previousDoc.content));
			state.store.files$.set(previousFiles);
		}
		try {
			state.view.dispatch(state.view.state.tr.replaceWith(0, state.view.state.doc.content.size, doc.content));
			for (const { saved } of legacy) await setLegacyHintSelected(state.scope, saved.item.meta.systemHintType, true);
			const selected = new Set();
			// Website createDraft/submit calls uF(doc), whose fF/nHt serializers
			// emit custom_symbol_offsets directly from inline system-hint pills.
			// Folder references are also derived from doc (dF). Their UI callbacks
			// are unnecessary for inline pills; legacy-mark plugins above also need
			// the website's selected-hint state. Files register in the attachment store.
			for (const { saved } of ranges.filter(range => range.saved.candidate.kind === "file")) {
				if (!selected.has(saved.candidate.id)) { saved.item.onSelect(); selected.add(saved.candidate.id); }
			}
			await waitForMentionState(() => {
				if (websiteMentionState().scope !== state.scope) throw mentionError("context-changed");
				if (!state.view.state.doc.eq(doc)) throw mentionError("prepared-document-changed");
				if (state.store.chatUploadLimitError$()) throw mentionError("attachment-limit");
				for (const { saved } of ranges.filter(range => range.saved.candidate.kind === "file")) {
					const id = saved.item.id.slice("file-library:".length);
					const file = state.store.files$().find(file => file.fileId === id || file.mountedLibraryFileId === id || file.libraryFileId === id);
					if (!file) throw mentionError("attachment-not-registered");
					if (file.status === "error" || file.status === "failed") throw mentionError("attachment-failed");
					if (file.status !== "ready") return false;
				}
				return true;
			}, "attachments-not-ready");
			return { rollback, attachmentFiles: ranges.filter(range => range.saved.candidate.kind === "file").map(({saved}) => {
                const id = saved.item.id.slice("file-library:".length);
                return state.store.files$().find(file => file.fileId === id || file.mountedLibraryFileId === id || file.libraryFileId === id);
            }), verify: () => websiteMentionState().scope === state.scope && state.view.state.doc.eq(doc) && legacy.every(({saved}) => selectedLegacyHints(websiteMentionState()).has(saved.item.meta.systemHintType)) && ranges.filter(range => range.saved.candidate.kind === "file").every(({ saved }) => {
				const id = saved.item.id.slice("file-library:".length);
				return state.store.files$().some(file => (file.fileId === id || file.mountedLibraryFileId === id || file.libraryFileId === id) && file.status === "ready");
			}) };
		} catch (error) { await rollback(); throw error; }
	}
	// Native attachments retain local identity while the website owns upload and removal.
	var nativeAttachments = new Map();
	var submittedAttachmentIDs = new Set();
    function websiteAttachmentState() {
        const state = websiteMentionState();
        return {scope: state.attachmentScope, store: state.store};
    }
	function attachmentError(invariant) { return new Error(`attachments:${invariant}`); }
	function attachmentFiberRoot() {
		let host = exactlyOne(document, SELECTORS.editor);
		while (host && !Object.keys(host).some(key => key.startsWith("__reactFiber$"))) host = host.parentElement;
		if (!host) throw attachmentError("editor-unavailable");
		let root = host[Object.keys(host).find(key => key.startsWith("__reactFiber$"))];
		while (root.return) root = root.return;
		if (!root.stateNode?.current) throw attachmentError("react-root-unavailable");
		return root.stateNode.current;
	}
    // The website exposes callable upload signals, not an event subscription.
    // Observe those signals while uploads are pending; hidden transport DOM is
    // not a reliable notification source (an existing conversation can complete
    // an upload without changing any observed DOM attribute).
    var attachmentObservationFrame = null;
    function attachmentUploadState(saved) {
        const file = saved.store.files$().find(item => item.file === saved.file || (saved.tempId && item.tempId === saved.tempId));
        return JSON.stringify([file?.tempId, file?.status, !!saved.store.chatUploadLimitError$()]);
    }
    function ensureAttachmentObservation() {
        if (attachmentObservationFrame === null && [...nativeAttachments.values()].some(saved => saved.pending)) {
            attachmentObservationFrame = requestAnimationFrame(observeNativeAttachmentState);
        }
    }
    function observeNativeAttachmentState() {
        attachmentObservationFrame = null;
        let changed = false;
        for (const saved of nativeAttachments.values()) {
            if (!saved.pending) continue;
            try { if (attachmentUploadState(saved) !== saved.observedUploadState) changed = true; }
            catch { changed = true; }
        }
        if (changed) reportNativeState(isGenerating() ? "generating" : "ready");
        ensureAttachmentObservation();
    }
    // Diagnostic sampling is independent of DOM mutations: a hidden composer can
    // stop emitting DOM changes while its upload store continues to change.
    // Never include names, paths, file contents, server IDs, or raw errors.
    var attachmentDiagnosticTimer = null;
    function reportAttachmentDiagnostic(id, stage) {
        const saved = nativeAttachments.get(id);
        if (!saved) return;
        let rawStatus = "unregistered", registered = false, scopeMatches = false, limit = false;
        try {
            const state = websiteAttachmentState();
            scopeMatches = state.scope === saved.scope;
            const file = state.store.files$().find(item => item.file === saved.file || (saved.tempId && item.tempId === saved.tempId));
            registered = !!file;
            if (file) rawStatus = ["ready", "uploading", "failed", "error"].includes(file.status) ? file.status : "unknown";
            limit = !!state.store.chatUploadLimitError$();
        } catch { rawStatus = "unavailable"; }
        const diagnostic = {
            id: /^[0-9a-f-]{36}$/i.test(id) ? id : "restored",
            stage, rawStatus, registered, scopeMatches, limit,
            bytes: saved.file.size,
            elapsedMS: Math.round(performance.now() - (saved.startedAt ?? performance.now()))
        };
        window.webkit?.messageHandlers?.swiftChatConversationAdapterStatus?.postMessage({
            state: "attachment-diagnostic", documentID, adapterVersion: ADAPTER_VERSION,
            attachmentDiagnostic: diagnostic
        });
        return rawStatus;
    }
    function sampleAttachmentDiagnostics() {
        attachmentDiagnosticTimer = null;
        let pending = false;
        for (const [id, saved] of nativeAttachments) {
            if (saved.diagnosticFinished) continue;
            const status = reportAttachmentDiagnostic(id, "sample");
            saved.diagnosticFinished = ["ready", "failed", "error"].includes(status);
            if (!saved.diagnosticFinished) pending = true;
        }
        // This timer observes only; it does not retry, time out, or change draft state.
        if (pending) attachmentDiagnosticTimer = setTimeout(sampleAttachmentDiagnostics, 10000);
    }
    function startAttachmentDiagnostics() {
        if (attachmentDiagnosticTimer === null) attachmentDiagnosticTimer = setTimeout(sampleAttachmentDiagnostics, 10000);
    }
	function nativeAttachmentSnapshot() {
		const state = websiteAttachmentState();
		const files = state.store.files$();
		for (const id of submittedAttachmentIDs) {
			if (!files.some(file => file.tempId === id)) submittedAttachmentIDs.delete(id);
		}
		// A reload can restore website-owned draft files. Project their metadata,
		// so a file can never be silently sent just because native memory reset.
		if (!nativeSubmissionInFlight) {
			for (const file of files) {
				if (submittedAttachmentIDs.has(file.tempId) || [...nativeAttachments.values()].some(saved =>
				    saved.file === file.file || saved.tempId === file.tempId)) continue;
				if (typeof file.tempId !== "string" || typeof file.file?.name !== "string" ||
				    typeof file.file.type !== "string" || !Number.isSafeInteger(file.file.size)) throw attachmentError("restored-file-metadata-unavailable");
				nativeAttachments.set(`website:${file.tempId}`, {scope: state.scope, file: file.file,
				    tempId: file.tempId, restored: {name: file.file.name, mimeType: file.file.type, size: file.file.size}});
			}
		}
		return [...nativeAttachments].map(([id, saved]) => {
			const project = value => ({...value, ...saved.restored});
			const snapshot = () => {
			if (saved.scope !== state.scope) return {id, status: "failed", error: "Attachment belongs to a different conversation or model. Remove it and add it again."};
			const file = state.store.files$().find(file => file === saved.file || file.file === saved.file || (saved.tempId && file.tempId === saved.tempId));
			if (!file && !saved.tempId) return saved.error ? {id, status: "failed", error: saved.error} : {id, status: "preparing"};
			if (file) saved.tempId = file.tempId;
			if (!file) return {id, status: "failed", error: "ChatGPT no longer has this attachment. Remove it and add it again."};
			if (state.store.chatUploadLimitError$()) return {id, status: "failed", error: "ChatGPT's attachment limit was reached. Remove an attachment before sending."};
			if (file.status === "ready") return {id, status: "ready"};
			if (file.status === "uploading") return {id, status: "uploading"};
			if (["error", "failed"].includes(file.status)) return {id, status: "failed", error: "ChatGPT could not upload this attachment. Retry or remove it."};
			return {id, status: "failed", error: "ChatGPT returned an unsupported attachment state."};
			};
            const value = snapshot();
            saved.store = state.store;
            saved.pending = ["preparing", "uploading"].includes(value.status);
            saved.observedUploadState = attachmentUploadState(saved);
            ensureAttachmentObservation();
			return project(value);
		});
	}
	function nativeAttachmentReport() {
		try { return nativeAttachmentSnapshot(); }
        catch {
            for (const saved of nativeAttachments.values()) saved.pending = false;
            return [...nativeAttachments.keys()].map(id => ({id, status: "failed", error: "ChatGPT's attachment service changed or is unavailable. Remove the attachment and add it again."}));
        }
	}
	async function importNativeAttachment(id, name, mimeType, base64) {
		if (nativeSubmissionInFlight) throw attachmentError("submission-in-flight");
		if (nativeAttachments.has(id)) throw attachmentError("duplicate-identity");
		const state = websiteAttachmentState();
		const image = mimeType.startsWith("image/");
		const input = image ? attachmentControl("image") : exactlyOne(exactlyOne(document, SELECTORS.form), 'input[type="file"]:not([accept]), input[type="file"][accept=""]');
		if (!input || input.disabled || (image && input.accept !== "image/*")) throw attachmentError("upload-control-unavailable");
		const file = new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, {type: mimeType});
		const transfer = new DataTransfer();
		transfer.items.add(file);
		const saved = {scope: state.scope, file, tempId: null, startedAt: performance.now()};
		nativeAttachments.set(id, saved);
        reportAttachmentDiagnostic(id, "dispatch");
        startAttachmentDiagnostics();
		const form = exactlyOne(document, SELECTORS.form);
		activateWebsiteComposer(form);
		try {
			input.files = transfer.files;
			input.dispatchEvent(new Event("input", {bubbles: true}));
			input.dispatchEvent(new Event("change", {bubbles: true}));
			await waitForWebsiteState(() => {
				const current = websiteAttachmentState();
				if (current.scope !== saved.scope) throw attachmentError("context-changed");
				const registered = current.store.files$().filter(item => item.file === file);
				if (registered.length > 1) throw attachmentError("upload-identity-ambiguous");
				if (registered.length !== 1) return false;
				if (typeof registered[0].tempId !== "string") throw attachmentError("upload-identity-missing");
				saved.tempId = registered[0].tempId;
                reportAttachmentDiagnostic(id, "registered");
				return true;
			}, "attachments:upload-not-registered");
			return nativeAttachmentSnapshot();
		} catch (error) {
			reportAttachmentDiagnostic(id, "import-failed");
			saved.error = "ChatGPT did not confirm this attachment. Remove it and add it again.";
			throw error;
		} finally { hideWebsiteComposer(form); }
	}
	async function removeNativeAttachment(id) {
		if (nativeSubmissionInFlight) throw attachmentError("submission-in-flight");
		const saved = nativeAttachments.get(id);
        if (saved) reportAttachmentDiagnostic(id, "remove");
		if (!saved) return true; // Import failed before the website registered this item.
		const state = websiteAttachmentState();
		const registered = state.store.files$().find(file => file.file === saved.file || (saved.tempId && file.tempId === saved.tempId));
		if (registered) saved.tempId = registered.tempId;
		if (!registered && !saved.tempId) throw attachmentError("registration-unresolved-reload-conversation");
		if (!registered) { nativeAttachments.delete(id); return true; }
		const callbacks = new Set(), stack = [attachmentFiberRoot()];
		while (stack.length) {
			const fiber = stack.pop(), props = fiber.memoizedProps;
			if (props?.tempId === saved.tempId && typeof props.onRemove === "function") callbacks.add(props.onRemove);
			if (fiber.child) stack.push(fiber.child);
			if (fiber.sibling) stack.push(fiber.sibling);
		}
		if (callbacks.size !== 1) throw attachmentError("remove-control-unavailable");
		[...callbacks][0]();
		if (state.store.files$().some(file => file.tempId === saved.tempId)) throw attachmentError("removal-not-confirmed");
		nativeAttachments.delete(id);
		return true;
	}
	function verifyNativeAttachments(ids, mentionFiles = []) {
		if (new Set(ids).size !== ids.length || ids.length !== nativeAttachments.size || ids.some(id => !nativeAttachments.has(id))) throw attachmentError("draft-identity-mismatch");
		if (nativeAttachmentSnapshot().some(item => item.status !== "ready")) throw attachmentError("not-ready");
        const files = websiteAttachmentState().store.files$();
        if (files.some(file => ![...nativeAttachments.values()].some(saved => saved.tempId === file.tempId) &&
            !mentionFiles.some(mention => mention === file || (mention.tempId && mention.tempId === file.tempId)))) {
            throw attachmentError("unreviewed-website-attachment");
        }
	}
	function forwardSend() {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		const button = uniqueControl(probe.anchors.form, SELECTORS.send);
		if (!button || button.disabled) return false;
		button.click();
		return true;
	}
	function forwardAttachmentPicker$1(kind) {
		if (!probeChatGPTComposer().ok) return false;
		const control = attachmentControl(kind);
		if (!control) return false;
		const pending = pendingAttachmentListeners.get(control);
		if (pending) control.removeEventListener("change", pending);
		const reportSelection = () => {
			pendingAttachmentListeners.delete(control);
			window.dispatchEvent(new CustomEvent("swiftchat:attachment-selection", { detail: {
				kind,
				count: control.files?.length ?? 0
			} }));
		};
		pendingAttachmentListeners.set(control, reportSelection);
		control.addEventListener("change", reportSelection, { once: true });
		control.click();
		return true;
	}
	function isGenerating() {
		const probe = probeChatGPTComposer();
		return probe.ok && uniqueControl(probe.anchors.form, SELECTORS.stop) !== null;
	}
	function forwardStop() {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		const button = uniqueControl(probe.anchors.form, SELECTORS.stop);
		if (!button || button.disabled) return false;
		button.click();
		return true;
	}
	function forwardModelControl() {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		const button = uniqueControl(probe.anchors.form, SELECTORS.modelControl);
		if (!button || button.disabled) return false;
		button.focus({ preventScroll: true });
		button.dispatchEvent(new PointerEvent("pointerdown", {
			bubbles: true,
			button: 0,
			buttons: 1,
			pointerType: "mouse",
			isPrimary: true
		}));
		button.dispatchEvent(new MouseEvent("mousedown", {
			bubbles: true,
			button: 0,
			buttons: 1
		}));
		button.dispatchEvent(new PointerEvent("pointerup", {
			bubbles: true,
			button: 0,
			buttons: 0,
			pointerType: "mouse",
			isPrimary: true
		}));
		button.dispatchEvent(new MouseEvent("mouseup", {
			bubbles: true,
			button: 0,
			buttons: 0
		}));
		button.dispatchEvent(new MouseEvent("click", {
			bubbles: true,
			button: 0
		}));
		return true;
	}
	function isModelControlExpanded() {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		return uniqueControl(probe.anchors.form, SELECTORS.modelControl)?.getAttribute("aria-expanded") === "true";
	}
	function activeModelMenu() {
		const menus = Array.from(document.querySelectorAll("[role=\"menu\"]")).filter((menu) => menu.dataset.state !== "closed" && menu.style.display !== "none");
		return menus.length === 1 ? menus[0] : null;
	}
	function isModelMenuVisible() {
		const menu = activeModelMenu();
		return menu !== null && menu.getAttribute("aria-hidden") !== "true";
	}
	function suppressActiveModelMenu() {
		const menu = activeModelMenu();
		if (!menu) return false;
		menu.setAttribute("aria-hidden", "true");
		menu.dataset.swiftchatModelTransport = "true";
		return true;
	}
	function currentModelControlSnapshot() {
		const probe = probeChatGPTComposer();
		const menu = activeModelMenu();
		if (!probe.ok || !menu) return null;
		const models = Array.from(menu.querySelectorAll("[role=\"menuitemradio\"]")).map((choice) => ({
			label: choice.textContent?.trim() ?? "",
			selected: choice.getAttribute("aria-checked") === "true" || choice.dataset.state === "checked"
		}));
		const labels = models.map((model) => model.label);
		const sliders = menu.querySelectorAll("[role=\"slider\"]");
		if (models.length === 0 || labels.some((label) => !label)) return null;
		if (new Set(labels).size !== labels.length || models.filter((model) => model.selected).length !== 1) return null;
		const selectedIndex = models.findIndex((model) => model.selected);
		const selectedLabel = models[selectedIndex]?.label ?? "";
		const modelName = /^GPT-[0-9]/u.test(selectedLabel) ? selectedLabel : models.slice(selectedIndex + 1).find((model) => /^GPT-[0-9]/u.test(model.label))?.label ?? "";
		if (!modelName) return null;
		const reasoning = reasoningControl();
		if (sliders.length !== 1 || !reasoning) return null;
		const slider = sliders[0];
		const value = Number(slider.getAttribute("aria-valuenow"));
		const minimum = Number(slider.getAttribute("aria-valuemin"));
		const maximum = Number(slider.getAttribute("aria-valuemax"));
		if (![
			value,
			minimum,
			maximum
		].every(Number.isSafeInteger) || value < minimum || value > maximum) return null;
		const effortLabel = (reasoning.item.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").find((description) => /^.+?[,，]/u.test(description))?.match(/^(.+?)[,，]/u)?.[1]?.trim() ?? "";
		if (!effortLabel) return null;
		return {
			modelName,
			effortLabel,
			models,
			reasoning: {
				value,
				minimum,
				maximum
			}
		};
	}
	function chooseModelByUniqueLabel(label) {
		const menu = activeModelMenu();
		if (!menu) return false;
		const matches = Array.from(menu.querySelectorAll("[role=\"menuitemradio\"]")).filter((choice) => choice.textContent?.trim() === label);
		if (matches.length !== 1) return false;
		matches[0].click();
		return true;
	}
	function reasoningControl() {
		const menu = activeModelMenu();
		if (!menu) return null;
		const sliders = menu.querySelectorAll("[role=\"slider\"]");
		const items = menu.querySelectorAll("[role=\"menuitem\"][aria-keyshortcuts~=\"ArrowLeft\"][aria-keyshortcuts~=\"ArrowRight\"]");
		return sliders.length === 1 && items.length === 1 ? {
			item: items[0],
			slider: sliders[0]
		} : null;
	}

	var CONVERSATION_LIST_PATH = "/backend-api/conversations";
	var CONVERSATION_PATH = /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
	var HISTORY_EVENT = "swiftchat:history-response";
	var projection = { state: "loading" };
	var observerInstalled = false;
	var historyPages = new Map();
	var pendingHistoryPage = null;
	function unsupported(invariant) {
		return {
			state: "unsupported",
			invariant
		};
	}
	function exactConversationID(value) {
		if (typeof value !== "string" || !CONVERSATION_PATH.test(`/c/${value}`)) return null;
		return value.toLowerCase();
	}
	function historyConversationPath(id) {
		const normalizedID = exactConversationID(id);
		if (!normalizedID || projection.state !== "ready") return null;
		return projection.items.some((item) => item.id === normalizedID) ? `/c/${normalizedID}` : null;
	}
	function parseConversationListResponse(responseURL, payload) {
		const url = new URL(responseURL, location.origin);
		if (url.origin !== location.origin || url.pathname !== CONVERSATION_LIST_PATH) return null;
		if (url.searchParams.get("is_archived") !== "false" || url.searchParams.get("is_starred") !== "false") return null;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return unsupported("history-response:expected-object");
		const object = payload;
		if (!Array.isArray(object.items)) return unsupported("history-response:items-not-array");
		if (!Number.isSafeInteger(object.limit) || object.limit < 0) return unsupported("history-response:limit-invalid");
		if (!Number.isSafeInteger(object.offset) || object.offset < 0) return unsupported("history-response:offset-invalid");
		if (!Number.isSafeInteger(object.total) || object.total < 0) return unsupported("history-response:total-invalid");
		const items = [];
		const seen = /* @__PURE__ */ new Set();
		for (const rawItem of object.items) {
			if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return unsupported("history-response:item-not-object");
			const item = rawItem;
			const mode = modeForOrigin(item);
			if (typeof item.id === "string") conversationModes.set(item.id.toLowerCase(), mode);
			const id = exactConversationID(item.id);
			const title = typeof item.title === "string" ? item.title.trim() : "";
			if (!id) return unsupported("history-response:item-id-invalid");
			if (!title) return unsupported(`history-response:item-title-missing:${id}`);
			if (seen.has(id)) return unsupported(`history-response:item-id-duplicate:${id}`);
			seen.add(id);
			items.push({
				id,
				title
			});
		}
		if (object.offset + items.length > object.total) return unsupported("history-response:page-exceeds-total");
		return {
			items,
			limit: object.limit,
			offset: object.offset,
			total: object.total
		};
	}
	function activeConversationID() {
		return location.pathname.match(CONVERSATION_PATH)?.[1]?.toLowerCase() ?? null;
	}
	function project(page) {
		const activeID = activeConversationID();
		const items = page.items.map((item) => ({
			...item,
			path: `/c/${item.id}`,
			active: item.id === activeID
		}));
		return {
			state: "ready",
			items,
			activeConversationID: items.some((item) => item.active) ? activeID : null,
			hasMore: page.hasMore
		};
	}
	function publish(next) {
		projection = next;
		window.dispatchEvent(new CustomEvent(HISTORY_EVENT));
	}
	async function ingestHistoryResponse(response) {
		let payload;
		try {
			const url = new URL(response.url, location.origin);
			if (url.origin !== location.origin || url.pathname !== CONVERSATION_LIST_PATH) return;
			payload = await response.clone().json();
		} catch {
			return;
		}
		const result = parseConversationListResponse(response.url, payload);
		if (!result) return;
		if ("state" in result) {
			pendingHistoryPage?.finish(new Error(result.invariant));
			return;
		}
		if (pendingHistoryPage && result.offset === pendingHistoryPage.offset && result.items.length === 0) {
			pendingHistoryPage.finish(new Error("history-load:empty-page"));
			return;
		}
		if (result.offset === 0) historyPages.clear();
		historyPages.set(result.offset, result);
		const merged = new Map();
		let nextOffset = 0;
		let total = result.total;
		while (historyPages.has(nextOffset)) {
			const page = historyPages.get(nextOffset);
			for (const item of page.items) merged.set(item.id, item);
			total = page.total;
			if (page.items.length === 0) break;
			nextOffset += page.items.length;
		}
		publish(project({ items: [...merged.values()], hasMore: nextOffset < total }));
		if (pendingHistoryPage && nextOffset > pendingHistoryPage.offset) pendingHistoryPage.finish();
	}
	// A one-shot context lease belongs to a verified native Chat submission only.
	var pendingAppContext = null;
	var appContextTransportBlocked = false;
	function contextError(code) { return new Error("app-context:" + code); }
	function armAppContext(text, context) {
		if (appContextTransportBlocked) throw contextError("delivery-uncertain-reload-before-sending");
		if (pendingAppContext) throw contextError("submission-in-flight");
		if (currentConversationMode() !== "chat") throw contextError("requires-confirmed-chat-mode");
		let resolve, reject;
		const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
		// The website may reject its send before issuing fetch. Do not retain source
		// text indefinitely or let a late request silently send without context.
		const lease = {text, context, conversationID: activeConversationID(), claimed:false, promise,
			finish(error) {
				if (pendingAppContext !== lease) return;
				clearTimeout(lease.timer);
				pendingAppContext = null;
				lease.context = "";
				error ? reject(error) : resolve(true);
			}};
		lease.timer = setTimeout(() => {
			appContextTransportBlocked = true;
			lease.finish(contextError("delivery-uncertain-reload-before-sending"));
		}, 10000);
		// Observe rejection even if the DOM send fails before awaiting the lease.
		promise.catch(() => {});
		pendingAppContext = lease;
		return lease;
	}
	async function fetchWithAppContext(pageFetch, receiver, input, init) {
		const url = new URL(input instanceof Request ? input.url : input, location.href);
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const isSend = url.origin === location.origin && method.toUpperCase() === "POST"
			&& ["/backend-api/f/conversation", "/backend-api/conversation"].includes(url.pathname);
		if (!isSend) return pageFetch.call(receiver, input, init);
		if (appContextTransportBlocked) throw contextError("delivery-uncertain-reload-before-sending");
		const lease = pendingAppContext;
		if (!lease) return pageFetch.call(receiver, input, init);
		if (lease.claimed) throw contextError("duplicate-request");
		try {
			lease.claimed = true;
			const raw = init?.body !== undefined ? init.body : input instanceof Request ? await input.clone().text() : null;
			if (typeof raw !== "string") throw contextError("unsupported-request-body");
			const body = JSON.parse(raw);
			const messages = body.messages;
			if (!Array.isArray(messages) || messages.length !== 1
				|| messages[0].author?.role !== "user" || messages[0].content?.content_type !== "text"
				|| !Array.isArray(messages[0].content.parts) || !messages[0].content.parts.every(p => typeof p === "string")
				|| normalizeEditorText(messages[0].content.parts.join("")) !== normalizeEditorText(lease.text)) {
				throw contextError("request-draft-mismatch");
			}
			if ((body.conversation_id ?? null) !== lease.conversationID
				|| body.conversation_origin === "tpp" || body.conversation_mode?.kind !== "primary_assistant") {
				throw contextError("request-conversation-mismatch");
			}
			if (pendingAppContext !== lease || appContextTransportBlocked) throw contextError("submission-expired");
			if (lease.conversationID !== null && activeConversationID() !== lease.conversationID
				|| lease.conversationID === null && location.pathname !== "/" && !location.pathname.startsWith("/c/WEB:")) {
				throw contextError("conversation-changed");
			}
			if (location.pathname === "/" && currentConversationMode() !== "chat") throw contextError("requires-confirmed-chat-mode");
			body.messages.unshift({id:crypto.randomUUID(), author:{role:"user"},
				content:{content_type:"text", parts:[lease.context]},
				metadata:{is_visually_hidden_from_conversation:true}});
			url.pathname = "/backend-api/conversation";
			const target = input instanceof Request ? new Request(url.href, input) : url.href;
			const response = await pageFetch.call(receiver, target, {...init, body:JSON.stringify(body)});
			if (!response.ok) throw contextError("http-" + response.status);
			if (!response.headers.get("content-type")?.includes("text/event-stream")) throw contextError("unexpected-response-type");
			lease.finish();
			return response;
		} catch (error) {
			lease.finish(error instanceof SyntaxError ? contextError("invalid-request-json") : error);
			throw error;
		}
	}
	async function observeNativeThinkingRequest(input, init) {
		const report = nativeThinkingSendDiagnostic;
		if (!report) return;
		let matched = false;
		try {
			const target = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
			if (!/\/backend-api\/(?:f\/)?conversation$/.test(new URL(target, location.href).pathname)) return;
			matched = true;
			nativeThinkingSendDiagnostic = null;
			const raw = typeof init?.body === "string" ? init.body : init?.body == null && input instanceof Request ? await input.clone().text() : null;
			const body = raw === null ? null : JSON.parse(raw);
			const hasReason = value => value !== null && typeof value === "object" && Object.entries(value).some(([key, child]) => key === "system_hints" && Array.isArray(child) && child.includes("reason") || hasReason(child));
			report(body ? (hasReason(body) ? "send.request.reason-on" : "send.request.reason-off") : "send.request.unobserved", "end");
		} catch {
			// Observation, including a failed reporter, must never reject fetch.
			if (matched) { try { report("send.request.unobserved", "end"); } catch {} }
		}
	}
	function installHistoryResponseObserver() {
		if (observerInstalled) return;
		observerInstalled = true;
		const pageFetch = window.fetch;
		window.fetch = async function(input, init) {
			void observeNativeThinkingRequest(input, init);
			const query = mentionRequestQuery(input, init), generation = mentionSearchGeneration;
			let response;
			try { response = await fetchWithAppContext(pageFetch, this, input, init); }
			catch (error) {
				if (query !== null && error.name !== "AbortError" && generation === mentionSearchGeneration) mentionSearchFailure = { generation, invariant: "search-network-failed" };
				throw error;
			}
			await observeMentionSearchResponse(query, generation, response);
			ingestHistoryResponse(response);
			return response;
		};
	}
	function currentHistoryProjection() {
		if (projection.state !== "ready") return projection;
		const activeID = activeConversationID();
		const items = projection.items.map((item) => ({
			...item,
			active: item.id === activeID
		}));
		return {
			state: "ready",
			items,
			activeConversationID: items.some((item) => item.active) ? activeID : null,
			hasMore: projection.hasMore
		};
	}
	async function loadMoreHistory() {
		if (pendingHistoryPage) return pendingHistoryPage.promise;
		if (projection.state !== "ready" || !projection.hasMore) return false;
		const sidebars = document.querySelectorAll("#stage-slideover-sidebar");
		if (sidebars.length !== 1) throw new Error("history-load:sidebar-missing");
		const sidebar = sidebars[0];
		const scrollports = [...sidebar.querySelectorAll("nav")].filter((nav) =>
			nav.querySelector('a[href^="/c/"]') && getComputedStyle(nav).overflowY === "auto");
		if (scrollports.length !== 1) throw new Error("history-load:scrollport-missing");
		const scrollport = scrollports[0];
		const style = sidebar.getAttribute("style");
		const top = scrollport.scrollTop;
		let offset = 0;
		while (historyPages.get(offset)?.items.length) offset += historyPages.get(offset).items.length;
		let finish;
		const promise = new Promise((resolve, reject) => {
			finish = (error) => {
				clearTimeout(timer);
				if (style === null) sidebar.removeAttribute("style");
				else sidebar.setAttribute("style", style);
				scrollport.scrollTop = top;
				pendingHistoryPage = null;
				if (error) reject(error); else resolve(true);
			};
		});
		// A missing response must release the transport and allow an explicit retry.
		const timer = setTimeout(() => finish(new Error("history-load:response-timeout")), 15000);
		pendingHistoryPage = { offset, promise, finish };
		// Keep the site's IntersectionObserver layout alive without showing its sidebar.
		for (const [key, value] of Object.entries({display: "block", position: "fixed",
			left: "0", top: "0", width: "260px", height: "100vh", opacity: "0",
			"pointer-events": "none", "z-index": "-1"})) sidebar.style.setProperty(key, value, "important");
		scrollport.scrollTop = 0;
		requestAnimationFrame(() => requestAnimationFrame(() => {
			if (pendingHistoryPage?.promise === promise) scrollport.scrollTop = scrollport.scrollHeight;
		}));
		return promise;
	}
	function observeHistoryProjection(listener) {
		window.addEventListener(HISTORY_EVENT, listener);
		return () => window.removeEventListener(HISTORY_EVENT, listener);
	}
	function openHistoryConversation(id) {
		const path = historyConversationPath(id);
		if (!path) return false;
		submittedHomeMode = null;
		history.pushState({}, "", path);
		window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
		return true;
	}

	var observer = null;
	var reconcileQueued = false;
	var hiddenWebsiteChrome = [];
	var hiddenTransport = [];
	var transparentConversationSurface = [];
	var lastHistoryReport = "";
	var stopObservingHistory = null;
	var nativeBottomGap = 52;
	function markTransparentConversationSurface(thread) {
		const surface = [];
		let element = thread;
		while (element) {
			surface.push(element);
			if (element === document.documentElement) break;
			element = element.parentElement;
		}
		if (surface.at(-1) !== document.documentElement) return false;
		for (const previous of transparentConversationSurface) previous.removeAttribute("data-swiftchat-transparent-conversation-surface");
		transparentConversationSurface = surface;
		for (const current of transparentConversationSurface) current.setAttribute("data-swiftchat-transparent-conversation-surface", "true");
		return true;
	}
	var documentScrollState = null;
	function stopDocumentScrolling() {
		if (!documentScrollState) return;
		documentScrollState.resize.disconnect();
		document.removeEventListener("scroll", documentScrollState.onScroll);
		cancelAnimationFrame(documentScrollState.frame);
		documentScrollState = null;
		document.documentElement.removeAttribute("data-swiftchat-document-scroll");
	}
	function mountDocumentScrolling(thread) {
		if (window.__SwiftChatNativeDocumentScrolling !== true) return;
		if (documentScrollState?.thread === thread && documentScrollState.path === location.pathname) return;
		// Measure before restoring the inner scrollport; restoration clamps window.scrollY.
		const root = document.scrollingElement;
		const previous = documentScrollState?.thread === thread ? documentScrollState : null;
		const offset = previous ? root.scrollTop : Math.max(0, -thread.getBoundingClientRect().top);
		const wasFollowing = previous?.following;
		stopDocumentScrolling();
		const state = { thread, path: location.pathname, following: false, frame: 0, resize: null, onScroll: null };
		const atBottom = () => root.scrollHeight - root.clientHeight - root.scrollTop <= 26;
		state.onScroll = () => { state.following = atBottom(); };
		state.resize = new ResizeObserver(() => {
			if (!state.following) return;
			cancelAnimationFrame(state.frame);
			state.frame = requestAnimationFrame(() => {
				if (documentScrollState === state && state.following) root.scrollTop = root.scrollHeight;
			});
		});
		documentScrollState = state;
		document.documentElement.setAttribute("data-swiftchat-document-scroll", "true");
		state.frame = requestAnimationFrame(() => {
			root.scrollTop = offset;
			state.following = wasFollowing ?? atBottom();
			document.addEventListener("scroll", state.onScroll, { passive: true });
			state.resize.observe(thread);
		});
	}
	function applyNativeViewportSpacing() {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		if (!markTransparentConversationSurface(probe.anchors.thread)) return false;
		mountDocumentScrolling(probe.anchors.thread);
		const styleID = "swiftchat-native-viewport-style";
		let style = document.getElementById(styleID);
		if (!style) {
			style = document.createElement("style");
			style.id = styleID;
			style.textContent = `
      /* Hiding the website sidebar does not change its data-state. Its
         navigation width must not constrain flyouts inside the native shell. */
      .stage-layout[data-swiftchat-transparent-conversation-surface] {
        --stage-navigation-width: 0px !important;
      }
      /* The website reserves a separate right-hand rail even when it is empty.
         Collapse only the observed empty rail, not populated side panels. */
      html[data-swiftchat-transparent-conversation-surface]
        #main + div[class~="w-[calc(300px+2rem)]"]:empty {
        display: none !important;
      }
      #thread {
        padding-bottom: var(--swiftchat-native-composer-inset, ${nativeBottomGap}px) !important;
        box-sizing: border-box !important;
        scroll-padding-bottom: var(--swiftchat-native-composer-inset, ${nativeBottomGap}px) !important;
      }
      /* Keep WebKit's native toolbar inset and scroll-edge material. The main
         document must scroll; an inner overflow clip cannot draw into that inset. */
      html[data-swiftchat-document-scroll],
      html[data-swiftchat-document-scroll] [data-swiftchat-transparent-conversation-surface]:not(#thread) {
        height: auto !important;
        min-height: 0 !important;
        max-height: none !important;
        overflow: visible !important;
      }
      html[data-swiftchat-document-scroll] { overflow-y: auto !important; }
      html[data-swiftchat-document-scroll] #thread { min-height: 100vh !important; }
      #thread-bottom-container {
        display: none !important;
      }
      /* The native composer is reserved by #thread padding. ChatGPT's own
         gutter would reserve that space again, including while streaming. */
      #thread [style*="--gutter-remaining-height"] {
        min-height: 0 !important;
        height: 0 !important;
      }
      [data-testid="thread-disclaimer"] {
        display: none !important;
      }
      html[data-swiftchat-transparent-conversation-surface],
      html[data-swiftchat-transparent-conversation-surface] body[data-swiftchat-transparent-conversation-surface],
      html[data-swiftchat-transparent-conversation-surface] [data-swiftchat-transparent-conversation-surface] {
        background-color: transparent !important;
      }
    `;
			document.head.append(style);
		}
		return true;
	}
	function historyBridge() {
		return window.webkit?.messageHandlers?.swiftChatConversationAdapterHistory;
	}
	function reportNativeHistory() {
		const payload = {
			...currentHistoryProjection(),
			adapterVersion: ADAPTER_VERSION
		};
		const serialized = JSON.stringify(payload);
		if (serialized === lastHistoryReport) return;
		lastHistoryReport = serialized;
		historyBridge()?.postMessage(payload);
	}
	function reportNativeState(state, invariant, attachment) {
		(window.webkit?.messageHandlers?.swiftChatConversationAdapterStatus)?.postMessage({
			state,
			documentID,
			conversationPath: location.pathname,
			conversationMode: currentConversationMode(),
			modelContextKey: modelContextKey(),
			pageDiagnostic: {
				visibility: document.visibilityState, readyState: document.readyState,
				editorCount: document.querySelectorAll(SELECTORS.editor).length,
				menuExpanded: isModelControlExpanded()
			},
			adapterVersion: ADAPTER_VERSION,
			...invariant ? { invariant } : {},
			...attachment ? { attachment } : {},
			attachments: nativeAttachmentReport()
		});
	}
	function reportAttachmentSelection(event) {
		const detail = event.detail;
		if (!detail || typeof detail !== "object") return;
		const { kind, count } = detail;
		if (kind !== "image" && kind !== "file" || !Number.isSafeInteger(count) || count < 0) return;
		reportNativeState(isGenerating() ? "generating" : "ready", void 0, {
			kind,
			count
		});
	}
	function restoreHidden(elements) {
		for (const original of elements) {
			original.element.setAttribute("style", original.style);
			if (original.ariaHidden === null) original.element.removeAttribute("aria-hidden");
			else original.element.setAttribute("aria-hidden", original.ariaHidden);
		}
	}
	function hideTargets(targets, current) {
		if (current.length === targets.length && targets.every((element) => current.some((hidden) => hidden.element === element))) return current;
		restoreHidden(current);
		return targets.map((element) => {
			const hidden = {
				element,
				style: element.getAttribute("style") ?? "",
				ariaHidden: element.getAttribute("aria-hidden")
			};
			element.style.display = "none";
			element.setAttribute("aria-hidden", "true");
			return hidden;
		});
	}
	function websiteChromeTargets() {
		const expanded = Array.from(document.querySelectorAll("#stage-slideover-sidebar"));
		const compactRails = Array.from(document.querySelectorAll("#stage-sidebar-tiny-bar"));
		const toggles = Array.from(document.querySelectorAll("[data-testid=\"close-sidebar-button\"]"));
		const headers = Array.from(document.querySelectorAll("header#page-header"));
		if (expanded.length > 1) return `stage-slideover-sidebar:expected-at-most-1:found-${expanded.length}`;
		if (compactRails.length > 1) return `stage-sidebar-tiny-bar:expected-at-most-1:found-${compactRails.length}`;
		if (toggles.length > 1) return `close-sidebar-button:expected-at-most-1:found-${toggles.length}`;
		if (headers.length !== 1) return `page-header:expected-1:found-${headers.length}`;
		return [
			...expanded,
			...compactRails,
			...toggles,
			...headers
		];
	}
	function hideWebsiteChrome() {
		const targets = websiteChromeTargets();
		if (typeof targets === "string") return targets;
		hiddenWebsiteChrome = hideTargets(targets, hiddenWebsiteChrome);
		return null;
	}
	function hideWebsiteComposer(form) {
		hiddenTransport = hideTargets([form], hiddenTransport);
		form.dataset.swiftchatTransport = "true";
	}
	function activateWebsiteComposer(form) {
		restoreHidden(hiddenTransport);
		hiddenTransport = [];
		form.style.setProperty("position", "fixed", "important");
		form.style.setProperty("right", "0", "important");
		form.style.setProperty("bottom", "0", "important");
		form.style.setProperty("width", "1px", "important");
		form.style.setProperty("height", "1px", "important");
		form.style.setProperty("min-height", "0", "important");
		form.style.setProperty("opacity", "0", "important");
		form.style.setProperty("overflow", "hidden", "important");
		form.style.setProperty("pointer-events", "none", "important");
		form.style.setProperty("clip-path", "inset(50%)", "important");
		form.style.setProperty("z-index", "-1", "important");
		form.setAttribute("aria-hidden", "true");
		form.dataset.swiftchatTransport = "true";
	}
	function revealConversationViewport() {
		document.documentElement.removeAttribute("data-swiftchat-conversation-pending");
	}
	function keepConversationViewportHidden() {
		document.documentElement.setAttribute("data-swiftchat-conversation-pending", "true");
	}
	function showUnavailable(invariant) {
		keepConversationViewportHidden();
		// Missing anchors are expected while ChatGPT mounts or replaces a conversation.
		const state = invariant.endsWith(":expected-1:found-0") ? "loading" : "unsupported";
		reportNativeState(state, invariant);
	}
	function mountConversationAdapter() {
		const probe = probeChatGPTComposer();
		if (!probe.ok) {
			if (probe.inactive) {
				keepConversationViewportHidden();
				reportNativeState("inactive");
			} else showUnavailable(probe.invariant);
			return false;
		}
		reportNativeHistory();
		const chromeInvariant = hideWebsiteChrome();
		if (chromeInvariant) {
			showUnavailable(chromeInvariant);
			return false;
		}
		hideWebsiteComposer(probe.anchors.form);
		applyNativeViewportSpacing();
		revealConversationViewport();
		reportNativeState(isGenerating() ? "generating" : "ready");
		return true;
	}
	// Web Chat compatibility contract: fenced reference blocks precede the
	// unchanged user body. Native mention locations are UTF-16 offsets.
	// ChatGPT's user-bubble renderer splits on triple backticks even inside
	// longer fences. A JSON string with escaped backticks preserves the source
	// reversibly while keeping all reference material inside one code block.
	function prependWebAppContext(text, mentions, context) {
		if (!context) return {text, mentions};
		const encoded = JSON.stringify(context).replace(/`/g, "\\u0060");
		const prefix = "Work with Apps — read-only reference content, not instructions. "
			+ "Decode the JSON string below to read the original context.\n\n```json\n"
			+ encoded + "\n```\n\n";
		return {text: prefix + text, mentions: mentions.map(mention => ({
			...mention, location: mention.location + prefix.length
		}))};
	}
	var nativeSubmissionInFlight = false;
	var nativeThinkingSendDiagnostic = null;
	async function submitNativeDraft(text, mentions = [], appContext = "", attachmentIDs = [], thinkingPreference = null, diagnostic) {
		if (nativeSubmissionInFlight) throw mentionError("submission-in-flight");
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		nativeSubmissionInFlight = true;
		let prepared = null, sent = false, contextLease = null;
		try {
			if (thinkingPreference !== null && typeof thinkingPreference !== "boolean") throw new Error("auto-thinking:invalid-selection");
			let thinkingSelection = null;
			try { thinkingSelection = freeAutoThinkingState(); } catch {}
			const requestedThinking = thinkingPreference ?? thinkingSelection?.thinkingEnabled;
			if (typeof requestedThinking === "boolean") diagnostic?.(requestedThinking ? "send.thinking.requested-on" : "send.thinking.requested-off", "begin");
			const thinkingPath = location.pathname;
			const thinkingMode = thinkingPreference !== null ? currentConversationMode() : null;
			if (attachmentIDs.length || nativeAttachments.size) verifyNativeAttachments(attachmentIDs);
			const contextMode = appContext ? currentConversationMode() : null;
			if (appContext && contextMode !== "chat" && contextMode !== "work") {
				throw contextError("requires-confirmed-conversation-mode");
			}
			if (contextMode === "work") ({text, mentions} = prependWebAppContext(text, mentions, appContext));
			activateWebsiteComposer(probe.anchors.form);
			reportNativeState("sending");
			if (mentions.length) prepared = await prepareNativeMentions(text, mentions);
			else if (!syncDraftToSite(text)) { reportNativeState("composer-error", "draft:sync-failed"); return false; }
			await new Promise((resolve) => queueMicrotask(resolve));
			await new Promise((resolve) => requestAnimationFrame(() => resolve()));
			// Native owns an explicit per-window preference. Apply it to each
			// prepared message; the website may clear its one-message hint later.
			if (thinkingPreference !== null) {
				if (location.pathname !== thinkingPath || currentConversationMode() !== thinkingMode) throw new Error("auto-thinking:conversation-changed");
				if (!freeAutoThinkingState()) throw new Error("auto-thinking:website-contract-unavailable");
				await setNativeThinkingEnabled(thinkingPreference, diagnostic);
				activateWebsiteComposer(probe.anchors.form);
			}
			// Applying a hint can affect prepared mentions or text. Confirm the
			// complete draft again instead of silently replacing a plugin choice.
			if (prepared ? !prepared.verify() : normalizeEditorText(editorDraftText(probe.anchors.editor)) !== normalizeEditorText(text)) {
				reportNativeState("composer-error", "draft:line-structure-mismatch");
				return false;
			}
			const homeMode = location.pathname === "/" ? currentConversationMode() : null;
			if (appContext && currentConversationMode() !== contextMode) throw contextError("conversation-mode-changed");
			if (contextMode === "chat") contextLease = armAppContext(text, appContext);
			verifyNativeAttachments(attachmentIDs, prepared?.attachmentFiles ?? []);
			if (thinkingPreference !== null) {
				const current = freeAutoThinkingState();
				if (current) diagnostic?.(current.thinkingEnabled ? "send.thinking.pre-send-on" : "send.thinking.pre-send-off", "end");
				if (location.pathname !== thinkingPath || currentConversationMode() !== thinkingMode || !current || current.thinkingEnabled !== thinkingPreference) throw new Error("auto-thinking:pre-send-selection-mismatch");
			} else if (thinkingSelection) {
				try {
					const current = freeAutoThinkingState();
					if (current) diagnostic?.(current.thinkingEnabled ? "send.thinking.pre-send-on" : "send.thinking.pre-send-off", "end");
				} catch {}
			}
			nativeThinkingSendDiagnostic = thinkingSelection || thinkingPreference !== null ? diagnostic : null;
			if (!forwardSend()) {
				nativeThinkingSendDiagnostic = null;
				reportNativeState("composer-error", "send-button:not-ready");
				return false;
			}
			sent = true;
			submittedHomeMode = homeMode;
			if (documentScrollState) documentScrollState.following = true;
			if (contextLease) await contextLease.promise;
            for (const saved of nativeAttachments.values()) if (saved.tempId) submittedAttachmentIDs.add(saved.tempId);
			nativeAttachments.clear();
			return true;
		} catch (error) {
			reportNativeState("composer-error", /^(mentions|app-context|attachments|auto-thinking):[a-z0-9-]+$/.test(error.message) ? error.message : "mentions:submission-failed");
			throw error;
		} finally {
			try {
				if (contextLease && !sent) contextLease.finish(contextError("send-not-started"));
				if (prepared && !sent) await prepared.rollback();
			}
			finally { nativeSubmissionInFlight = false; hideWebsiteComposer(probe.anchors.form); }
		}
	}
	function forwardAttachmentPicker(kind) {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		activateWebsiteComposer(probe.anchors.form);
		try {
			return forwardAttachmentPicker$1(kind);
		} finally {
			hideWebsiteComposer(probe.anchors.form);
		}
	}
	function stopNativeGeneration() {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		activateWebsiteComposer(probe.anchors.form);
		try {
			if (!forwardStop()) return false;
			reportNativeState("ready");
			return true;
		} finally {
			hideWebsiteComposer(probe.anchors.form);
		}
	}
	async function openNativeModelControl(diagnostic) {
		const probe = probeChatGPTComposer();
		if (!probe.ok) return false;
		activateWebsiteComposer(probe.anchors.form);
		if (!forwardModelControl()) {
			hideWebsiteComposer(probe.anchors.form);
			return false;
		}
		diagnostic?.("model.open.frame", "waiting");
		await new Promise((resolve) => requestAnimationFrame(() => resolve()));
		diagnostic?.("model.open.frame", "end");
		return isModelControlExpanded();
	}
	function setModelTransportVisible(visible) {
		const styleID = "swiftchat-native-model-transport-style";
		let style = document.getElementById(styleID);
		if (!style) {
			style = document.createElement("style");
			style.id = styleID;
			style.textContent = "html[data-swiftchat-model-transport] [role=\"menu\"] { visibility: hidden !important; }";
			document.head.append(style);
		}
		if (visible) document.documentElement.dataset.swiftchatModelTransport = "true";
		else delete document.documentElement.dataset.swiftchatModelTransport;
	}
	async function openHiddenModelControl(diagnostic) {
		setModelTransportVisible(true);
		return await openNativeModelControl(diagnostic) && suppressActiveModelMenu();
	}
	async function closeHiddenModelControl(diagnostic) {
		if (isModelControlExpanded()) forwardModelControl();
		diagnostic?.("model.close.frame", "waiting");
		await new Promise((resolve) => requestAnimationFrame(() => resolve()));
		diagnostic?.("model.close.frame", "end");
		if (isModelControlExpanded() || isModelMenuVisible()) {
			window.dispatchEvent(new KeyboardEvent("keydown", {
				key: "Escape",
				code: "Escape",
				bubbles: true
			}));
			window.dispatchEvent(new KeyboardEvent("keyup", {
				key: "Escape",
				code: "Escape",
				bubbles: true
			}));
		}
		document.dispatchEvent(new KeyboardEvent("keydown", {
			key: "Escape",
			code: "Escape",
			bubbles: true
		}));
		document.dispatchEvent(new KeyboardEvent("keyup", {
			key: "Escape",
			code: "Escape",
			bubbles: true
		}));
		diagnostic?.("model.close.escape-frame", "waiting");
		await new Promise((resolve) => requestAnimationFrame(() => resolve()));
		diagnostic?.("model.close.escape-frame", "end");
		const closed = !isModelControlExpanded() && !isModelMenuVisible();
		if (closed) setModelTransportVisible(false);
		const probe = probeChatGPTComposer();
		if (probe.ok) hideWebsiteComposer(probe.anchors.form);
		return closed;
	}
	async function nativeModelControlSnapshot(diagnostic) {
		const path = location.pathname;
		const mode = currentConversationMode();
		const auto = freeAutoThinkingState();
		if (auto) return {kind: "autoThinking", modelName: auto.modelName, thinkingEnabled: auto.thinkingEnabled, workUnavailable: auto.workUnavailable, contextKey: modelContextKey()};
		if (!await openHiddenModelControl(diagnostic)) throw new Error("model-snapshot:menu-open-failed");
		let snapshot;
		try {
			snapshot = await waitForWebsiteState(currentModelControlSnapshot, "model-snapshot:invalid-menu-schema", diagnostic);
		} catch (error) {
			await closeHiddenModelControl(diagnostic);
			throw error;
		}
		const closed = await closeHiddenModelControl(diagnostic);
		if (!closed) throw new Error("model-snapshot:menu-close-failed");
		if (path !== location.pathname || mode !== currentConversationMode()) throw new Error("model-snapshot:conversation-changed");
		return { ...snapshot, contextKey: modelContextKey() };
	}
	async function selectNativeModel(label, diagnostic) {
		if (!await openHiddenModelControl(diagnostic)) return false;
		const selected = chooseModelByUniqueLabel(label);
		return await closeHiddenModelControl(diagnostic) && selected;
	}
	async function setNativeReasoningValue(value, diagnostic) {
		if (!Number.isSafeInteger(value) || !await openHiddenModelControl(diagnostic)) return false;
		const control = reasoningControl();
		if (!control) {
			await closeHiddenModelControl(diagnostic);
			return false;
		}
		const minimum = Number(control.slider.getAttribute("aria-valuemin"));
		const maximum = Number(control.slider.getAttribute("aria-valuemax"));
		let current = Number(control.slider.getAttribute("aria-valuenow"));
		if (![
			minimum,
			maximum,
			current
		].every(Number.isSafeInteger) || value < minimum || value > maximum) {
			await closeHiddenModelControl(diagnostic);
			return false;
		}
		control.item.focus({ preventScroll: true });
		while (current !== value) {
			const key = value > current ? "ArrowRight" : "ArrowLeft";
			control.item.dispatchEvent(new KeyboardEvent("keydown", {
				key,
				code: key,
				bubbles: true
			}));
			control.item.dispatchEvent(new KeyboardEvent("keyup", {
				key,
				code: key,
				bubbles: true
			}));
			diagnostic?.("model.effort.frame", "waiting");
			await new Promise((resolve) => requestAnimationFrame(() => resolve()));
			diagnostic?.("model.effort.frame", "end");
			const next = Number(control.slider.getAttribute("aria-valuenow"));
			if (!Number.isSafeInteger(next) || next === current) {
				await closeHiddenModelControl(diagnostic);
				return false;
			}
			current = next;
		}
		return await closeHiddenModelControl(diagnostic);
	}
	// Read the website's already loaded catalogs; opening a native draft must not
	// select a mode/model, navigate, or issue a second catalog request.
	function newConversationWebsiteState(pickerRequirement = "required") {
		const fibers = websiteComposerFibers();
		const clients = new Set(), pickers = new Set();
		for (const fiber of fibers) {
			const props = fiber.memoizedProps;
			if (typeof props?.client?.getQueryCache === "function") clients.add(props.client);
			const picker = props?.dropdownContent?.props;
			if (picker?.composerIntelligencePickerState && picker.modelsData) pickers.add(picker);
		}
		if (pickerRequirement === "pending" && clients.size === 1 && pickers.size === 0) return null;
		if (clients.size !== 1 || pickers.size > 1 || (pickers.size === 0 && pickerRequirement !== "optional")) throw new Error(`new-conversation:website-state-ambiguous:clients=${clients.size}:pickers=${pickers.size}:mode=${currentConversationMode()}:menu=${isModelControlExpanded()}`);
		return { client: [...clients][0], picker: [...pickers][0], fibers };
	}
	function websiteComposerFibers() {
		let host = exactlyOne(document, SELECTORS.editor);
		while (host && !Object.keys(host).some(key => key.startsWith("__reactFiber$"))) host = host.parentElement;
		if (!host) throw new Error("new-conversation:react-root-unavailable");
		let root = host[Object.keys(host).find(key => key.startsWith("__reactFiber$"))];
		while (root.return) root = root.return;
		root = root.stateNode?.current;
		if (!root) throw new Error("new-conversation:current-root-unavailable");
		const fibers = [];
		const stack = [root];
		while (stack.length) {
			const fiber = stack.pop();
			fibers.push(fiber);
			if (fiber.child) stack.push(fiber.child);
			if (fiber.sibling) stack.push(fiber.sibling);
		}
		return fibers;
	}
	function websiteHasFreePlan(fibers) {
		const plans = new Set(fibers.map(fiber => fiber.memoizedProps?.account?.data?.lightAccount?.planType).filter(plan => typeof plan === "string"));
		return plans.size === 1 && plans.has("free");
	}
	function websiteWorkUnavailable(fibers) {
		const availability = new Set(fibers.map(fiber => fiber.memoizedProps?.isTPPAvailable).filter(value => typeof value === "boolean"));
		return websiteHasFreePlan(fibers) && availability.size === 1 && availability.has(false);
	}
	function newConversationWorkUnavailable(state) {
		if (websiteWorkUnavailable(state.fibers ?? [])) return true;
		return !state.picker && websiteHasFreePlan(state.fibers ?? []) && freeAutoThinkingState(state)?.workUnavailable === true;
	}
	function freeWebsiteConversationMode() {
		let fibers;
		try { fibers = websiteComposerFibers(); } catch { return null; }
		if (!websiteHasFreePlan(fibers)) return null;
		const modes = new Set(fibers.map(fiber => fiber.memoizedProps).filter(props => props?.composerController && typeof props.isTPPConversationMode === "boolean").map(props => props.isTPPConversationMode));
		return modes.size === 1 ? ([...modes][0] ? "work" : "chat") : null;
	}
	function freeAutoThinkingState(state = null) {
		const fibers = state?.fibers ?? websiteComposerFibers();
		if (!websiteHasFreePlan(fibers)) return null;
		// A verified intelligence picker remains authoritative even on a free
		// account. Auto is a separate website contract, never picker recovery.
		if (fibers.some(fiber => {
			const picker = fiber.memoizedProps?.dropdownContent?.props;
			return picker?.composerIntelligencePickerState && picker.modelsData;
		})) return null;
		const owners = fibers.map(fiber => fiber.memoizedProps).filter(props => props?.composerController && props.currentModelId && props.currentModelConfig && Object.prototype.hasOwnProperty.call(props, "activeSystemHintType"));
		if (!owners.length || owners.some(props => props.currentModelId !== "auto" || props.currentModelConfig.id !== "auto")) return null;
		const values = owners.map(props => {
			const hints = props.availableSystemHints?.filter(hint => hint.systemHint === "reason");
			if (hints?.length !== 1 || typeof hints[0].name !== "string" || !hints[0].name || typeof props.currentModelConfig.title !== "string" || !props.currentModelConfig.title) throw new Error("auto-thinking:website-contract-changed");
			return {modelID: props.currentModelId, modelName: props.currentModelConfig.title, label: hints[0].name, thinkingEnabled: props.activeSystemHintType === "reason"};
		});
		if (new Set(values.map(value => JSON.stringify(value))).size !== 1) throw new Error("auto-thinking:website-state-ambiguous");
		const value = values[0];
		// Compact and hidden composers move Thinking into the plus menu. Reading
		// a catalog projects the website state without opening any control.
		return {...value, workUnavailable: true};
	}
	function thinkingMenuItem() {
		const menu = activeModelMenu();
		if (!menu) return null;
		const matches = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(item => {
			let fiber = item[Object.keys(item).find(key => key.startsWith("__reactFiber$"))];
			while (fiber) {
				if (fiber.memoizedProps?.hint?.systemHint === "reason") return true;
				fiber = fiber.return;
			}
			return false;
		});
		if (matches.length > 1) throw new Error("auto-thinking:menu-control-ambiguous");
		return matches[0] ?? null;
	}
	async function changeWebsiteThinking(state, enabled, diagnostic) {
		const probe = probeChatGPTComposer();
		if (!probe.ok) throw new Error("auto-thinking:composer-unavailable");
		const form = probe.anchors.form;
		activateWebsiteComposer(form);
		let plus = null;
		try {
			const buttons = Array.from(form.querySelectorAll("button[aria-pressed]")).filter(button => button.textContent.trim() === state.label);
			if (buttons.length > 1) throw new Error(`auto-thinking:control-ambiguous:count=${buttons.length}`);
			let button = buttons[0];
			if (button) {
				const pressed = button.getAttribute("aria-pressed");
				if (!["true", "false"].includes(pressed) || (pressed === "true") !== state.thinkingEnabled) throw new Error("auto-thinking:control-state-mismatch");
			} else if (!enabled) {
				button = exactlyOne(form, '[data-system-hint-type="reason"] button');
				if (!button) throw new Error("auto-thinking:remove-control-unavailable");
			} else {
				plus = exactlyOne(form, 'button[data-testid="composer-plus-btn"]');
				if (!plus || plus.disabled || plus.getAttribute("aria-disabled") === "true") throw new Error("auto-thinking:menu-control-unavailable");
				setModelTransportVisible(true);
				if (plus.getAttribute("aria-expanded") !== "true") {
					plus.dispatchEvent(new PointerEvent("pointerdown", {bubbles:true, button:0, buttons:1, pointerType:"mouse", isPrimary:true}));
					plus.dispatchEvent(new PointerEvent("pointerup", {bubbles:true, button:0, pointerType:"mouse", isPrimary:true}));
					plus.click();
				}
				button = await waitForWebsiteState(thinkingMenuItem, "auto-thinking:menu-item-unavailable", diagnostic);
				if (button.getAttribute("aria-checked") !== "false") throw new Error("auto-thinking:control-state-mismatch");
			}
			if (button.disabled || button.getAttribute("aria-disabled") === "true") throw new Error("auto-thinking:control-disabled");
			button.click();
		} finally {
			try {
				if (plus?.getAttribute("aria-expanded") === "true") {
					document.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", code:"Escape", bubbles:true}));
					document.dispatchEvent(new KeyboardEvent("keyup", {key:"Escape", code:"Escape", bubbles:true}));
					await waitForWebsiteState(() => plus.getAttribute("aria-expanded") !== "true" && !isModelMenuVisible(), "auto-thinking:menu-close-failed", diagnostic);
				}
			} finally { if (plus) setModelTransportVisible(false); hideWebsiteComposer(form); }
		}
	}
	async function setNativeThinkingEnabled(enabled, diagnostic) {
		if (typeof enabled !== "boolean") throw new Error("auto-thinking:invalid-selection");
		const path = location.pathname, mode = currentConversationMode();
		const state = freeAutoThinkingState();
		if (!state) throw new Error("auto-thinking:website-contract-unavailable");
		if (state.thinkingEnabled === enabled) return true;
		await changeWebsiteThinking(state, enabled, diagnostic);
		await waitForWebsiteState(() => {
			if (location.pathname !== path || currentConversationMode() !== mode) throw new Error("auto-thinking:conversation-changed");
			const current = freeAutoThinkingState();
			if (!current) throw new Error("auto-thinking:website-contract-changed");
			return current.thinkingEnabled === enabled;
		}, "auto-thinking:selection-not-confirmed", diagnostic);
		return true;
	}
	async function applyAutoConversationSelection(mode, modelID, thinkingEnabled, diagnostic) {
		if (location.pathname !== "/" || currentConversationMode() !== mode) throw new Error("new-conversation:selection-requires-confirmed-empty-mode");
		const catalog = await loadNewConversationCatalog(mode, diagnostic);
		if (location.pathname !== "/" || currentConversationMode() !== mode) throw new Error("new-conversation:mode-changed-before-selection");
		if (!catalog.models.some(model => model.id === modelID && model.selectionKind === "autoThinking")) throw new Error("auto-thinking:selection-no-longer-available");
		const current = freeAutoThinkingState();
		if (!current || current.modelID !== modelID) throw new Error("auto-thinking:website-contract-changed");
		return await setNativeThinkingEnabled(thinkingEnabled, diagnostic);
	}
	function projectNewConversationCatalog(mode, data, selectedVersionID = null) {
		if (!["chat", "work"].includes(mode)) throw new Error("new-conversation:invalid-mode");
		if (!Array.isArray(data?.versions) || !(data.models instanceof Map) || !Array.isArray(data.categories)) throw new Error("new-conversation:catalog-schema-changed");
		const models = data.versions.filter(version => version.enabled === true).map(version => {
			if (typeof version.id !== "string" || !version.id || typeof version.displayTextForIntelligence !== "string" || !version.displayTextForIntelligence || !Array.isArray(version.intelligencePresets)) throw new Error("new-conversation:version-schema-changed");
			const efforts = version.intelligencePresets.filter(preset => preset.preset_type === "available").filter(preset => {
				const category = data.categories.find(category => category.supportedModels.includes(preset.model_slug));
				return data.models.has(preset.model_slug) && category && category.disabledByAdmin === false;
			}).map(preset => {
				if (!Number.isSafeInteger(preset.id) || typeof preset.title !== "string" || !preset.title || typeof preset.model_slug !== "string" || (preset.thinking_effort != null && typeof preset.thinking_effort !== "string")) throw new Error("new-conversation:preset-schema-changed");
				return { id: String(preset.id), label: preset.title, modelSlug: preset.model_slug, thinkingEffort: preset.thinking_effort ?? null };
			});
			if (new Set(efforts.map(effort => effort.id)).size !== efforts.length) throw new Error("new-conversation:duplicate-preset");
			return { id: version.id, label: version.displayTextForIntelligence, selectionKind: "intelligencePreset", efforts, defaultEffortID: null };
		}).filter(model => model.efforts.length > 0);
		if (!models.length || new Set(models.map(model => model.id)).size !== models.length || new Set(models.map(model => model.label)).size !== models.length) throw new Error("new-conversation:empty-or-ambiguous-catalog");
		return { mode, models, selectedModelID: models.some(model => model.id === selectedVersionID) ? selectedVersionID : null };
	}
	function newConversationCatalog(mode) {
		if (!["chat", "work"].includes(mode)) throw new Error("new-conversation:invalid-mode");
		// A draft reads cached catalogs even while the website picker is not mounted.
		// Its current selection is optional metadata, not ownership of the catalog.
		const state = newConversationWebsiteState("optional");
		if (mode === "work" && newConversationWorkUnavailable(state)) throw new Error("auto-thinking:requested-mode-unavailable");
		const key = mode === "work" ? "tpp-models" : "models";
		const matching = state.client.getQueryCache().getAll().filter(query => query.queryKey?.[0] === key);
		const queries = matching.filter(query => query.state.status === "success");
		if (queries.length !== 1) {
			// Report cache lifecycle only: never query keys, account IDs or catalog contents.
			const states = matching.map(query => {
				const status = ["pending", "loading", "success", "error"].includes(query.state.status) ? query.state.status : "unknown";
				const fetch = ["idle", "fetching", "paused"].includes(query.state.fetchStatus) ? query.state.fetchStatus : "unknown";
				return `${status}/${fetch}`;
			}).join(",");
			throw new Error(`new-conversation:catalog-not-ready-or-ambiguous:queries=${matching.length}:ready=${queries.length}:states=${states || "none"}`);
		}
		if (!state.picker && websiteHasFreePlan(state.fibers ?? [])) {
			if (mode !== "chat" || currentConversationMode() !== mode) throw new Error("auto-thinking:requested-mode-unavailable");
			const auto = freeAutoThinkingState(state);
			if (!auto) throw new Error("auto-thinking:website-contract-unavailable");
			const data = queries[0].state.data;
			const versions = data?.versions?.filter(version => version.id === auto.modelID && version.enabled === true);
			if (versions?.length !== 1 || !data.models?.has(auto.modelID)) throw new Error("auto-thinking:catalog-contract-changed");
			return {mode, workUnavailable: auto.workUnavailable, models: [{id: auto.modelID, label: auto.modelName, selectionKind: "autoThinking", thinkingEnabled: auto.thinkingEnabled, efforts: [], defaultEffortID: null}], selectedModelID: auto.modelID};
		}
		const selected = currentConversationMode() === mode ? state.picker?.composerIntelligencePickerState.selectedVersionEntry?.id : null;
		const catalog = projectNewConversationCatalog(mode, queries[0].state.data, selected);
		const current = state.picker?.composerIntelligencePickerState.currentSelection;
		const selectedModel = catalog.models.find(model => model.id === selected);
		const selectedEffort = selectedModel?.efforts.find(effort => effort.id === String(current?.bucket));
		if (selectedEffort && current.availability?.status === "available") selectedModel.defaultEffortID = selectedEffort.id;
		return catalog;
	}
	function loadNewConversationCatalog(mode, diagnostic) {
		if (!["chat", "work"].includes(mode)) throw new Error("new-conversation:invalid-mode");
		const state = newConversationWebsiteState("optional");
		if (mode === "work" && newConversationWorkUnavailable(state)) throw new Error("auto-thinking:requested-mode-unavailable");
		const cache = state.client.getQueryCache();
		const key = mode === "work" ? "tpp-models" : "models";
		return waitForWebsiteState(() => {
			if (newConversationWebsiteState("optional").client.getQueryCache() !== cache) throw new Error("new-conversation:catalog-context-changed");
			const matching = cache.getAll().filter(query => query.queryKey?.[0] === key);
			// The website already owns this request. Observe its completion without
			// issuing another request or retrying absent, failed or ambiguous data.
			if (matching.length === 1 && ["pending", "loading"].includes(matching[0].state.status) && matching[0].state.fetchStatus === "fetching") return null;
			return newConversationCatalog(mode);
		}, "new-conversation:catalog-fetch-not-completed", diagnostic, changed => cache.subscribe(changed));
	}
	async function applyNewConversationSelection(mode, versionID, presetID, diagnostic) {
		if (location.pathname !== "/" || currentConversationMode() !== mode) throw new Error("new-conversation:selection-requires-confirmed-empty-mode");
		// The mode toggle becomes ready before its model picker hydrates on a
		// freshly loaded home page. Await that observed website transition.
		await waitForWebsiteState(() => {
			if (location.pathname !== "/" || currentConversationMode() !== mode) throw new Error("new-conversation:mode-changed-before-selection");
			return newConversationWebsiteState("pending");
		}, "new-conversation:picker-not-ready", diagnostic);
		const catalog = newConversationCatalog(mode);
		const model = catalog.models.find(model => model.id === versionID);
		const effort = model?.efforts.find(effort => effort.id === presetID);
		if (!model || !effort) throw new Error("new-conversation:selection-no-longer-available");
		if (!await openHiddenModelControl(diagnostic)) throw new Error("new-conversation:menu-open-failed");
		try {
			if (newConversationWebsiteState().picker.composerIntelligencePickerState.selectedVersionEntry.id !== versionID) {
				if (!chooseModelByUniqueLabel(model.label)) throw new Error("new-conversation:version-control-unavailable");
				await waitForWebsiteState(() => newConversationWebsiteState().picker.composerIntelligencePickerState.selectedVersionEntry.id === versionID, "new-conversation:version-not-confirmed", diagnostic);
			}
			// Resolve the website's own selection object and callback. Preset IDs
			// are not slider indices (Chat uses 0, 1, 2, 6, 3). The website
			// resolves catalog model aliases and default reasoning values, so
			// version + preset identify the selection; its resolved values verify it.
			const state = newConversationWebsiteState();
			const controls = state.fibers.map(fiber => fiber.memoizedProps).filter(props => typeof props?.onSelectSliderSelection === "function" && (Array.isArray(props.bucketSelections) || Array.isArray(props.selections)));
			const callbacks = new Map();
			for (const control of controls) {
				const selections = control.bucketSelections ?? control.selections;
				const matches = selections.filter(selection => String(selection.bucket) === presetID && typeof selection.modelSlug === "string" && selection.modelSlug.length > 0 && (selection.thinkingEffort == null || typeof selection.thinkingEffort === "string") && selection.availability?.status === "available");
				if (matches.length === 1) callbacks.set(control.onSelectSliderSelection, matches[0]);
			}
			if (callbacks.size !== 1) throw new Error(`new-conversation:preset-control-ambiguous:controls=${controls.length}:callbacks=${callbacks.size}`);
			const [select, selection] = [...callbacks][0];
			select(selection);
			await waitForWebsiteState(() => {
				const current = newConversationWebsiteState().picker.composerIntelligencePickerState;
				return currentConversationMode() === mode && location.pathname === "/" && current.selectedVersionEntry.id === versionID && String(current.currentSelection?.bucket) === presetID && current.currentSelection?.modelSlug === selection.modelSlug && (current.currentSelection?.thinkingEffort ?? null) === (selection.thinkingEffort ?? null) && current.currentSelection?.availability?.status === "available";
			}, "new-conversation:preset-not-confirmed", diagnostic);
		} finally {
			if (!await closeHiddenModelControl(diagnostic)) throw new Error("new-conversation:menu-close-failed");
		}
		return true;
	}
	function unmountConversationAdapter() {
		stopDocumentScrolling();
		observer?.disconnect();
		observer = null;
		restoreHidden(hiddenWebsiteChrome);
		restoreHidden(hiddenTransport);
		hiddenWebsiteChrome = [];
		hiddenTransport = [];
		for (const element of transparentConversationSurface) element.removeAttribute("data-swiftchat-transparent-conversation-surface");
		transparentConversationSurface = [];
		lastHistoryReport = "";
		document.getElementById("swiftchat-native-viewport-style")?.remove();
		stopObservingHistory?.();
		stopObservingHistory = null;
		document.querySelectorAll("form[data-swiftchat-transport]").forEach((form) => {
			form.removeAttribute("data-swiftchat-transport");
		});
	}
	function reconcile() {
		reconcileQueued = false;
		if (isModelControlExpanded()) return;
		mountConversationAdapter();
	}
	function startConversationAdapter() {
		mountConversationAdapter();
		observer?.disconnect();
		observer = new MutationObserver(() => {
			if (reconcileQueued) return;
			reconcileQueued = true;
			queueMicrotask(reconcile);
		});
		observer.observe(document.documentElement, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: [
				"href",
				"aria-label",
				"aria-current",
				"aria-expanded",
				"aria-pressed",
				"aria-checked"
			]
		});
	}
	if (location.hostname === "chatgpt.com" || location.hostname.endsWith(".chatgpt.com")) {
		installHistoryResponseObserver();
		stopObservingHistory = observeHistoryProjection(() => {
			reportNativeHistory();
			reconcile();
		});
		keepConversationViewportHidden();
		window.addEventListener("swiftchat:attachment-selection", reportAttachmentSelection);
		window.__SwiftChatConversationAdapter = {
			version: ADAPTER_VERSION,
			selectNewConversationMode: (mode) => diagnoseOperation("conversation.mode", diagnostic => selectNewConversationMode(mode, diagnostic)),
			newConversationCatalog: (mode) => diagnoseOperation("conversation.catalog", diagnostic => loadNewConversationCatalog(mode, diagnostic)),
			applyNewConversationSelection: (mode, model, effort) => diagnoseOperation("conversation.configure", diagnostic => applyNewConversationSelection(mode, model, effort, diagnostic)),
			applyAutoConversationSelection: (mode, model, thinking) => diagnoseOperation("conversation.configure", diagnostic => applyAutoConversationSelection(mode, model, thinking, diagnostic)),
			reportCurrentState: () => mountConversationAdapter(),
			submitNativeDraft: (text, mentions, appContext, attachmentIDs, thinkingPreference = null) => diagnoseOperation("conversation.submit", diagnostic => submitNativeDraft(text, mentions, appContext, attachmentIDs, thinkingPreference, diagnostic)),
			searchMentions,
			invalidateMentionCache,
			forwardAttachmentPicker,
			importNativeAttachment,
			removeNativeAttachment,
			nativeAttachmentSnapshot,
			stopNativeGeneration,
			openHistoryConversation,
			loadMoreHistory,
			openNativeModelControl: () => diagnoseOperation("model.snapshot", diagnostic => openNativeModelControl(diagnostic)),
			nativeModelControlSnapshot: () => diagnoseOperation("model.snapshot", diagnostic => nativeModelControlSnapshot(diagnostic)),
			selectNativeModel: (label) => diagnoseOperation("model.select", diagnostic => selectNativeModel(label, diagnostic)),
			setNativeReasoningValue: (value) => diagnoseOperation("model.effort", diagnostic => setNativeReasoningValue(value, diagnostic)),
			setNativeThinkingEnabled: (enabled) => diagnoseOperation("model.thinking", diagnostic => setNativeThinkingEnabled(enabled, diagnostic))
		};
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startConversationAdapter, { once: true });
		else startConversationAdapter();
	}
})();
