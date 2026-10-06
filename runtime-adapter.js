(function attachNativePlannerHost(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TWStoryPlannerNativeHost = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createNativeHostModule() {
  'use strict';

  const EXTENSION_ID = 'tw-story-planner-v1';
  const VERSION = '0.1.2';
  const STATE_KEY = '__tw_story_planner_v1';
  const BUTTON_EVENT = 'tw-story-planner-v1:open';
  const clone = value => value == null ? value : structuredClone(value);

  function inspectHostCapabilities(context, { window = globalThis.window } = {}) {
    const bridge = window?.__TAURITAVERN__;
    const platform = bridge ? 'tauritavern' : 'sillytavern';
    const eventTypes = context?.eventTypes ?? context?.event_types;
    const missing = [];
    if (!Array.isArray(context?.chat)) missing.push('context.chat');
    if (!context?.extensionSettings || typeof context.extensionSettings !== 'object') missing.push('context.extensionSettings');
    if (typeof context?.eventSource?.on !== 'function') missing.push('context.eventSource.on');
    if (!eventTypes || typeof eventTypes !== 'object') missing.push('context.eventTypes');
    for (const eventName of [
      'CHAT_COMPLETION_PROMPT_READY', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED',
      'MESSAGE_DELETED', 'CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
    ]) {
      if (typeof eventTypes?.[eventName] !== 'string') missing.push(`eventTypes.${eventName}`);
    }
    if (bridge) {
      const ready = bridge.ready ?? window?.__TAURITAVERN_MAIN_READY__;
      if (ready == null || typeof ready.then !== 'function') missing.push('TauriTavern Host Ready promise');
      if (typeof bridge.api?.chat?.current?.handle !== 'function') missing.push('api.chat.current.handle');
      if (typeof context?.ChatCompletionService?.createRequestData !== 'function') missing.push('context.ChatCompletionService.createRequestData');
      if (typeof context?.saveMetadata !== 'function') missing.push('context.saveMetadata');
    }
    return { platform, ok: missing.length === 0, missing };
  }

  function fnv1a(value) {
    let hash = 0x811c9dc5;
    const bytes = new TextEncoder().encode(String(value));
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function messageTextLength(content) {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content)) return 0;
    return content.reduce((total, part) => {
      if (typeof part === 'string') return total + part.length;
      return total + (typeof part?.text === 'string' ? part.text.length : 0);
    }, 0);
  }

  function summarizeMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let serialized;
    try { serialized = JSON.stringify(list); }
    catch { serialized = '[unserializable]'; }
    const messageTextChars = list.map(message => messageTextLength(message?.content));
    return {
      messageCount: list.length,
      roles: list.map(message => typeof message?.role === 'string' ? message.role : null),
      messageTextChars,
      totalTextChars: messageTextChars.reduce((total, length) => total + length, 0),
      fingerprint: `fnv1a-${fnv1a(serialized)}`,
    };
  }

  function responseShape(json, validJson) {
    const choice = json?.choices?.[0];
    const message = choice?.message;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const content = message?.content;
    return {
      validJson,
      hasError: Boolean(json?.error),
      envelopeStatus: reportedErrorStatus(json),
      upstreamCategory: reportedUpstreamCategory(json),
      choiceCount: Array.isArray(json?.choices) ? json.choices.length : 0,
      finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      toolCallCount: toolCalls.length,
      toolCallNames: toolCalls.map(call => call?.function?.name).filter(name => typeof name === 'string'),
      hasGameContentCall: toolCalls.some(call => call?.function?.name === 'game_content'),
      hasLegacyFunctionCall: typeof message?.function_call?.name === 'string',
      contentChars: typeof content === 'string' ? content.length : null,
      hasOutlineTag: typeof content === 'string' && /<outline(?:\s[^<>]*)?>[\s\S]*?<\/outline\s*>/i.test(content),
      hasContent: typeof content === 'string' && content.trim().length > 0,
    };
  }

  function logResponseDiagnostics(logger, response, json, validJson, readIssue = null) {
    logger?.info?.('[剧情规划器][诊断][响应]', {
      httpStatus: response.status,
      responseOk: response.ok,
      responseSource: 'cloned_http_body',
      wrappedJsonInvoked: false,
      validJson,
      rawCloneSupported: typeof response.clone === 'function',
      rawCloneValidJson: validJson,
      rawCloneIssue: readIssue,
      raw: validJson ? responseShape(json, true) : null,
    });
  }

  function reportedUpstreamStatus(json) {
    const error = json?.error;
    const value = error?.upstream_status ?? error?.upstreamStatus ?? error?.provider_status ?? error?.upstream?.status;
    const status = Number(value);
    return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
  }

  function reportedErrorStatus(json) {
    const value = json?.error?.status ?? json?.error?.status_code ?? json?.error?.statusCode;
    const status = Number(value);
    return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
  }

  function reportedUpstreamCategory(json) {
    const category = json?.error?.category;
    return ['provider', 'upstream', 'network', 'authentication', 'auth', 'rate_limit',
      'request', 'validation', 'timeout', 'transport', 'unknown'].includes(category) ? category : null;
  }

  function responseFailure(response, json, isTauri) {
    const failure = new Error('规划 API 请求失败');
    failure.hostStatus = response.status;
    failure.upstreamStatus = reportedUpstreamStatus(json);
    failure.upstreamCategory = reportedUpstreamCategory(json);
    failure.status = isTauri ? failure.upstreamStatus : reportedErrorStatus(json) ?? (response.ok ? null : response.status);
    failure.code = 'API_RESPONSE_ERROR';
    return failure;
  }

  function normalizeApiBase(value) {
    const url = new URL(String(value ?? '').trim());
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('API 地址必须使用 HTTP 或 HTTPS');
    if (url.search) throw new Error('API 基址不能包含 query parameters；请把凭据填入密钥字段');
    url.hash = '';
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|completions)\/?$/i, '').replace(/\/$/, '');
    return url.toString().replace(/\/$/, '');
  }

  function worldNames(value) {
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
  }

  function convertWorldInfoEntry(raw, uid) {
    if (!raw || typeof raw !== 'object') return null;
    const positionMap = {
      0: 'before_character_definition',
      1: 'after_character_definition',
      2: 'before_example_messages',
      3: 'after_example_messages',
      4: 'at_depth',
    };
    const positionCode = Number(raw.position ?? 0);
    const position = positionMap[positionCode];
    if (!position) return null;
    const keys = Array.isArray(raw.key) ? raw.key : String(raw.key ?? '').split(',').map(value => value.trim()).filter(Boolean);
    const secondaryKeys = Array.isArray(raw.keysecondary) ? raw.keysecondary : String(raw.keysecondary ?? '').split(',').map(value => value.trim()).filter(Boolean);
    return {
      uid: raw.uid ?? uid,
      name: raw.comment ?? raw.name ?? `World Info ${uid}`,
      enabled: raw.disable !== true,
      content: String(raw.content ?? ''),
      strategy: { type: raw.constant === true ? 'constant' : 'selective', scan_depth: raw.scanDepth ?? raw.scan_depth ?? null,
        keys, keys_secondary: secondaryKeys.length ? { logic: ['and_any', 'and_all', 'not_all', 'not_any'].includes(raw.selectiveLogic) ? raw.selectiveLogic : 'and_any', keys: secondaryKeys } : null },
      probability: Number(raw.probability ?? 100),
      position: { type: position, depth: Number(raw.depth ?? 0), order: Number(raw.order ?? raw.insertion_order ?? 0), role: ['system', 'assistant', 'user'].includes(raw.role) ? raw.role : 'system' },
      effect: raw.effect ?? null,
      recursion: raw.recursion ?? null,
      extra: { outlet_name: raw.outlet_name ?? raw.extra?.outlet_name ?? null },
    };
  }

  function createNativeHost(context, { window = globalThis.window, document = window?.document } = {}) {
    const capabilities = inspectHostCapabilities(context, { window });
    if (!capabilities.ok) throw new Error(`剧情规划器缺少${capabilities.platform === 'tauritavern' ? ' TauriTavern' : ' SillyTavern'}能力：${capabilities.missing.join(', ')}`);
    const eventTypes = context.eventTypes ?? context.event_types;
    const liveContext = () => window?.SillyTavern?.getContext?.() ?? context;
    const settingsRoot = () => liveContext().extensionSettings;
    settingsRoot()[EXTENSION_ID] ??= {};
    const nativeSettings = () => {
      const settings = settingsRoot();
      settings[EXTENSION_ID] ??= {};
      return settings[EXTENSION_ID];
    };
    const controllers = new Map();
    const activeListeners = new Set();
    const buttonListeners = new Set();
    let pendingSettingsSave = null;
    let button = null;
    let menuContainer = null;
    let menuObserver = null;

    function currentMetadata() {
      const metadata = liveContext().chatMetadata;
      return metadata && typeof metadata === 'object' ? metadata : null;
    }

    function chatState() {
      const metadata = currentMetadata();
      if (!metadata) return {};
      metadata.extensions ??= {};
      if (metadata.extensions[EXTENSION_ID] && typeof metadata.extensions[EXTENSION_ID] === 'object') {
        return clone(metadata.extensions[EXTENSION_ID]);
      }
      const legacyState = metadata.variables?.[STATE_KEY];
      if (legacyState && typeof legacyState === 'object') {
        metadata.extensions[EXTENSION_ID] = { [STATE_KEY]: clone(legacyState) };
        liveContext().saveMetadataDebounced?.();
        return clone(metadata.extensions[EXTENSION_ID]);
      }
      metadata.extensions[EXTENSION_ID] = {};
      return {};
    }

    function saveChatState(value) {
      const metadata = currentMetadata();
      if (!metadata) return;
      metadata.extensions ??= {};
      metadata.extensions[EXTENSION_ID] = clone(value);
      liveContext().saveMetadataDebounced?.();
    }

    function mountButton() {
      if (button || !document?.createElement) return;
      const target = document.querySelector?.('#extensionsMenu');
      if (!target) {
        const Observer = window?.MutationObserver ?? globalThis.MutationObserver;
        if (!menuObserver && Observer && document.body) {
          menuObserver = new Observer(mountButton);
          menuObserver.observe(document.body, { childList: true, subtree: true });
        }
        return;
      }
      menuObserver?.disconnect();
      menuObserver = null;
      menuContainer = document.createElement('div');
      menuContainer.id = 'tw-story-planner-v1-wand-container';
      menuContainer.className = 'extension_container';
      button = document.createElement('div');
      button.id = 'tw-story-planner-v1-open';
      button.className = 'list-group-item flex-container flexGap5';
      button.tabIndex = 0;
      button.setAttribute('role', 'button');
      button.setAttribute('aria-label', '打开剧情规划器');
      const icon = document.createElement('div');
      icon.className = 'fa-fw fa-solid fa-scroll extensionsMenuExtensionButton';
      icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = '剧情规划器';
      button.append(icon, label);
      button.addEventListener('click', () => { for (const listener of buttonListeners) listener(); });
      button.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        for (const listener of buttonListeners) listener();
      });
      menuContainer.append(button);
      target.append(menuContainer);
    }

    function subscribe(eventName, listener) {
      if (eventName === BUTTON_EVENT) {
        buttonListeners.add(listener);
        mountButton();
        return { stop: () => buttonListeners.delete(listener) };
      }
      if (typeof eventName !== 'string' || typeof listener !== 'function') return { stop() {} };
      context.eventSource.on(eventName, listener);
      const disposer = () => {
        if (typeof context.eventSource.removeListener === 'function') context.eventSource.removeListener(eventName, listener);
        else context.eventSource.off?.(eventName, listener);
        activeListeners.delete(disposer);
      };
      activeListeners.add(disposer);
      return { stop: disposer };
    }

    const host = {
      version: VERSION,
      platform: capabilities.platform,
      console,
      document,
      parent: window,
      notifyError(message) { window?.toastr?.error?.(message); },
      setInterval: window?.setInterval?.bind(window),
      clearInterval: window?.clearInterval?.bind(window),
      addEventListener: window?.addEventListener?.bind(window),
      removeEventListener: window?.removeEventListener?.bind(window),
      tavern_events: {
        MESSAGE_RECEIVED: eventTypes.MESSAGE_RECEIVED,
        MESSAGE_SWIPED: eventTypes.MESSAGE_SWIPED,
        MESSAGE_UPDATED: eventTypes.MESSAGE_UPDATED,
        MESSAGE_DELETED: eventTypes.MESSAGE_DELETED,
        CHAT_CHANGED: eventTypes.CHAT_CHANGED,
        GENERATION_STARTED: eventTypes.GENERATION_STARTED,
        GENERATION_ENDED: eventTypes.GENERATION_ENDED,
        GENERATION_STOPPED: eventTypes.GENERATION_STOPPED,
        TOOL_CALLS_PERFORMED: eventTypes.TOOL_CALLS_PERFORMED,
      },
      eventOn: subscribe,
      getButtonEvent: () => BUTTON_EVENT,
      getLastMessageId: () => liveContext().chat.length - 1,
      getChatMessages(range, options = {}) {
        const [start, end] = String(range).split('-').map(Number);
        return liveContext().chat.slice(start, end + 1).map((message, offset) => {
          const explicitRole = typeof message?.role === 'string' ? message.role : null;
          const role = explicitRole ?? (message?.is_user ? 'user' : message?.is_system ? 'system' : 'assistant');
          return {
            message_id: start + offset,
            role,
            message: String(message?.mes ?? message?.message ?? message?.content ?? ''),
            is_hidden: message?.is_hidden === true || message?.extra?.is_hidden === true
              || (role !== 'tool' && message?.is_system === true),
            ...(Array.isArray(message?.tool_calls) ? { tool_calls: clone(message.tool_calls) } : {}),
            ...(typeof message?.tool_call_id === 'string' ? { tool_call_id: message.tool_call_id } : {}),
            ...(typeof message?.name === 'string' ? { name: message.name } : {}),
            ...(options.include_swipes ? { swipes: clone(message?.swipes ?? []) } : {}),
          };
        });
      },
      getVariables({ type } = {}) {
        return type === 'chat' ? chatState() : clone(nativeSettings());
      },
      updateVariablesWith(updater, { type } = {}) {
        if (type === 'chat') saveChatState(updater(chatState()));
        else {
          settingsRoot()[EXTENSION_ID] = updater(clone(nativeSettings()));
          pendingSettingsSave = liveContext().saveSettingsDebounced?.() ?? null;
          if (pendingSettingsSave && typeof pendingSettingsSave.then === 'function') {
            // Preset edits may not await this callback; preserve its rejection
            // for callers that explicitly ask for confirmation.
            void Promise.resolve(pendingSettingsSave).catch(() => {});
          }
        }
      },
      async persistVariables({ type } = {}) {
        const current = liveContext();
        if (type === 'chat') {
          const metadata = current.chatMetadata;
          if (!metadata || typeof metadata !== 'object') throw new Error('当前聊天 metadata 不可用');
          if (typeof current.saveMetadata !== 'function') throw new Error('当前宿主没有可等待的聊天 metadata 保存接口');
          // Invoke while this context and metadata are still current. TauriTavern's
          // saveMetadata captures a header snapshot and queues it for this chat.
          const pendingSave = current.saveMetadata.call(current);
          await pendingSave;
          return { type: 'chat', confirmed: true };
        }
        if (type === 'script') {
          const pendingSave = pendingSettingsSave;
          if (pendingSave && typeof pendingSave.then === 'function') await pendingSave;
          return { type: 'script', confirmed: Boolean(pendingSave && typeof pendingSave.then === 'function') };
        }
        throw new Error('不支持的持久化范围');
      },
      async generateRaw(request) {
        const current = liveContext();
        if (!current.ChatCompletionService?.createRequestData) throw new Error('当前 SillyTavern 未提供 ChatCompletionService');
        const api = request.custom_api ?? {};
        const isTauri = capabilities.platform === 'tauritavern';
        const controller = new AbortController();
        controllers.set(request.generation_id, controller);
        const prepared = current.ChatCompletionService.createRequestData({
          stream: false,
          ...(isTauri ? { type: 'quiet' } : {}),
          chat_completion_source: 'openai',
          use_sysprompt: false,
          reverse_proxy: normalizeApiBase(api.apiurl),
          proxy_password: api.key,
          model: api.model,
          max_tokens: api.max_tokens,
          temperature: api.temperature,
          messages: request.ordered_prompts ?? [],
          ...(request.tools ? { tools: request.tools, tool_choice: request.tool_choice } : {}),
        });
        const payload = isTauri
          ? { ...prepared, type: 'quiet', messages: clone(request.ordered_prompts ?? []) }
          : prepared;
        if (isTauri) {
          if (request.tools) {
            payload.tools = clone(request.tools);
            payload.tool_choice = clone(request.tool_choice);
          } else {
            delete payload.tools;
            delete payload.tool_choice;
          }
        }
        const requestMessages = summarizeMessages(request.ordered_prompts);
        const payloadMessages = summarizeMessages(payload.messages);
        const payloadMatchesRequest = requestMessages.fingerprint === payloadMessages.fingerprint;
        window?.console?.info?.('[剧情规划器][诊断][请求]', {
          requestedToolCount: Array.isArray(request.tools) ? request.tools.length : 0,
          toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
          hasTools: Array.isArray(payload.tools) && payload.tools.length > 0,
          toolNames: Array.isArray(payload.tools) ? payload.tools.map(tool => tool?.function?.name).filter(name => typeof name === 'string') : [],
          toolParameterNames: Array.isArray(payload.tools) ? payload.tools.map(tool => Object.keys(tool?.function?.parameters?.properties ?? {})) : [],
          toolChoice: payload.tool_choice?.function?.name
            ?? (typeof payload.tool_choice === 'string' ? payload.tool_choice : typeof payload.tool_choice),
          messageCount: payloadMessages.messageCount,
          messageRoles: payloadMessages.roles.filter(role => typeof role === 'string'),
          promptTransfer: {
            stage: 'request_to_chat_completion_payload',
            requestMessages,
            payloadMessages,
            matches: payloadMatchesRequest,
          },
          payloadKeys: Object.keys(payload),
          stream: payload.stream === true,
        });
        try {
          const send = window?.fetch?.bind(window) ?? globalThis.fetch;
          if (typeof send !== 'function') throw new Error('当前浏览器未提供 fetch');
          const body = JSON.stringify(payload);
          let bodyMessages = null;
          try { bodyMessages = summarizeMessages(JSON.parse(body)?.messages); }
          catch { /* The serialized body itself will still be sent; keep this diagnostic non-blocking. */ }
          window?.console?.info?.('[剧情规划器][诊断][发送前]', {
            target: '/api/backends/chat-completions/generate',
            method: 'POST',
            bodyStringified: typeof body === 'string',
            requestToBodyMessagesMatch: Boolean(bodyMessages && requestMessages.fingerprint === bodyMessages.fingerprint),
            bodyMessages,
          });
          const response = await send('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: current.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
            cache: 'no-cache',
            body,
            signal: controller.signal,
          });
          let json;
          try {
            // SPreset may replace json() on the original response instance.
            // Consume only the clone, including for diagnostics, so planner requests
            // never invoke the main chat preset's output processing.
            if (typeof response.clone !== 'function') throw new Error('clone_unavailable');
            json = await response.clone().json();
          }
          catch {
            logResponseDiagnostics(window?.console, response, null, false,
              typeof response.clone === 'function' ? 'invalid_json_or_clone_read_failed' : 'clone_unavailable');
            if (!response.ok) {
              throw responseFailure(response, null, isTauri);
            }
            const failure = new Error('规划 API 返回格式不是有效 JSON');
            failure.code = 'INVALID_RESPONSE';
            throw failure;
          }
          logResponseDiagnostics(window?.console, response, json, true);
          if (!response.ok || json?.error) {
            throw responseFailure(response, json, isTauri);
          }
          return json;
        } catch (error) {
          if (!error?.status && error?.code !== 'INVALID_RESPONSE' && error?.code !== 'API_RESPONSE_ERROR') {
            window?.console?.info?.('[剧情规划器][诊断][请求失败]', {
              kind: controller.signal.aborted ? 'aborted' : 'network_or_browser',
            });
          }
          if (controller.signal.aborted) {
            const cancelled = new Error('规划请求已取消');
            cancelled.code = 'CANCELLED';
            throw cancelled;
          }
          if (error?.name === 'TypeError' || error?.name === 'AbortError') {
            const network = new Error('规划请求网络失败');
            network.code = 'NETWORK';
            throw network;
          }
          throw error;
        } finally {
          controllers.delete(request.generation_id);
        }
      },
      async getModelList(api) {
        const response = await fetch('/api/backends/chat-completions/status', {
          method: 'POST',
          headers: liveContext().getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
          cache: 'no-cache',
          body: JSON.stringify({ chat_completion_source: 'openai', reverse_proxy: normalizeApiBase(api.apiurl), proxy_password: api.key }),
        });
        const json = await response.json();
        if (!response.ok || json.error) throw new Error('模型列表请求失败');
        const entries = json?.data?.data ?? json?.data ?? json?.models ?? [];
        return Array.isArray(entries) ? entries.map(item => typeof item === 'string' ? item : item?.id).filter(value => typeof value === 'string') : [];
      },
      stopGenerationById(id) { controllers.get(id)?.abort(); return true; },
      substitudeMacros(value) { return liveContext().substituteParams?.(value) ?? value; },
      async getCharacter() {
        const current = liveContext();
        const character = current.characters?.[current.characterId];
        if (!character) return null;
        return {
          description: character.description ?? character.data?.description ?? '',
          personality: character.personality ?? character.data?.personality ?? '',
          scenario: character.scenario ?? character.data?.scenario ?? '',
          mes_example: character.mes_example ?? character.data?.mes_example ?? '',
        };
      },
      getGlobalWorldbookNames() {
        const current = liveContext();
        return worldNames(current.powerUserSettings?.world_info ?? current.chatCompletionSettings?.world_info ?? []);
      },
      getCharWorldbookNames() {
        const current = liveContext();
        const character = current.characters?.[current.characterId];
        const extensions = character?.data?.extensions ?? {};
        const additional = extensions.auxiliary_worlds ?? extensions.worlds ?? [];
        return { primary: typeof extensions.world === 'string' ? extensions.world : null, additional: worldNames(additional) };
      },
      getChatWorldbookName() {
        const value = currentMetadata()?.world_info ?? currentMetadata()?.world;
        return typeof value === 'string' ? value : null;
      },
      async getWorldbook(name) {
        const loadWorldInfo = liveContext().loadWorldInfo;
        if (typeof loadWorldInfo !== 'function') throw new Error('当前 SillyTavern 未提供 loadWorldInfo');
        const world = await loadWorldInfo(name);
        const entries = world?.entries;
        if (!entries || typeof entries !== 'object') return [];
        return Object.entries(entries).map(([uid, entry]) => convertWorldInfoEntry(entry, uid)).filter(Boolean);
      },
      destroy() {
        for (const dispose of [...activeListeners]) dispose();
        for (const controller of controllers.values()) controller.abort();
        controllers.clear();
        buttonListeners.clear();
        menuObserver?.disconnect();
        menuObserver = null;
        menuContainer?.remove();
        menuContainer = null;
        button = null;
      },
    };
    const readyEvent = eventTypes.APP_READY;
    if (typeof readyEvent === 'string') subscribe(readyEvent, mountButton);
    mountButton();
    return host;
  }

  return { EXTENSION_ID, VERSION, STATE_KEY, BUTTON_EVENT, normalizeApiBase, convertWorldInfoEntry, inspectHostCapabilities, createNativeHost };
});
