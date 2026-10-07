import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGenerationGate } = require('./generation-gate.js');

function makeContext() {
  const listeners = new Map();
  const eventTypes = {
    CHAT_COMPLETION_PROMPT_READY: 'prompt_ready',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
    CHAT_CHANGED: 'chat_changed',
  };
  return {
    listeners,
    context: {
      eventTypes,
      eventSource: {
        on(name, fn) { listeners.set(name, fn); },
        removeListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
      },
    },
  };
}

test('initial send waits for a valid outline and appends the complete tag to the final prompt message', async () => {
  const { context, listeners } = makeContext();
  let resolveOutline;
  let activeOutline = null;
  const runtime = { gate: {
    isEnabled: () => true,
    getCurrentTurn: () => ({ kind: 'initial', chatIdentity: 'chat-a', userMessageId: 1 }),
    ensureInitialOutline: () => new Promise(resolve => { resolveOutline = value => { activeOutline = value; resolve(value); }; }),
    getActiveOutline: () => activeOutline,
    getChatIdentity: () => 'chat-a',
  } };
  const gate = createGenerationGate(runtime, context, { notify() {} });
  let aborted = false;
  const pending = gate.interceptor([], 2048, () => { aborted = true; }, 'normal');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(aborted, false);
  resolveOutline({ fullTag: '<outline>初始</outline>' });
  await pending;
  assert.equal(aborted, false);
  const prompt = { chat: [{ role: 'user', content: '玩家消息' }], dryRun: false };
  listeners.get('prompt_ready')(prompt);
  assert.deepEqual(prompt.chat.at(-1), { role: 'system', content: '<outline>初始</outline>' });
  gate.destroy();
  assert.equal(listeners.size, 0);
});

test('initial planning failure aborts the native SillyTavern generation', async () => {
  const { context } = makeContext();
  const runtime = { gate: {
    isEnabled: () => true,
    getCurrentTurn: () => ({ kind: 'initial', chatIdentity: 'chat-a', userMessageId: 1 }),
    ensureInitialOutline: async () => { throw new Error('API unavailable'); },
    getActiveOutline: () => null,
    getChatIdentity: () => 'chat-a',
  } };
  const gate = createGenerationGate(runtime, context, { notify() {} });
  let aborted = false;
  await gate.interceptor([], 2048, immediate => { aborted = immediate; }, 'normal');
  assert.equal(aborted, true);
  gate.destroy();
});

test('chat switch while foreground planning is pending prevents stale prompt injection', async () => {
  const { context, listeners } = makeContext();
  let chatIdentity = 'chat-a';
  let resolveOutline;
  const runtime = { gate: {
    isEnabled: () => true,
    getCurrentTurn: () => ({ kind: 'normal', chatIdentity, userMessageId: 3 }),
    ensureCurrentOutline: () => new Promise(resolve => { resolveOutline = resolve; }),
    getActiveOutline: () => null,
    getChatIdentity: () => chatIdentity,
  } };
  const gate = createGenerationGate(runtime, context, { notify() {} });
  let aborted = false;
  const pending = gate.interceptor([], 2048, immediate => { aborted = immediate; }, 'normal');
  await new Promise(resolve => setImmediate(resolve));
  chatIdentity = 'chat-b';
  listeners.get('chat_changed')?.();
  resolveOutline({ id: 'old-chat-outline', fullTag: '<outline>旧聊天细纲</outline>' });
  await pending;
  const prompt = { chat: [{ role: 'user', content: '新聊天输入' }], dryRun: false };
  listeners.get('prompt_ready')(prompt);
  assert.equal(aborted, true);
  assert.equal(prompt.chat.length, 1);
  gate.destroy();
});

test('disabled gate records why it did not call the planning API', async () => {
  const { context } = makeContext();
  const logs = [];
  const runtime = { gate: {
    isEnabled: () => false,
    getCurrentTurn: () => { throw new Error('disabled gate should not inspect chat'); },
  } };
  const gate = createGenerationGate(runtime, context, { logger: { info: (...items) => logs.push(items) } });
  await gate.interceptor([], 2048, () => {}, 'normal');
  assert.match(JSON.stringify(logs), /已关闭/);
  gate.destroy();
});

test('initial failure notification includes a safe classified reason', async () => {
  const { context } = makeContext();
  const notices = [];
  const runtime = { gate: {
    isEnabled: () => true,
    getCurrentTurn: () => ({ kind: 'initial', chatIdentity: 'chat-a', userMessageId: 1 }),
    ensureInitialOutline: async () => { throw Object.assign(new Error('private backend response'), { status: 404 }); },
    describeFailure: error => `HTTP ${error.status}：接口路径或模型不存在。`,
  } };
  const gate = createGenerationGate(runtime, context, { notify: value => notices.push(value) });
  let aborted = false;
  await gate.interceptor([], 2048, immediate => { aborted = immediate; }, 'normal');
  assert.equal(aborted, true);
  assert.match(notices[0], /HTTP 404/);
  assert.doesNotMatch(notices[0], /private backend response/);
  gate.destroy();
});
