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
    let pending = null;
    let planning = false;
    let destroyed = false;
    const listeners = [];
    const ready = typeof promptEvent === 'string' && typeof eventSource?.on === 'function'
      && (![2, 3].includes(runtime.gate.version)
        || [events.GENERATION_STARTED, events.GENERATION_ENDED].every(value => typeof value === 'string'));

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
      if (/新版变量剧情/.test(error?.message ?? '')) {
        notify(`${error.message} 本次酒馆回复已阻止。`);
        return;
      }
      const reason = error && runtime.gate.describeFailure?.(error);
      notify(reason
        ? `本轮细纲失败：${reason} 本次酒馆回复已阻止。`
        : '本轮细纲未完成，本次酒馆回复已阻止。请检查规划器后重试。');
    }

    function onPromptReady(event) {
      if (!pending) return;
      if (event?.dryRun || !Array.isArray(event?.chat)) {
        if (pending.variableSnapshot) runtime.gate.clearVariablePlannerTurn?.();
        pending = null;
        return;
      }
      if (runtime.gate.getChatIdentity() !== pending.chatIdentity) {
        if (pending.variableSnapshot) runtime.gate.clearVariablePlannerTurn?.();
        pending = null;
        return;
      }
      if (pending.variableSnapshot) {
        const snapshot = pending.variableSnapshot;
        if (!runtime.gate.isVariablePlannerSnapshotCurrent?.(snapshot)) {
          pending = null;
          runtime.gate.clearVariablePlannerTurn?.();
          return;
        }
        const confirmed = runtime.gate.confirmVariablePlannerTurnInjected?.(snapshot);
        if (confirmed !== true) {
          pending = null;
          runtime.gate.clearVariablePlannerTurn?.();
          return;
        }
        const rules = [
          '把提纲当作剧情方向，承接玩家行动、已经发生的事实，并遵守角色有限视角。',
          '只有本轮确实写完相应层级的当前阶段时才报告 true；未完成或未涉及时可省略，缺省按 false。',
          '在最终正文末尾输出 <planner_update>。只允许使用以下白名单路径：',
          'set(卷纲.阶段完成, true)；set(事件纲.阶段完成, true)；set(细纲.阶段完成, true)。',
          '需要重写时另写 set(重写.需要, true)、set(重写.问题提纲, "卷纲") 和 set(重写.问题说明, "具体原因与应保留目标")；问题提纲只能填写“卷纲”“事件纲”或“细纲”之一。不重写时可省略这三项。',
          '问题说明使用 JSON 字符串转义。不要输出其他 set 路径。',
        ].join('\n');
        const section = (label, item) => `${label} · ${item.stageTitle}\n${item.stageContent}`;
        const dynamic = [
          snapshot.overall ? `总纲方向\n${snapshot.overall.body}` : '',
          section('当前卷纲阶段', snapshot.volume),
          section('当前事件纲阶段', snapshot.event),
          section('当前细纲阶段', snapshot.fine),
        ].filter(Boolean).join('\n\n');
        event.chat.push({ role: 'system', content: rules });
        event.chat.push({ role: 'system', content: dynamic });
        pending = null;
        return;
      }
      const active = runtime.gate.getActiveOutline({ chatIdentity: pending.chatIdentity, type: pending.type, recordId: pending.recordId });
      if (!validOutline(active?.fullTag)) { pending = null; return; }
      if (runtime.gate.markUsing && !runtime.gate.markUsing(active.id, pending.type)) { pending = null; return; }
      const fullTag = active.fullTag;
      event.chat.push({ role: 'system', content: fullTag });
      pending = null;
    }

    subscribe(promptEvent, onPromptReady);
    subscribe(events.GENERATION_ENDED, () => { pending = null; });
    subscribe(events.CHAT_CHANGED, () => { pending = null; });
    subscribe(events.GENERATION_STOPPED, () => {
      runtime.gate.clearVariablePlannerTurn?.();
      pending = null;
      runtime.gate.clearClaim?.();
    });

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
      let variableTurnStarted = false;
      try {
        planning = true;
        const useVariablePlanner = runtime.gate.shouldUseVariablePlannerTurn?.(turn)
          ?? runtime.gate.hasVariablePlannerState?.();
        if (useVariablePlanner) {
          if (typeof runtime.gate.ensureVariablePlannerReady !== 'function') {
            throw new Error('新版变量剧情规划 API 尚未连接');
          }
          await runtime.gate.ensureVariablePlannerReady({ chatIdentity, userMessageId, turnKind: turn.kind });
          if (runtime.gate.getChatIdentity() !== chatIdentity) throw new Error('chat changed');
          variableTurnStarted = true;
          const variableSnapshot = await runtime.gate.beginVariablePlannerTurn?.(userMessageId, chatIdentity);
          if (runtime.gate.getChatIdentity() !== chatIdentity) throw new Error('chat changed');
          if (!variableSnapshot) throw new Error('新版变量剧情无法取得完整活动阶段快照');
          pending = { chatIdentity, type, variableSnapshot };
          return;
        }
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
        if (variableTurnStarted && runtime.gate.getChatIdentity() === chatIdentity) runtime.gate.clearVariablePlannerTurn?.();
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
