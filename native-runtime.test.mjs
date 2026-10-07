import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = require('./planner.js');
const { createNativeHost, EXTENSION_ID } = require('./runtime-adapter.js');
const { createGenerationGate } = require('./generation-gate.js');

test('first generation is gated after floor 1 user message and before floor 2 assistant reply', () => {
  const opening = { messageId: 0, role: 'assistant', content: '开场白' };
  const player = { messageId: 1, role: 'user', content: '玩家第一次输入' };
  const reply = { messageId: 2, role: 'assistant', content: '酒馆第一次回复' };
  assert.equal(engine.classifyPlanningTurn({ messages: [opening] }, {}), 'skip');
  assert.equal(engine.classifyPlanningTurn({ messages: [opening, player] }, {}), 'initial');
  assert.equal(engine.classifyPlanningTurn({ messages: [opening, player, reply] }, {}), 'normal');
});

test('activation status explains missing setup instead of showing a stale completed result', () => {
  const closed = engine.buildPanelViewModel({ enabled: false }, { status: 'ready', activeOutline: '<outline>旧结果</outline>' }, {}, false);
  assert.equal(closed.statusLabel, '自动规划已关闭');
  const missingApi = engine.buildPanelViewModel({ enabled: true }, {}, {}, false);
  assert.match(missingApi.activationHint, /API/);
  const missingPreset = engine.buildPanelViewModel({ enabled: true, apiurl: 'https://example.invalid/v1', model: 'planner' }, {}, {}, false);
  assert.match(missingPreset.activationHint, /预设/);
});

test('failure notices distinguish HTTP status, missing tool calls, missing outline, and empty replies', () => {
  const http = Object.assign(new Error('private backend text'), { status: 404 });
  assert.match(engine.classifyPlannerFailure(http).message, /HTTP 404/);
  assert.doesNotMatch(engine.classifyPlannerFailure(http).message, /private backend text/);
  assert.match(engine.classifyPlannerFailure(Object.assign(new Error('x'), { status: 429 })).message, /HTTP 429/);
  assert.match(engine.classifyPlannerFailure(Object.assign(new Error('x'), { status: 401 })).message, /密钥/);
  assert.match(engine.classifyPlannerFailure(Object.assign(new Error('x'), { status: 503 })).message, /服务端/);
  assert.match(engine.classifyPlannerFailure(new Error('规划 API 未返回 game_content 工具调用')).message, /game_content/);
  assert.match(engine.classifyPlannerFailure(new Error('规划结果须包含一对完整的 <outline> 标签')).message, /缺少.*<outline>/);
  assert.match(engine.classifyPlannerFailure(new Error('<outline> 内容为空')).message, /没有内容/);
  assert.match(engine.classifyPlannerFailure(new Error('规划 API 返回了空内容')).message, /空回复/);
  const empty = engine.parsePlannerResult({ choices: [{ message: { content: null, tool_calls: [] } }] }, 'game_content');
  assert.equal(empty.error, '规划 API 返回了空内容');
  assert.equal(engine.parsePlannerResult('<outline>普通文本</outline>', 'game_content').error, '规划 API 未返回 game_content 工具调用');
});

test('native stop cancels background planning, restores send controls, and requires rescue', async () => {
  const listeners = new Map();
  const events = { MESSAGE_RECEIVED: 'received', CHAT_CHANGED: 'changed', GENERATION_STARTED: 'started',
    GENERATION_ENDED: 'ended', GENERATION_STOPPED: 'stopped' };
  const emit = name => { for (const listener of listeners.get(name) ?? []) listener(); };
  const messages = [
    { message_id: 0, role: 'assistant', message: '开场' },
    { message_id: 1, role: 'user', message: '玩家行动' },
    { message_id: 2, role: 'assistant', message: '上一轮回复' },
  ];
  const preset = { id: 'simple', name: '简单规划', raw: {},
    prompts: [{ identifier: 'planner', name: '规划', role: 'system', content: '生成细纲', enabled: true }],
    promptOrder: [{ identifier: 'planner', enabled: true }] };
  let chatState = {};
  const scriptState = { plannerPresets: [preset], activePlannerPresetId: preset.id };
  let releaseFirst;
  let releaseManual;
  let calls = 0;
  const buttons = [];
  const host = {
    console: { info() {}, warn() {}, error() {} },
    tavern_events: events,
    eventOn(name, listener) {
      const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set);
      return { stop() { set.delete(listener); } };
    },
    getLastMessageId: () => messages.length - 1,
    getChatMessages: range => {
      const [first, last] = range.split('-').map(Number);
      return messages.slice(first, last + 1);
    },
    getVariables: ({ type }) => type === 'chat' ? chatState : scriptState,
    updateVariablesWith: (fn, { type }) => {
      if (type === 'chat') chatState = fn(chatState);
      else Object.assign(scriptState, fn(scriptState));
    },
    stopGenerationById() {},
    substitudeMacros: value => value,
    generateRaw: () => {
      calls += 1;
      if (calls === 1) return new Promise(resolve => { releaseFirst = resolve; });
      if (calls === 3) return new Promise(resolve => { releaseManual = resolve; });
      return Promise.resolve({ choices: [{ message: { content: '<outline>补救细纲</outline>' } }] });
    },
    setPlannerSendBusy(value) { buttons.push(value); if (!value) emit(events.GENERATION_ENDED); return true; },
  };
  const runtime = engine.createTavernRuntime(host, { enabled: true, apiurl: 'https://api.example/v1',
    key: 'secret', model: 'planner', retryCount: 0, timeoutSeconds: 20 });
  emit(events.MESSAGE_RECEIVED);
  for (let attempt = 0; attempt < 30 && calls < 1; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(buttons, [true]);
  emit(events.GENERATION_STOPPED);
  assert.deepEqual(buttons, [true, false]);
  assert.equal(chatState.__tw_story_planner_v1.lastTask.status, 'cancelled');
  releaseFirst({ choices: [{ message: { content: '<outline>迟到细纲</outline>' } }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chatState.__tw_story_planner_v1.outlineHistory.some(item => item.body === '迟到细纲'), false);
  messages.push({ message_id: 3, role: 'user', message: '继续' });
  assert.equal((await runtime.gate.ensureCurrentOutline({ chatIdentity: runtime.gate.getChatIdentity() })).body, '补救细纲');
  assert.equal(calls, 2);
  runtime.schedule('manual');
  for (let attempt = 0; attempt < 30 && calls < 3; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(buttons.at(-1), true);
  emit(events.CHAT_CHANGED);
  assert.equal(buttons.at(-1), false, 'chat switch must release planner-owned controls');
  releaseManual({ choices: [{ message: { content: '<outline>切换后的迟到细纲</outline>' } }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(chatState.__tw_story_planner_v1.outlineHistory.some(item => item.body === '切换后的迟到细纲'), false);
  runtime.destroy();
});

test('native runtime waits for initial planning, persists the outline, and injects it before chat generation', async () => {
  const listeners = new Map();
  const events = {
    MESSAGE_RECEIVED: 'message_received', CHAT_CHANGED: 'chat_changed',
    MESSAGE_SWIPED: 'message_swiped', MESSAGE_UPDATED: 'message_updated', MESSAGE_DELETED: 'message_deleted',
    CHAT_COMPLETION_PROMPT_READY: 'prompt_ready', GENERATION_STARTED: 'started', GENERATION_STOPPED: 'stopped', GENERATION_ENDED: 'ended', APP_READY: 'app_ready',
  };
  const prompt = {
    id: 'initial-preset', name: '初始细纲', raw: {},
    prompts: [{ identifier: 'planner', name: '规划', role: 'system', content: '为剧情生成细纲。', enabled: true }],
    promptOrder: [{ identifier: 'planner', enabled: true }],
  };
  const apiCalls = [];
  const notices = [];
  const buttonState = [];
  const context = {
    chat: [
      { mes: '角色开场白', is_user: false, is_system: false },
      { mes: '玩家的第一步', is_user: true, is_system: false },
    ],
    chatMetadata: {},
    extensionSettings: { [EXTENSION_ID]: {
      config: { enabled: true, apiurl: 'https://api.example/v1', key: 'secret', model: 'planner-model', timeoutSeconds: 20, retryCount: 0, maxTokens: 400, temperature: 0.2, debounceMs: 0 },
      plannerPresets: [prompt], activePlannerPresetId: prompt.id,
    } },
    eventTypes: events,
    eventSource: {
      on(name, handler) { const list = listeners.get(name) ?? []; list.push(handler); listeners.set(name, list); },
      removeListener(name, handler) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== handler)); },
      emit(name, event) { for (const handler of listeners.get(name) ?? []) handler(event); },
    },
    saveMetadataDebounced() {}, saveSettingsDebounced() {},
    deactivateSendButtons() { buttonState.push('busy'); },
    activateSendButtons() { buttonState.push('ready'); },
    substituteParams(value) {
      return ({ '{{persona}}': 'Persona', '{{user}}': '玩家', '{{char}}': '角色', '{{personality}}': '性格', '{{scenario}}': '场景', '{{mesExamples}}': '示例' })[value] ?? value;
    },
    characters: [{ description: '角色设定', personality: '温和', scenario: '雨夜', mes_example: '示例对话', data: { extensions: {} } }],
    characterId: 0,
    getWorldInfoNames() { return []; },
    getRequestHeaders() { return { 'Content-Type': 'application/json' }; },
    ChatCompletionService: {
      createRequestData(data) { return data; },
      async sendRequest(data, extractData, signal) {
        apiCalls.push({ data, extractData, signal });
        const content = apiCalls.length === 1 ? '<outline>初始细纲</outline>'
          : apiCalls.length === 2 ? '<outline>下一轮细纲</outline>' : '缺少标签的正文';
        return { choices: [{ message: { content } }] };
      },
    },
  };
  const document = { querySelector() { return null; }, addEventListener() {}, removeEventListener() {} };
  const window = { document, SillyTavern: { getContext: () => context }, setInterval, clearInterval, addEventListener() {}, removeEventListener() {},
    toastr: { error: message => notices.push(message) },
    fetch: async (_url, options) => {
      const response = await context.ChatCompletionService.sendRequest(JSON.parse(options.body), false, options.signal);
      return Response.json(response);
    },
  };
  const host = createNativeHost(context, { window, document });
  const logs = [];
  host.console = { info: (...args) => logs.push(args), warn() {}, error() {} };
  const runtime = engine.createTavernRuntime(host, context.extensionSettings[EXTENSION_ID].config);
  const gate = createGenerationGate(runtime, context, { notify() {} });
  let abortImmediate = false;
  await gate.interceptor([], 8192, immediate => { abortImmediate = immediate; }, 'normal');
  assert.equal(abortImmediate, false);
  assert.equal(apiCalls.length, 1);
  assert.match(JSON.stringify(logs), /初始规划请求/);
  assert.equal(apiCalls[0].data.reverse_proxy, 'https://api.example/v1');
  assert.equal(apiCalls[0].data.use_sysprompt, false);
  assert.equal(context.chatMetadata.extensions[EXTENSION_ID].__tw_story_planner_v1.activeOutline, '<outline>初始细纲</outline>');
  const promptEvent = { chat: [{ role: 'user', content: '玩家的第一步' }], dryRun: false };
  context.eventSource.emit(events.CHAT_COMPLETION_PROMPT_READY, promptEvent);
  assert.deepEqual(promptEvent.chat.at(-1), { role: 'system', content: '<outline>初始细纲</outline>' });
  context.eventSource.emit(events.GENERATION_STARTED, 'normal');
  context.chat.push({ mes: '酒馆 AI 的首轮回复', is_user: false, is_system: false });
  assert.ok((listeners.get(events.MESSAGE_RECEIVED) ?? []).length > 0);
  context.eventSource.emit(events.MESSAGE_RECEIVED, { index: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(apiCalls.length, 1, 'intermediary message must not start next planning before generation ends');
  context.eventSource.emit(events.GENERATION_ENDED);
  for (let attempt = 0; attempt < 40 && apiCalls.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(apiCalls.length, 2);
  assert.ok(buttonState.includes('busy'), 'next planning must occupy the native send controls');
  assert.equal(context.chatMetadata.extensions[EXTENSION_ID].__tw_story_planner_v1.activeOutline, '<outline>下一轮细纲</outline>');
  for (let attempt = 0; attempt < 40 && buttonState.at(-1) !== 'ready'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(buttonState.at(-1), 'ready', 'planning completion must release native send controls');
  context.chat.push({ mes: '玩家的第二步', is_user: true, is_system: false });
  await gate.interceptor([], 8192, immediate => { abortImmediate = immediate; }, 'normal');
  assert.equal(abortImmediate, false);
  const nextPromptEvent = { chat: [{ role: 'user', content: '玩家的第二步' }], dryRun: false };
  context.eventSource.emit(events.CHAT_COMPLETION_PROMPT_READY, nextPromptEvent);
  assert.deepEqual(nextPromptEvent.chat.at(-1), { role: 'system', content: '<outline>下一轮细纲</outline>' });
  context.chat.push({ mes: '酒馆 AI 的第二轮回复', is_user: false, is_system: false });
  context.eventSource.emit(events.MESSAGE_RECEIVED, { index: 4 });
  for (let attempt = 0; attempt < 40 && apiCalls.length < 3; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  for (let attempt = 0; attempt < 40 && context.chatMetadata.extensions[EXTENSION_ID].__tw_story_planner_v1.status !== 'failed'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(apiCalls.length, 3);
  assert.match(context.chatMetadata.extensions[EXTENSION_ID].__tw_story_planner_v1.lastError, /缺少.*<outline>/);
  assert.match(notices.at(-1), /缺少.*<outline>/);
  assert.equal(context.chatMetadata.extensions[EXTENSION_ID].__tw_story_planner_v1.activeOutline, '');
  const history = context.chatMetadata.extensions[EXTENSION_ID].__tw_story_planner_v1.outlineHistory;
  assert.deepEqual(history.map(record => record.usedMessageId), [2, 4]);
  context.chat.push({ mes: '玩家第三步', is_user: true, is_system: false });
  const gateNotices = [];
  gate.destroy();
  const rescueGate = createGenerationGate(runtime, context, { notify: value => gateNotices.push(value) });
  abortImmediate = false;
  await rescueGate.interceptor([], 8192, immediate => { abortImmediate = immediate; }, 'normal');
  assert.equal(apiCalls.length, 4, 'failed next outline must trigger a fresh blocking rescue request');
  assert.equal(abortImmediate, true);
  assert.match(gateNotices.at(-1), /本轮细纲失败/);
  const failedPrompt = { chat: [], dryRun: false };
  context.eventSource.emit(events.CHAT_COMPLETION_PROMPT_READY, failedPrompt);
  assert.equal(failedPrompt.chat.length, 0, 'consumed previous outline must not be reinjected after rescue failure');
  const preDeleteState = context.chatMetadata.extensions[EXTENSION_ID].__tw_story_planner_v1;
  const usedForFloorFour = preDeleteState.outlineHistory.find(record => record.usedMessageId === 4);
  assert.ok(usedForFloorFour);
  context.chat.splice(3); // The host truncates once from the selected floor to the end.
  context.eventSource.emit(events.MESSAGE_DELETED); // SillyTavern emits one event for the whole batch.
  const postDeleteState = context.chatMetadata.extensions[EXTENSION_ID].__tw_story_planner_v1;
  assert.equal(postDeleteState.outlineHistory.find(record => record.id === usedForFloorFour.id).status, 'ready');
  assert.equal(postDeleteState.outlineHistory.some(record => ['invalid', 'superseded'].includes(record.status)), false);
  assert.equal(postDeleteState.activeOutline, '');
  const deletionLog = logs.find(([name, data]) => name === '[剧情规划器][生命周期对账]' && data?.operation === 'MESSAGE_DELETED');
  assert.ok(deletionLog);
  assert.equal(deletionLog[1].returnedToReadyCount, 1);
  assert.equal(deletionLog[1].prunedCount, 0);
  assert.doesNotMatch(JSON.stringify(deletionLog), /<outline>|酒馆 AI|玩家第三步|secret/);
  rescueGate.destroy();
  const connectionResult = await runtime.testConnection({ apiurl: 'https://api.example/v1', model: 'planner-model', key: '' });
  assert.match(connectionResult, /连接测试成功/);
  window.fetch = async () => Response.json({ error: { message: 'private response' } }, { status: 404 });
  const failedConnection = await runtime.testConnection({ apiurl: 'https://api.example/v1', model: 'planner-model', key: '' });
  assert.match(failedConnection, /HTTP 404/);
  assert.doesNotMatch(failedConnection, /private response/);
  runtime.saveConfig({ enabled: false });
  assert.equal(context.extensionSettings[EXTENSION_ID].config.enabled, false);
  assert.match(JSON.stringify(logs), /已关闭/);
  gate.destroy();
  runtime.destroy();
  host.destroy();
});
