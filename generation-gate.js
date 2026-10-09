(function attachGenerationGate(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TWStoryPlannerGenerationGate = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createGenerationGateModule() {
  'use strict';

  function createGenerationGate(runtime, context, { notify = () => {}, logger = {} } = {}) {
    const events = context?.eventTypes ?? context?.event_types ?? {};
    const eventSource = context?.eventSource;
    let pending = null;
    let planning = false;
    let destroyed = false;
    const listeners = [];
    const ready = typeof events.CHAT_COMPLETION_PROMPT_READY === 'string'
      && typeof eventSource?.on === 'function'
      && [events.GENERATION_STARTED, events.GENERATION_ENDED].every(value => typeof value === 'string');

    function subscribe(name, handler) {
      if (typeof name !== 'string') return;
      eventSource.on(name, handler);
      listeners.push(() => {
        if (typeof eventSource.removeListener === 'function') eventSource.removeListener(name, handler);
        else eventSource.off?.(name, handler);
      });
    }

    function reportFailure(error) {
      if (/规划已取消|聊天已切换|chat changed/.test(error?.message ?? '')) return;
      const reason = runtime.gate.describeFailure?.(error) ?? error?.message ?? '变量剧情规划未完成';
      notify(`${reason}；本次酒馆回复已阻止。`);
    }

    function onPromptReady(event) {
      if (!pending) return;
      const { chatIdentity, snapshot } = pending;
      pending = null;
      if (event?.dryRun || !Array.isArray(event?.chat)
        || runtime.gate.getChatIdentity() !== chatIdentity
        || !runtime.gate.isVariablePlannerSnapshotCurrent(snapshot)
        || runtime.gate.confirmVariablePlannerTurnInjected(snapshot) !== true) {
        runtime.gate.clearVariablePlannerTurn();
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
    }

    subscribe(events.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    subscribe(events.GENERATION_ENDED, () => { pending = null; });
    subscribe(events.CHAT_CHANGED, () => { pending = null; });
    subscribe(events.GENERATION_STOPPED, () => {
      runtime.gate.clearVariablePlannerTurn();
      pending = null;
    });

    async function interceptor(_chat, _contextSize, abort, type) {
      if (destroyed || ['quiet', 'impersonate', 'dry_run'].includes(type)) return;
      if (!runtime.gate.isEnabled()) return;
      if (!ready || planning || pending) {
        abort(true);
        reportFailure(new Error('变量剧情器尚未准备好'));
        return;
      }
      const turn = runtime.gate.getCurrentTurn(type);
      logger.info?.('[剧情规划器][生成拦截]', { enabled: true, turn: turn.kind });
      if (turn.kind === 'skip') return;
      const { chatIdentity, userMessageId } = turn;
      let turnStarted = false;
      try {
        planning = true;
        await runtime.gate.ensureVariablePlannerReady({ chatIdentity, userMessageId, turnKind: turn.kind });
        if (runtime.gate.getChatIdentity() !== chatIdentity) throw new Error('聊天已切换');
        const snapshot = await runtime.gate.beginVariablePlannerTurn(userMessageId, chatIdentity);
        turnStarted = Boolean(snapshot);
        if (!snapshot) throw new Error('无法取得完整的活动阶段快照');
        if (runtime.gate.getChatIdentity() !== chatIdentity) throw new Error('聊天已切换');
        pending = { chatIdentity, snapshot };
      } catch (error) {
        if (turnStarted) runtime.gate.clearVariablePlannerTurn();
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

  return { createGenerationGate };
});
