import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = require('./planner.js');

test('variable planning sends only preset messages and expands opted-in task context', async () => {
  const preset = {
    id: 'outline', name: '上层规划', raw: {},
    prompts: [{ identifier: 'task', name: '任务', role: 'system',
      content: '输出当前层级：{{planner_kind}}。上下文：{{planner_context}}', enabled: true }],
    promptOrder: [{ identifier: 'task', enabled: true }],
  };
  const messages = [
    { message_id: 0, role: 'assistant', message: '开场' },
    { message_id: 1, role: 'user', message: '开始' },
  ];
  let chat = {};
  const script = { plannerPresets: [preset], activeOutlinePresetId: preset.id,
    activeFinePresetId: preset.id, activePlannerPresetId: preset.id };
  let sent;
  const host = {
    console: { info() {}, warn() {}, error() {} },
    tavern_events: { MESSAGE_RECEIVED: 'received', CHAT_CHANGED: 'changed' },
    eventOn: () => ({ stop() {} }),
    getLastMessageId: () => 1,
    getChatMessages: () => messages,
    getVariables: ({ type }) => type === 'chat' ? chat : script,
    updateVariablesWith: (update, { type }) => {
      if (type === 'chat') chat = update(chat);
      else Object.assign(script, update(script));
    },
    stopGenerationById() {},
    generateRaw: request => { sent = request; throw new Error('captured request'); },
  };
  const runtime = engine.createTavernRuntime(host, { enabled: true,
    apiurl: 'https://example.test/v1', model: 'test-model', retryCount: 0 });
  await assert.rejects(runtime.gate.ensureVariablePlannerReady({
    chatIdentity: runtime.gate.getChatIdentity(), userMessageId: 1, turnKind: 'initial',
  }), /captured request/);
  assert.ok(sent);
  assert.equal(sent.ordered_prompts.filter(item => item.content.includes('输出当前层级')).length, 1);
  assert.equal(sent.ordered_prompts.some(item => item.content.includes('你正在为 SillyTavern 剧情规划器')), false);
  assert.equal(sent.ordered_prompts.some(item => item.content.includes('{{planner_kind}}')), false);
  assert.equal(sent.ordered_prompts.some(item => item.content.includes('initial')), true);
  runtime.destroy();
});
