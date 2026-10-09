import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const planner = require('./planner.js');
const { createNativeHost } = require('./runtime-adapter.js');
const { createGenerationGate } = require('./generation-gate.js');

const eventNames = [
  'APP_READY', 'CHAT_COMPLETION_PROMPT_READY', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED',
  'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'CHAT_CHANGED', 'GENERATION_STARTED',
  'GENERATION_ENDED', 'GENERATION_STOPPED', 'TOOL_CALLS_PERFORMED',
];

function tauriFixture(messages) {
  const listeners = new Map();
  const context = {
    chat: structuredClone(messages), chatMetadata: {}, extensionSettings: {},
    eventTypes: Object.fromEntries(eventNames.map(name => [name, name.toLowerCase()])),
    eventSource: {
      on(name, listener) { const list = listeners.get(name) ?? []; list.push(listener); listeners.set(name, list); },
      removeListener(name, listener) { listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener)); },
      emit(name, ...args) { for (const listener of listeners.get(name) ?? []) listener(...args); },
    },
    ChatCompletionService: { createRequestData: value => value },
    async saveMetadata() {}, saveMetadataDebounced() {}, saveSettingsDebounced() {},
  };
  const window = {
    __TAURITAVERN__: { ready: Promise.resolve(), api: { chat: { current: { handle: () => ({}) } } } },
    SillyTavern: { getContext: () => context },
  };
  return { context, listeners, window };
}

function toolTranscript({ final = true } = {}) {
  return [
    { mes: '开场', is_user: false, is_system: false },
    { mes: '调查密室', is_user: true, is_system: false },
    { mes: '', role: 'assistant', is_user: false, is_system: false, tool_calls: [
      { id: 'call-a', type: 'function', function: { name: 'inspect', arguments: '{"room":"west"}' } },
      { id: 'call-b', type: 'function', function: { name: 'roll', arguments: '{"dice":20}' } },
    ] },
    { mes: '图像副作用', role: 'assistant', is_user: false, is_system: false, extra: { image: 'generated' } },
    { mes: 'roll failed', role: 'tool', is_user: false, is_system: true, tool_call_id: 'call-b', error: true },
    { mes: '系统副作用', role: 'system', is_user: false, is_system: true },
    { mes: 'inspection result', role: 'tool', is_user: false, is_system: true, tool_call_id: 'call-a' },
    ...(final ? [{ mes: '她发现门后有一条暗道。', role: 'assistant', is_user: false, is_system: false }] : []),
  ].map((message, message_id) => ({ message_id, ...message }));
}

function plannerRequest(generation_id = 'planner-request') {
  return {
    generation_id,
    custom_api: { apiurl: 'https://api.example/v1', key: 'private-key', model: 'planner', max_tokens: 300 },
    ordered_prompts: [{ role: 'system', content: '独立规划提示词' }],
    tools: [{ type: 'function', function: { name: 'game_content', parameters: { type: 'object', properties: { content: { type: 'string' } } } } }],
    tool_choice: { type: 'function', function: { name: 'game_content' } },
  };
}

test('Tauri snapshots preserve explicit roles, tool facts, and absolute floor indices', () => {
  const { context, window } = tauriFixture(toolTranscript());
  const host = createNativeHost(context, { window, document: null });
  const messages = planner.buildSnapshot(host.getChatMessages('0-7')).messages;
  assert.deepEqual(messages.map(item => item.messageId), [0, 1, 2, 3, 4, 6, 7]);
  assert.equal(messages[2].role, 'assistant');
  assert.deepEqual(messages[2].toolCalls.map(call => call.id), ['call-a', 'call-b']);
  assert.equal(messages[4].role, 'tool');
  assert.equal(messages[4].toolCallId, 'call-b');
  assert.equal(messages[5].toolCallId, 'call-a');
  assert.equal(messages[6].role, 'assistant');
  host.destroy();
});

test('Tauri message edit subscription uses the event constant available from its host', () => {
  const { context, window, listeners } = tauriFixture(toolTranscript());
  delete context.eventTypes.MESSAGE_UPDATED;
  const host = createNativeHost(context, { window, document: null });
  assert.equal(host.tavern_events.MESSAGE_UPDATED, 'message_edited');
  host.eventOn(host.tavern_events.MESSAGE_UPDATED, () => {});
  assert.equal(listeners.has('message_edited'), true);
  host.destroy();
});

test('Tauri planner request stays quiet and preserves independent prompts, tools, and raw response', async () => {
  const { context, window } = tauriFixture(toolTranscript());
  context.ChatCompletionService.createRequestData = data => ({ ...data,
    type: 'normal', messages: [{ role: 'system', content: '主聊天预设' }], tools: [], tool_choice: 'none' });
  const sent = [];
  let wrappedReads = 0;
  window.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    const response = Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [
      { id: 'planner-call', type: 'function', function: { name: 'game_content', arguments: '{"content":"<outline>原始细纲</outline>"}' } },
    ] } }] });
    response.json = async () => { wrappedReads += 1; return { choices: [{ message: { content: '<outline>已改写</outline>' } }] }; };
    return response;
  };
  const host = createNativeHost(context, { window, document: null });
  const request = plannerRequest();
  const result = await host.generateRaw(request);
  assert.equal(sent[0].type, 'quiet');
  assert.deepEqual(sent[0].messages, request.ordered_prompts);
  assert.deepEqual(sent[0].tools, request.tools);
  assert.deepEqual(sent[0].tool_choice, request.tool_choice);
  assert.equal(planner.parsePlannerResult(result, 'game_content').value.rawText, '<outline>原始细纲</outline>');
  assert.equal(wrappedReads, 0);
  host.destroy();
});

test('Tauri host errors distinguish its HTTP status from a proven upstream status', async () => {
  for (const { upstreamStatus, envelopeStatus } of [
    { upstreamStatus: null, envelopeStatus: 404 },
    { upstreamStatus: 401, envelopeStatus: null },
    { upstreamStatus: 403, envelopeStatus: null },
    { upstreamStatus: 404, envelopeStatus: null },
  ]) {
    const { context, window } = tauriFixture([]);
    const diagnostics = [];
    window.console = { info: (...args) => diagnostics.push(args) };
    window.fetch = async () => Response.json({ error: {
      code: 'PROVIDER_ERROR', category: 'provider', message_key: 'provider_request_failed',
      message: 'private provider details',
      ...(envelopeStatus ? { status: envelopeStatus } : {}),
      ...(upstreamStatus ? { upstream_status: upstreamStatus } : {}),
    } }, { status: upstreamStatus ? 200 : 502 });
    const host = createNativeHost(context, { window, document: null });
    await assert.rejects(host.generateRaw(plannerRequest(`error-${upstreamStatus}`)), error => {
      assert.equal(error.hostStatus, upstreamStatus ? 200 : 502);
      assert.equal(error.upstreamStatus, upstreamStatus);
      assert.equal(error.upstreamCategory, 'provider');
      assert.equal(error.status, upstreamStatus);
      assert.doesNotMatch(String(error), /private provider details/);
      const classified = planner.classifyPlannerFailure(error);
      assert.equal(classified.code, upstreamStatus ? `HTTP_${upstreamStatus}` : 'HOST_502');
      if (!upstreamStatus) assert.match(classified.message, /宿主 HTTP 502.*上游状态未提供/);
      return true;
    });
    const rawDiagnostic = diagnostics.find(([name]) => name === '[剧情规划器][诊断][响应]')?.[1]?.raw;
    assert.equal(rawDiagnostic?.upstreamCategory, 'provider');
    assert.equal(rawDiagnostic?.envelopeStatus, envelopeStatus);
    assert.doesNotMatch(JSON.stringify(diagnostics), /private provider details|private-key/);
    host.destroy();
  }
});

test('Tauri direct 401, 403, and 404 remain host statuses when upstream status is absent', async () => {
  for (const hostStatus of [401, 403, 404]) {
    const { context, window } = tauriFixture([]);
    window.fetch = async () => Response.json({ error: { category: 'request', message_key: 'host_request_failed' } }, { status: hostStatus });
    const host = createNativeHost(context, { window, document: null });
    await assert.rejects(host.generateRaw(plannerRequest(`host-${hostStatus}`)), error => {
      assert.equal(error.hostStatus, hostStatus);
      assert.equal(error.status, null);
      assert.equal(error.upstreamStatus, null);
      assert.match(planner.classifyPlannerFailure(error).message, new RegExp(`宿主 HTTP ${hostStatus}.*上游.*未提供`));
      return true;
    });
    host.destroy();
  }
});

test('Tauri error hints identify backend disconnection and permission denial without provider text', async () => {
  for (const { errorBody, status, expectedCode, expectedMessage } of [
    { errorBody: { code: 'backend_disconnected', category: 'transport', message: 'private endpoint and key' },
      status: 502, expectedCode: 'BACKEND_DISCONNECTED', expectedMessage: /后端连接已断开/ },
    { errorBody: { code: 'PERMISSION_DENIED', category: 'authentication', message: 'private account details' },
      status: 403, expectedCode: 'PERMISSION_DENIED', expectedMessage: /权限不足/ },
    { errorBody: { category: 'authentication', message: 'private authorization details' },
      status: 502, expectedCode: 'HOST_AUTH', expectedMessage: /认证或权限请求失败/ },
  ]) {
    const { context, window } = tauriFixture([]);
    window.fetch = async () => Response.json({ error: errorBody }, { status });
    const host = createNativeHost(context, { window, document: null });
    await assert.rejects(host.generateRaw(plannerRequest()), error => {
      const classified = planner.classifyPlannerFailure(error);
      assert.equal(classified.code, expectedCode);
      assert.match(classified.message, expectedMessage);
      assert.doesNotMatch(classified.message, /private|endpoint|account|key/);
      return true;
    });
    host.destroy();
  }
});

test('a completion marked length is not accepted as a finished outline', () => {
  const raw = { choices: [{ finish_reason: 'length', message: { tool_calls: [
    { id: 'partial-call', type: 'function', function: { name: 'game_content', arguments: '{"content":"<outline>看似完整的细纲</outline>"}' } },
  ] } }] };
  const parsed = planner.parsePlannerResult(raw, 'game_content');
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /未完成|输出上限/);
});

test('Tauri network and cancellation failures are classified without retryable secret text', async () => {
  const network = tauriFixture([]);
  network.window.fetch = async () => { throw new TypeError('private network endpoint'); };
  const networkHost = createNativeHost(network.context, { window: network.window, document: null });
  await assert.rejects(networkHost.generateRaw(plannerRequest('network')), error => {
    assert.equal(planner.classifyPlannerFailure(error).code, 'NETWORK');
    assert.doesNotMatch(String(error), /private network endpoint/);
    return true;
  });
  networkHost.destroy();

  const cancelled = tauriFixture([]);
  const signals = [];
  let resolveMainRequest;
  cancelled.window.fetch = (_url, options) => new Promise((resolve, reject) => {
    signals.push(options.signal);
    if (signals.length === 1) resolveMainRequest = () => resolve(Response.json({ ok: true }));
    options.signal.addEventListener('abort', () => reject(new DOMException('private cancellation', 'AbortError')), { once: true });
  });
  const cancelHost = createNativeHost(cancelled.context, { window: cancelled.window, document: null });
  const mainController = new AbortController();
  const mainRequest = cancelled.window.fetch('/main-chat-request', { signal: mainController.signal });
  const pending = cancelHost.generateRaw(plannerRequest('cancel-only-planner'));
  await new Promise(resolve => setImmediate(resolve));
  cancelHost.stopGenerationById('cancel-only-planner');
  await assert.rejects(pending, error => {
    assert.equal(planner.classifyPlannerFailure(error).code, 'CANCELLED');
    assert.doesNotMatch(String(error), /private cancellation/);
    return true;
  });
  assert.equal(signals[1].aborted, true);
  assert.equal(signals[0].aborted, false);
  resolveMainRequest();
  assert.equal((await mainRequest).ok, true);
  cancelHost.destroy();
});

test('Tauri selected swipe supplies the current body when the cold history slot is empty', () => {
  const { context, window } = tauriFixture([
    { mes: '', is_user: false, is_system: false, swipe_id: 1, swipes: ['旧回复', '当前回复'] },
  ]);
  const host = createNativeHost(context, { window, document: null });
  const current = host.getChatMessages('0-0')[0];
  assert.equal(current.message, '当前回复');
  assert.equal(planner.buildSnapshot([current]).messages[0].content, '当前回复');
  host.destroy();
});
