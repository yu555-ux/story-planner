import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNativeHost, inspectHostCapabilities, normalizeApiBase } = require('./runtime-adapter.js');
const planner = require('./planner.js');

function contextFixture() {
  const listeners = new Map();
  const events = {
    APP_READY: 'app_ready',
    CHAT_COMPLETION_PROMPT_READY: 'prompt_ready',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_SWIPED: 'message_swiped',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_DELETED: 'message_deleted',
    CHAT_CHANGED: 'chat_changed',
    GENERATION_STARTED: 'generation_started',
    GENERATION_ENDED: 'generation_ended',
    GENERATION_STOPPED: 'generation_stopped',
  };
  const context = {
    chat: [
      { mes: '角色开场白', is_user: false, is_system: false },
      { mes: '玩家行动', is_user: true, is_system: false },
    ],
    chatMetadata: {},
    extensionSettings: {},
    eventTypes: events,
    eventSource: {
      on(name, handler) { listeners.set(name, handler); },
      removeListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
    },
    async saveMetadata() {},
    saveMetadataDebounced() {},
    saveSettingsDebounced() {},
    substituteParams(value) { return value === '{{persona}}' ? 'Persona' : value; },
    characters: [{ name: '角色', description: '角色说明', personality: '性格', scenario: '场景', mes_example: '示例', data: { extensions: {} } }],
    characterId: 0,
    getWorldInfoNames() { return []; },
    getRequestHeaders() { return { 'Content-Type': 'application/json' }; },
    ChatCompletionService: {
      createRequestData(data) { return data; },
      async sendRequest(data, extractData, signal) { return { data, extractData, signal }; },
    },
    document: { body: { append() {} }, createElement() { return {}; } },
  };
  return { context, listeners };
}

test('host capability inspection keeps the SillyTavern path and checks the Tauri public chat API', () => {
  assert.equal(typeof inspectHostCapabilities, 'function');
  const { context } = contextFixture();
  assert.deepEqual(inspectHostCapabilities(context), {
    platform: 'sillytavern', ok: true, missing: [],
  });
  const tauriWindow = {
    __TAURITAVERN__: {
      ready: Promise.resolve(),
      api: { chat: { current: { handle() { return {}; } } } },
    },
  };
  assert.deepEqual(inspectHostCapabilities(context, { window: tauriWindow }), {
    platform: 'tauritavern', ok: true, missing: [],
  });
  const unsupported = inspectHostCapabilities(context, { window: { __TAURITAVERN__: { ready: Promise.resolve() } } });
  assert.equal(unsupported.ok, false);
  assert.deepEqual(unsupported.missing, ['api.chat.current.handle']);
  const noMetadataSave = { ...context, saveMetadata: undefined };
  assert.deepEqual(inspectHostCapabilities(noMetadataSave, { window: tauriWindow }).missing, ['context.saveMetadata']);
});

test('planner busy uses native controls and blocks send click and send-on-enter without losing text', () => {
  const { context } = contextFixture();
  const listeners = new Map();
  const document = {
    addEventListener(name, handler, capture) { assert.equal(capture, true); listeners.set(name, handler); },
    removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
  };
  let shown = 0;
  let hidden = 0;
  context.deactivateSendButtons = () => { shown += 1; };
  context.activateSendButtons = () => { hidden += 1; };
  context.shouldSendOnEnter = () => true;
  const host = createNativeHost(context, { document, window: {} });
  assert.equal(host.setPlannerSendBusy(true), true);
  assert.equal(shown, 1);
  const blocked = { prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} };
  listeners.get('click')({ ...blocked, type: 'click', target: { closest: selector => selector === '#send_but' ? {} : null },
    preventDefault: () => { blocked.prevented = true; } });
  assert.equal(blocked.prevented, true);
  let keyBlocked = false;
  listeners.get('keydown')({ type: 'keydown', key: 'Enter', shiftKey: false, isComposing: false,
    target: { closest: selector => selector === '#send_textarea' ? {} : null },
    preventDefault() { keyBlocked = true; }, stopImmediatePropagation() {} });
  assert.equal(keyBlocked, true);
  let ctrlEnterBlocked = false;
  listeners.get('keydown')({ type: 'keydown', key: 'Enter', ctrlKey: true, shiftKey: false,
    target: { closest: selector => selector === '#send_textarea' ? {} : null },
    preventDefault() { ctrlEnterBlocked = true; }, stopImmediatePropagation() {} });
  assert.equal(ctrlEnterBlocked, true, 'Ctrl+Enter can also send or regenerate in SillyTavern');
  let shiftCtrlBlocked = false;
  listeners.get('keydown')({ type: 'keydown', key: 'Enter', ctrlKey: true, shiftKey: true,
    target: { closest: selector => selector === '#send_textarea' ? {} : null },
    preventDefault() { shiftCtrlBlocked = true; }, stopImmediatePropagation() {} });
  assert.equal(shiftCtrlBlocked, true);
  assert.equal(host.setPlannerSendBusy(false), true);
  assert.equal(hidden, 1);
  host.destroy();
  assert.equal(listeners.size, 0);
});

test('failed native busy acquisition leaves no planner input lock behind', () => {
  const { context } = contextFixture();
  const listeners = new Map();
  const document = {
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
  };
  context.deactivateSendButtons = () => { throw new Error('host UI unavailable'); };
  context.activateSendButtons = () => {};
  const host = createNativeHost(context, { document, window: {} });
  assert.equal(host.setPlannerSendBusy(true), false);
  assert.equal(host.isPlannerSendBusy(), false);
  assert.equal(listeners.size, 0);
  host.destroy();
});

test('handoff to Tavern generation removes planner guard without restoring the send button', () => {
  const { context } = contextFixture();
  let restored = 0;
  context.deactivateSendButtons = () => {};
  context.activateSendButtons = () => { restored += 1; };
  const listeners = new Map();
  const document = {
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const host = createNativeHost(context, { document, window: {} });
  host.setPlannerSendBusy(true);
  host.setPlannerSendBusy(false, { hostGenerating: true });
  assert.equal(restored, 0);
  assert.equal(host.isPlannerSendBusy(), false);
  assert.equal(listeners.size, 0);
  host.destroy();
});

function menuElement(tag) {
  const handlers = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], attributes: {}, className: '', textContent: '', parent: null,
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { handlers.set(name, listener); },
    dispatch(name, event = {}) { handlers.get(name)?.({ type: name, preventDefault() {}, ...event }); },
  };
}

test('planner preserves game_content without invoking a preset-wrapped response reader', async () => {
  const { context } = contextFixture();
  let wrappedReads = 0;
  const response = Response.json({ choices: [{ finish_reason: 'tool_calls', message: {
    content: '', tool_calls: [{ id: 'call-1', type: 'function', function: {
      name: 'game_content', arguments: JSON.stringify({ content: '<outline>原始工具细纲</outline>' }),
    } }],
  } }] });
  response.json = async () => {
    wrappedReads += 1;
    return { choices: [{ finish_reason: 'stop', message: { content: '<outline>已被转换</outline>' } }] };
  };
  const host = createNativeHost(context, { window: { fetch: async () => response }, document: null });
  const raw = await host.generateRaw({ generation_id: 'preset-isolation', custom_api: {
    apiurl: 'https://api.example/v1', model: 'planner', max_tokens: 100,
  }, ordered_prompts: [{ role: 'user', content: '规划' }] });
  const parsed = planner.parsePlannerResult(raw, 'game_content');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.rawText, '<outline>原始工具细纲</outline>');
  assert.equal(wrappedReads, 0);
  assert.equal(response.bodyUsed, false);
  host.destroy();
});

test('native host maps SillyTavern chat messages to planner snapshots without helper globals', () => {
  const { context } = contextFixture();
  const host = createNativeHost(context);
  assert.equal(host.getLastMessageId(), 1);
  assert.deepEqual(host.getChatMessages('0-1', { hide_state: 'unhidden', include_swipes: false })
    .map(({ message_id, role, message, is_hidden }) => ({ message_id, role, message, is_hidden })), [
    { message_id: 0, role: 'assistant', message: '角色开场白', is_hidden: false },
    { message_id: 1, role: 'user', message: '玩家行动', is_hidden: false },
  ]);
});

test('native planner accepts an endpoint suffix but rejects query credentials it would otherwise discard', () => {
  assert.equal(normalizeApiBase('https://api.example/v1/chat/completions/'), 'https://api.example/v1');
  assert.throws(() => normalizeApiBase('https://api.example/v1?token=secret'), /query parameters/);
});

test('native host stores global planner settings and per-chat outline in SillyTavern storage', () => {
  const { context } = contextFixture();
  let settingsSaved = 0;
  let metadataSaved = 0;
  context.saveSettingsDebounced = () => { settingsSaved += 1; };
  context.saveMetadataDebounced = () => { metadataSaved += 1; };
  const host = createNativeHost(context);
  host.updateVariablesWith(value => ({ ...value, config: { apiurl: 'https://api.example/v1' } }), { type: 'script' });
  host.updateVariablesWith(value => ({ ...value, __tw_story_planner_v1: { activeOutline: '<outline>下一幕</outline>' } }), { type: 'chat' });
  assert.equal(host.getVariables({ type: 'script' }).config.apiurl, 'https://api.example/v1');
  assert.equal(host.getVariables({ type: 'chat' }).__tw_story_planner_v1.activeOutline, '<outline>下一幕</outline>');
  assert.equal(settingsSaved, 1);
  assert.equal(metadataSaved, 1);
});

test('settings confirmation follows the save callback result and does not claim a void debounce is durable', async () => {
  const { context } = contextFixture();
  let complete;
  let calls = 0;
  context.saveSettingsDebounced = () => { calls += 1; return new Promise(resolve => { complete = resolve; }); };
  const host = createNativeHost(context);
  host.updateVariablesWith(value => ({ ...value, config: { model: 'planner' } }), { type: 'script' });
  const pending = host.persistVariables({ type: 'script' });
  complete();
  assert.deepEqual(await pending, { type: 'script', confirmed: true });
  assert.equal(calls, 1);
  context.saveSettingsDebounced = () => { calls += 1; };
  host.updateVariablesWith(value => ({ ...value, config: { model: 'planner-2' } }), { type: 'script' });
  assert.deepEqual(await host.persistVariables({ type: 'script' }), { type: 'script', confirmed: false });
  assert.equal(calls, 2);
  host.destroy();
});

test('native host copies legacy chat outline into the new extension namespace shape', () => {
  const { context } = contextFixture();
  context.chatMetadata = { variables: { __tw_story_planner_v1: { activeOutline: '<outline>旧细纲</outline>' } } };
  const host = createNativeHost(context);
  assert.equal(host.getVariables({ type: 'chat' }).__tw_story_planner_v1.activeOutline, '<outline>旧细纲</outline>');
  assert.equal(context.chatMetadata.extensions['tw-story-planner-v1'].__tw_story_planner_v1.activeOutline, '<outline>旧细纲</outline>');
});

test('native host resolves the current chat metadata again after a chat switch', () => {
  const first = contextFixture().context;
  const second = contextFixture().context;
  second.chat = [{ mes: '另一个开场白', is_user: false, is_system: false }];
  const window = { SillyTavern: { getContext: () => second } };
  const host = createNativeHost(first, { window, document: null });
  host.updateVariablesWith(value => ({ ...value, __tw_story_planner_v1: { activeOutline: '<outline>另一个聊天</outline>' } }), { type: 'chat' });
  assert.equal(host.getLastMessageId(), 0);
  assert.equal(second.chatMetadata.extensions['tw-story-planner-v1'].__tw_story_planner_v1.activeOutline, '<outline>另一个聊天</outline>');
  assert.equal(first.chatMetadata.extensions, undefined);
});

test('chat display uses the Tavern file name and saves a planner-only record name per chat', async () => {
  const first = contextFixture().context;
  first.chatId = '做卡 - 2026-10-06@16h55m53s';
  first.characters[0].name = '做卡';
  let saves = 0;
  first.saveMetadata = async () => { saves++; };
  first.renameChat = () => { throw new Error('The Tavern file must not be renamed'); };
  const second = contextFixture().context;
  second.chatId = '做卡 - 第二份存档';
  second.characters[0].name = '做卡';
  let active = first;
  const host = createNativeHost(first, { window: { SillyTavern: { getContext: () => active } }, document: null });

  assert.equal(host.getCurrentChatDisplay().label, first.chatId);
  assert.equal(host.getCurrentChatDisplay().recordName, '2026-10-06@16h55m53s');
  const identity = host.getCurrentChatDisplay().identity;
  await host.setCurrentChatRecordName('第一幕', identity);
  assert.equal(host.getCurrentChatDisplay().label, '做卡 - 第一幕');
  assert.equal(first.chatId, '做卡 - 2026-10-06@16h55m53s');
  assert.equal(first.chatMetadata.extensions['tw-story-planner-v1'].chatRecordName, '第一幕');
  assert.equal(saves, 1);

  active = second;
  assert.equal(host.getCurrentChatDisplay().label, second.chatId);
  await assert.rejects(host.setCurrentChatRecordName('错写', identity), /聊天已切换/);
  assert.equal(second.chatMetadata.extensions, undefined);
  active = first;
  await host.setCurrentChatRecordName('', identity);
  assert.equal(host.getCurrentChatDisplay().label, first.chatId);
  assert.equal(first.chatMetadata.extensions['tw-story-planner-v1'].chatRecordName, undefined);
  host.destroy();
});

test('a nonstandard Tavern chat name stays literal until its planner record name is customized', async () => {
  const { context } = contextFixture();
  context.chatId = '旧存档';
  const host = createNativeHost(context, { window: { SillyTavern: { getContext: () => context } }, document: null });
  assert.equal(host.getCurrentChatDisplay().label, '旧存档');
  await host.setCurrentChatRecordName('第一幕', host.getCurrentChatDisplay().identity);
  assert.equal(host.getCurrentChatDisplay().label, '角色 - 第一幕');
  assert.equal(context.chatId, '旧存档');
  host.destroy();
});

test('planner-only chat name keeps outline metadata and rolls back after a failed save', async () => {
  const { context } = contextFixture();
  context.chatId = '角色 - 原存档';
  context.chatMetadata = { extensions: { 'tw-story-planner-v1': { __tw_story_planner_v1: { outline: '原细纲' } } } };
  context.saveMetadata = async () => { throw new Error('保存失败'); };
  const host = createNativeHost(context, { window: { SillyTavern: { getContext: () => context } }, document: null });
  await assert.rejects(host.setCurrentChatRecordName('新名称', host.getCurrentChatDisplay().identity), /保存失败/);
  assert.equal(host.getCurrentChatDisplay().label, '角色 - 原存档');
  assert.deepEqual(context.chatMetadata.extensions['tw-story-planner-v1'].__tw_story_planner_v1, { outline: '原细纲' });
  host.destroy();
});

test('group chat rename and copy keep metadata scoped to the selected chat', () => {
  const first = contextFixture().context;
  first.groupId = 'group-1';
  first.chatId = 'old-name';
  let active = first;
  const host = createNativeHost(first, { window: { SillyTavern: { getContext: () => active } }, document: null });
  host.updateVariablesWith(value => ({ ...value, __tw_story_planner_v1: { outline: 'group original' } }), { type: 'chat' });
  first.chatId = 'renamed';
  assert.equal(host.getVariables({ type: 'chat' }).__tw_story_planner_v1.outline, 'group original');

  const copied = contextFixture().context;
  copied.groupId = 'group-2';
  copied.chatId = 'copy';
  copied.chatMetadata = structuredClone(first.chatMetadata);
  active = copied;
  assert.equal(host.getVariables({ type: 'chat' }).__tw_story_planner_v1.outline, 'group original');
  host.updateVariablesWith(value => ({ ...value, __tw_story_planner_v1: { outline: 'group copy' } }), { type: 'chat' });
  assert.equal(host.getVariables({ type: 'chat' }).__tw_story_planner_v1.outline, 'group copy');
  assert.equal(first.chatMetadata.extensions['tw-story-planner-v1'].__tw_story_planner_v1.outline, 'group original');
  host.destroy();
});

test('native host persists each captured chat metadata in call order without writing through to the next chat', async () => {
  const first = contextFixture().context;
  const second = contextFixture().context;
  first.chatMetadata = { otherExtension: { keep: true } };
  second.chatMetadata = { otherExtension: { otherChat: true } };
  let active = first;
  const pending = [];
  first.saveMetadata = () => new Promise((resolve, reject) => pending.push({ resolve, reject, chat: 'first' }));
  second.saveMetadata = () => new Promise((resolve, reject) => pending.push({ resolve, reject, chat: 'second' }));
  let firstDebounced = 0;
  first.saveMetadataDebounced = () => { firstDebounced += 1; };
  const host = createNativeHost(first, { window: { SillyTavern: { getContext: () => active } }, document: null });

  host.updateVariablesWith(value => ({ ...value, __tw_story_planner_v1: { version: 1 } }), { type: 'chat' });
  const firstSave = host.persistVariables({ type: 'chat' });
  host.updateVariablesWith(value => ({ ...value, __tw_story_planner_v1: { version: 2 } }), { type: 'chat' });
  const secondSave = host.persistVariables({ type: 'chat' });
  assert.deepEqual(pending.map(item => item.chat), ['first', 'first']);

  active = second;
  pending[0].resolve();
  pending[1].resolve();
  await Promise.all([firstSave, secondSave]);
  assert.deepEqual(first.chatMetadata.extensions['tw-story-planner-v1'].__tw_story_planner_v1, { version: 2 });
  assert.deepEqual(first.chatMetadata.otherExtension, { keep: true });
  assert.equal(second.chatMetadata.extensions, undefined);
  assert.equal(firstDebounced, 2);
});

test('native host surfaces explicit metadata-save rejection and does not silently fall back', async () => {
  const { context } = contextFixture();
  const expected = new Error('disk write failed');
  let debounced = 0;
  context.saveMetadata = async () => { throw expected; };
  context.saveMetadataDebounced = () => { debounced += 1; };
  const host = createNativeHost(context);
  host.updateVariablesWith(value => ({ ...value, __tw_story_planner_v1: { outline: 'ready' } }), { type: 'chat' });
  await assert.rejects(host.persistVariables({ type: 'chat' }), error => error === expected);
  assert.equal(debounced, 1); // only the ordinary coalesced write was scheduled
  host.destroy();
});

test('native host sends an independent non-streaming request with planner tools and raw response enabled', async () => {
  const { context } = contextFixture();
  const calls = [];
  const diagnostics = [];
  let finishRequest;
  const window = { SillyTavern: { getContext: () => context }, console: { info: (...args) => diagnostics.push(args) }, fetch: (url, options) => new Promise(resolve => {
    calls.push({ url, options });
    finishRequest = () => resolve(Response.json({ choices: [{ message: { content: '<outline>成功</outline>' } }] }));
  }) };
  const host = createNativeHost(context, { window, document: null });
  const pending = host.generateRaw({
    generation_id: 'planner-job',
    custom_api: { apiurl: 'https://api.example/v1', key: 'secret', model: 'test-model', max_tokens: 400, temperature: 0.2 },
    ordered_prompts: [{ role: 'system', content: '规划' }],
    tools: [{ type: 'function', function: { name: 'game_content', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'game_content' } },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  host.stopGenerationById('planner-job');
  finishRequest();
  const result = await pending;
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, '/api/backends/chat-completions/generate');
  assert.equal(payload.chat_completion_source, 'openai');
  assert.equal(payload.reverse_proxy, 'https://api.example/v1');
  assert.equal(payload.proxy_password, 'secret');
  assert.equal(payload.messages[0].content, '规划');
  assert.equal(payload.tools[0].function.name, 'game_content');
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(result.choices[0].message.content, '<outline>成功</outline>');
  assert.equal(diagnostics[0][0], '[剧情规划器][诊断][请求]');
  assert.equal(diagnostics[0][1].hasTools, true);
  assert.equal(diagnostics[0][1].toolChoice, 'game_content');
  const responseDiagnostic = diagnostics.find(([name]) => name === '[剧情规划器][诊断][响应]')[1];
  assert.equal(responseDiagnostic.raw.toolCallCount, 0);
  assert.equal(responseDiagnostic.raw.hasContent, true);
  assert.equal(responseDiagnostic.wrappedJsonInvoked, false);
  assert.equal(diagnostics.find(([name]) => name === '[剧情规划器][诊断][发送前]')[1].requestToBodyMessagesMatch, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|<outline>成功<\/outline>|"content":/);
});

test('native host preserves HTTP status without exposing provider error text', async () => {
  const { context } = contextFixture();
  const diagnostics = [];
  const window = { SillyTavern: { getContext: () => context }, console: { info: (...args) => diagnostics.push(args) },
    fetch: async () => Response.json({ error: { message: 'secret provider response' } }, { status: 404 }) };
  const host = createNativeHost(context, { window, document: null });
  await assert.rejects(host.generateRaw({ generation_id: 'http-404', custom_api: {
    apiurl: 'https://api.example/v1', model: 'missing-model', key: 'secret', max_tokens: 100,
  }, ordered_prompts: [{ role: 'user', content: 'hi' }] }), error => {
    assert.equal(error.status, 404);
    assert.equal(String(error).includes('secret provider response'), false);
    return true;
  });
  const responseDiagnostic = diagnostics.find(([name]) => name === '[剧情规划器][诊断][响应]')[1];
  assert.equal(responseDiagnostic.httpStatus, 404);
  assert.equal(responseDiagnostic.raw.hasError, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret|private provider response/);
});

test('native host reads an upstream status inside an HTTP 200 error envelope', async () => {
  const { context } = contextFixture();
  const window = { SillyTavern: { getContext: () => context },
    fetch: async () => Response.json({ error: { status: 429, message: 'private quota details' } }) };
  const host = createNativeHost(context, { window, document: null });
  await assert.rejects(host.generateRaw({ generation_id: 'upstream-429', custom_api: {
    apiurl: 'https://api.example/v1', model: 'planner', key: 'secret', max_tokens: 100,
  }, ordered_prompts: [{ role: 'user', content: 'hi' }] }), error => {
    assert.equal(error.status, 429);
    assert.equal(String(error).includes('private quota details'), false);
    return true;
  });
});

test('invalid raw JSON is rejected even when the wrapped reader offers a valid outline', async t => {
  for (const status of [200, 502]) {
    await t.test(`HTTP ${status}`, async () => {
      const { context } = contextFixture();
      const response = new Response('invalid private JSON', { status });
      let wrappedReads = 0;
      response.json = async () => {
        wrappedReads += 1;
        return { choices: [{ message: { content: '<outline>转换结果</outline>' } }] };
      };
      const host = createNativeHost(context, { window: { fetch: async () => response }, document: null });
      await assert.rejects(host.generateRaw({ generation_id: `invalid-${status}`, custom_api: {
        apiurl: 'https://api.example/v1', model: 'planner', max_tokens: 100,
      }, ordered_prompts: [{ role: 'user', content: '规划' }] }), error => {
        if (status === 200) assert.equal(error.code, 'INVALID_RESPONSE');
        else assert.equal(error.status, 502);
        assert.doesNotMatch(String(error), /private JSON/);
        return true;
      });
      assert.equal(wrappedReads, 0);
      host.destroy();
    });
  }
});

test('native host removes its SillyTavern event listeners on disposal', () => {
  const { context, listeners } = contextFixture();
  const host = createNativeHost(context);
  const calls = [];
  const subscription = host.eventOn('message_received', () => calls.push('received'));
  listeners.get('message_received')();
  assert.deepEqual(calls, ['received']);
  subscription.stop();
  assert.equal(listeners.has('message_received'), false);
});

test('planner parses the raw Chat Completion response returned by SillyTavern', () => {
  const textResult = planner.parsePlannerResult({ choices: [{ message: { content: '<outline>下一幕</outline>' } }] });
  assert.equal(textResult.ok, true);
  assert.equal(textResult.value.rawText, '<outline>下一幕</outline>');
  const toolResult = planner.parsePlannerResult({ choices: [{ message: { tool_calls: [{
    function: { name: 'game_content', arguments: '{"content":"<outline>工具细纲</outline>"}' },
  }] } }] }, 'game_content');
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.value.rawText, '<outline>工具细纲</outline>');
});

test('result view exposes only the current saved outline body', () => {
  const view = planner.buildPanelViewModel({ enabled: true }, {
    schemaVersion: 2,
    status: 'ready',
    rawText: '模型前言<outline>旧细纲</outline>模型尾注',
    activeOutline: '<outline>\n第一幕：雨夜相遇\n</outline>',
    outlineHistory: [{ id: 'current', status: 'ready', fullTag: '<outline>\n第一幕：雨夜相遇\n</outline>', body: '第一幕：雨夜相遇' }],
    lastError: '此前的请求失败',
  });
  assert.equal(view.outlineBody, '第一幕：雨夜相遇');
  assert.equal(view.rawText, undefined);
  assert.equal(view.legacyText, undefined);

  const noActiveOutline = planner.buildPanelViewModel({ enabled: true }, {
    schemaVersion: 2,
    rawText: '<outline>尚未保存的结果</outline>',
  });
  assert.equal(noActiveOutline.outlineBody, '');
});

test('native host mounts a matching wand menu item that opens and cleans up', () => {
  const { context } = contextFixture();
  const menu = menuElement('div');
  const document = { body: menuElement('body'), createElement: menuElement, querySelector: selector => selector === '#extensionsMenu' ? menu : null };
  document.body.append(menu);
  const window = { document, SillyTavern: { getContext: () => context } };
  const host = createNativeHost(context, { window, document });
  const menuItem = menu.children[0]?.children[0];
  assert.ok(menuItem);
  assert.ok(menuItem.className.split(' ').includes('list-group-item'));
  assert.ok(menuItem.children[0].className.includes('extensionsMenuExtensionButton'));
  assert.equal(menuItem.children[1].textContent, '剧情规划器');
  let opened = 0;
  host.eventOn(host.getButtonEvent(), () => { opened += 1; });
  menuItem.dispatch('click');
  menuItem.dispatch('keydown', { key: 'Enter' });
  assert.equal(opened, 2);
  host.destroy();
  assert.equal(menu.children.length, 0);
});

test('native host mounts the wand entry when the menu appears after startup', () => {
  const { context } = contextFixture();
  let menu = null;
  let onMutation;
  let disconnected = false;
  const document = { body: menuElement('body'), createElement: menuElement, querySelector: selector => selector === '#extensionsMenu' ? menu : null };
  const window = {
    document,
    SillyTavern: { getContext: () => context },
    MutationObserver: class {
      constructor(callback) { onMutation = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  };
  const host = createNativeHost(context, { window, document });
  assert.equal(typeof onMutation, 'function');
  menu = menuElement('div');
  document.body.append(menu);
  onMutation();
  assert.equal(menu.children[0]?.children[0]?.children[1]?.textContent, '剧情规划器');
  assert.equal(disconnected, true);
  host.destroy();
});

test('native snapshots preserve message identity across deletion shifts and fingerprint prompt attachments', () => {
  const { context } = contextFixture();
  context.chat = [
    { mes: '开场', is_user: false, is_system: false },
    { mes: '同一正文', is_user: true, is_system: false, extra: { image: 'uploads/first.png', timestamp: 100 } },
    { mes: '同一正文', is_user: true, is_system: false, extra: { image: 'uploads/first.png', timestamp: 200 } },
  ];
  const host = createNativeHost(context);
  const before = host.getChatMessages('0-2');
  assert.deepEqual(before.map(message => message.message_id), [0, 1, 2]);
  assert.ok(before[1].message_fingerprint);
  assert.ok(before[1].input_fingerprint);
  assert.equal(before[1].message_fingerprint, before[2].message_fingerprint);
  assert.equal(before[1].input_fingerprint, before[2].input_fingerprint);

  context.chat.splice(1, 1);
  const afterMiddleDelete = host.getChatMessages('0-1');
  assert.deepEqual(afterMiddleDelete.map(message => message.message_id), [0, 1]);
  assert.equal(afterMiddleDelete[1].message_fingerprint, before[2].message_fingerprint);

  context.chat.splice(1, 1);
  const afterTailDelete = host.getChatMessages('0-0');
  assert.deepEqual(afterTailDelete.map(message => message.message_fingerprint), [before[0].message_fingerprint]);
  host.destroy();
});

test('native message input fingerprint changes when a prompt attachment changes', () => {
  const { context } = contextFixture();
  context.chat = [{ mes: '看这张图', is_user: true, is_system: false, extra: { image: 'uploads/first.png' } }];
  const host = createNativeHost(context);
  const before = host.getChatMessages('0-0')[0];
  context.chat[0].extra.image = 'uploads/second.png';
  const after = host.getChatMessages('0-0')[0];
  assert.notEqual(after.input_fingerprint, before.input_fingerprint);
  assert.notEqual(planner.buildSnapshot([after]).messages[0].inputFingerprint,
    planner.buildSnapshot([before]).messages[0].inputFingerprint);
  host.destroy();
});

test('native host accepts the host-provided message edited event and exposes its constant', () => {
  const { context, listeners } = contextFixture();
  context.eventTypes.MESSAGE_EDITED = 'message_edited';
  delete context.eventTypes.MESSAGE_UPDATED;
  assert.deepEqual(inspectHostCapabilities(context), { platform: 'sillytavern', ok: true, missing: [] });
  const host = createNativeHost(context);
  assert.equal(host.tavern_events.MESSAGE_EDITED, 'message_edited');
  host.eventOn(host.tavern_events.MESSAGE_EDITED, () => {});
  assert.equal(listeners.has('message_edited'), true);
  host.destroy();
});

test('panel view model exposes only ready, using, and used outlines and hides pending candidates', () => {
  const view = planner.buildPanelViewModel({ enabled: true }, {
    activeOutline: '<outline>当前细纲</outline>',
    outlineHistory: [
      { id: 'invalid', status: 'invalid', body: '不应展示的失效正文' },
      { id: 'superseded', status: 'superseded', body: '不应展示的替代正文' },
      { id: 'candidate', status: 'ready', inputPending: true, body: '等待玩家输入的候选' },
      { id: 'ready', status: 'ready', fullTag: '<outline>当前细纲</outline>', body: '当前细纲' },
      { id: 'used', status: 'used', body: '已使用细纲' },
    ],
  });
  assert.deepEqual(view.outlineHistory.map(record => record.id), ['ready', 'used']);
  assert.equal(view.outlineBody, '当前细纲');
  assert.doesNotMatch(JSON.stringify(view), /invalid|superseded|候选|不应展示/);
});
