(function attachGenerationGate(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TWStoryPlannerGenerationGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createGenerationGateModule() {
  'use strict';

  function validOutline(value) {
    return typeof value === 'string'
      && /^<outline(?:\s[^<>]*)?>[\s\S]*?<\/outline\s*>$/i.test(value.trim())
      && (value.match(/<outline(?:\s[^<>]*)?>/gi) ?? []).length === 1
      && (value.match(/<\/outline\s*>/gi) ?? []).length === 1
      && Boolean(value.match(/^<outline(?:\s[^<>]*)?>([\s\S]*?)<\/outline\s*>$/i)?.[1]?.trim());
  }

  function createGenerationGate(runtime, context, { notify = () => {}, logger = {} } = {}) {
    const events = context?.eventTypes ?? context?.event_types ?? {};
    const eventSource = context?.eventSource;
    const promptEvent = events.CHAT_COMPLETION_PROMPT_READY;
    const clearEvents = [events.GENERATION_STOPPED, events.GENERATION_ENDED, events.CHAT_CHANGED].filter(value => typeof value === 'string');
    let pending = null;
    let planning = false;
    let destroyed = false;
    const listeners = [];
    const ready = typeof promptEvent === 'string' && typeof eventSource?.on === 'function'
      && (runtime.gate.version !== 2 || [events.GENERATION_STARTED, events.GENERATION_ENDED].every(value => typeof value === 'string'));

    function subscribe(name, handler) {
      if (typeof name !== 'string') return;
      eventSource.on(name, handler);
      listeners.push(() => {
        if (typeof eventSource.removeListener === 'function') eventSource.removeListener(name, handler);
        else eventSource.off?.(name, handler);
      });
    }

    function reportFailure(error = null) {
      if (/规划已取消|聊天已切换|chat changed/.test(error?.message ?? '')) return;
      const reason = error && runtime.gate.describeFailure?.(error);
      notify(reason
        ? `本轮细纲失败：${reason} 本次酒馆回复已阻止。`
        : '本轮细纲未完成，本次酒馆回复已阻止。请检查规划器后重试。');
    }

    function onPromptReady(event) {
      if (!pending || event?.dryRun || !Array.isArray(event?.chat)) return;
      if (runtime.gate.getChatIdentity() !== pending.chatIdentity) { pending = null; return; }
      const active = runtime.gate.getActiveOutline({ chatIdentity: pending.chatIdentity, type: pending.type, recordId: pending.recordId });
      if (!validOutline(active?.fullTag)) { pending = null; return; }
      if (runtime.gate.markUsing && !runtime.gate.markUsing(active.id, pending.type)) { pending = null; return; }
      const fullTag = active.fullTag;
      event.chat.push({ role: 'system', content: fullTag });
      pending = null;
    }

    subscribe(promptEvent, onPromptReady);
    const clearPending = () => { pending = null; };
    for (const eventName of clearEvents) subscribe(eventName, clearPending);
    subscribe(events.GENERATION_STOPPED, () => runtime.gate.clearClaim?.());

    async function interceptor(_chat, _contextSize, abort, type) {
      if (destroyed || ['quiet', 'impersonate', 'dry_run'].includes(type)) return;
      if (runtime.gate.isEnabled() === false) {
        logger.info?.('[剧情规划器][生成拦截] 已关闭，跳过规划 API');
        return;
      }
      if (!ready) {
        abort(true);
        reportFailure();
        return;
      }
      if (planning || pending) {
        abort(true);
        return;
      }
      const turn = runtime.gate.getCurrentTurn(type);
      logger.info?.('[剧情规划器][生成拦截]', { enabled: true, turn: turn.kind });
      if (turn.kind === 'skip') return;
      const { chatIdentity, userMessageId } = turn;
      try {
        planning = true;
        const outline = runtime.gate.ensureCurrentOutline
          ? await runtime.gate.ensureCurrentOutline({ chatIdentity, userMessageId, type })
          : turn.kind === 'initial'
            ? await runtime.gate.ensureInitialOutline({ chatIdentity, userMessageId })
            : runtime.gate.getActiveOutline({ chatIdentity });
        if (runtime.gate.getChatIdentity() !== chatIdentity) throw new Error('chat changed');
        if (!outline) throw new Error('规划结果须包含一对完整的 <outline> 标签');
        if (!validOutline(outline.fullTag)) throw new Error('invalid outline');
        pending = { chatIdentity, fullTag: outline.fullTag, recordId: outline.id, type };
      } catch (error) {
        abort(true);
        reportFailure(error);
      } finally {
        planning = false;
      }
    }

    return {
      interceptor,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        pending = null;
        while (listeners.length) {
          try { listeners.pop()(); } catch { /* cleanup remains best effort */ }
        }
      },
      get ready() { return ready; },
    };
  }

  return { validOutline, createGenerationGate };
});
