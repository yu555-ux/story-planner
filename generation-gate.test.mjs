import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGenerationGate } = require('./generation-gate.js');

function fixture(overrides = {}) {
  const listeners = new Map();
  const context = {
    eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'prompt_ready', GENERATION_STARTED: 'started',
      GENERATION_ENDED: 'ended', GENERATION_STOPPED: 'stopped', CHAT_CHANGED: 'changed' },
    eventSource: {
      on(name, listener) { listeners.set(name, listener); },
      removeListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    },
  };
  const snapshot = {
    overall: { body: '核心主题：探索' },
    volume: { stageTitle: '关键事件一', stageContent: '进入古城' },
    event: { stageTitle: '阶段1', stageContent: '找到入口' },
    fine: { stageTitle: '阶段1', stageContent: '夜晚在城门观察' },
  };
  const runtime = { gate: {
    isEnabled: () => true,
    getCurrentTurn: () => ({ kind: 'initial', chatIdentity: 'chat-a', userMessageId: 1 }),
    getChatIdentity: () => 'chat-a',
    ensureVariablePlannerReady: async () => snapshot,
    beginVariablePlannerTurn: async () => snapshot,
    isVariablePlannerSnapshotCurrent: () => true,
    confirmVariablePlannerTurnInjected: () => true,
    clearVariablePlannerTurn() {},
    ...overrides,
  } };
  return { listeners, context, runtime, snapshot };
}

test('variable gate waits for four-layer plan and injects only current stages', async () => {
  const { listeners, context, runtime } = fixture();
  const gate = createGenerationGate(runtime, context);
  let aborted = false;
  await gate.interceptor([], 2048, value => { aborted = value; }, 'normal');
  const prompt = { chat: [{ role: 'user', content: '开始' }] };
  listeners.get('prompt_ready')(prompt);
  assert.equal(aborted, false);
  assert.equal(prompt.chat.length, 3);
  assert.match(prompt.chat[1].content, /planner_update/);
  assert.match(prompt.chat[2].content, /夜晚在城门观察/);
  assert.doesNotMatch(JSON.stringify(prompt.chat), /<outline>/);
  gate.destroy();
  assert.equal(listeners.size, 0);
});

test('planning failure blocks body generation', async () => {
  const { context, runtime } = fixture({ ensureVariablePlannerReady: async () => { throw new Error('API 失败'); } });
  const notices = [];
  const gate = createGenerationGate(runtime, context, { notify: value => notices.push(value) });
  let aborted = false;
  await gate.interceptor([], 2048, value => { aborted = value; }, 'normal');
  assert.equal(aborted, true);
  assert.match(notices[0], /API 失败/);
  gate.destroy();
});

test('a chat switch discards a pending plan before prompt injection', async () => {
  let identity = 'chat-a';
  const { listeners, context, runtime } = fixture({ getChatIdentity: () => identity });
  const gate = createGenerationGate(runtime, context);
  await gate.interceptor([], 2048, () => {}, 'normal');
  identity = 'chat-b';
  const prompt = { chat: [{ role: 'user', content: '新聊天' }] };
  listeners.get('prompt_ready')(prompt);
  assert.equal(prompt.chat.length, 1);
  gate.destroy();
});
