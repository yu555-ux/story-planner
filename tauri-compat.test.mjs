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

test('Tauri host 502 and proven upstream 503 retry with the frozen request', async () => {
  for (const upstreamKnown of [false, true]) {
    const { context, window } = tauriFixture([]);
    const sentBodies = [];
    window.fetch = async (_url, options) => {
      sentBodies.push(options.body);
      if (!upstreamKnown || sentBodies.length === 1) {
        return Response.json({ error: { category: 'provider', ...(upstreamKnown ? { upstream_status: 503 } : {}) } }, { status: 502 });
      }
      return Response.json({ choices: [{ message: { tool_calls: [
        { id: 'retry-result', type: 'function', function: { name: 'game_content', arguments: '{"content":"<outline>重试成功</outline>"}' } },
      ] } }] });
    };
    const host = createNativeHost(context, { window, document: null });
    let state = {};
    const messages = planner.buildSnapshot([
      { message_id: 0, role: 'assistant', message: '开场' },
      { message_id: 1, role: 'user', message: '开始' },
    ]).messages;
    const lifecycle = planner.createPlanningLifecycle({
      readMessages: () => messages, readState: () => state, writeState: value => { state = value; },
      getConfig: () => ({ enabled: true, retryCount: 2, timeoutSeconds: 2 }),
      getSignature: () => 'fixed-request',
      run: async job => {
        const raw = await host.generateRaw(plannerRequest(job.generationId));
        const parsed = planner.parsePlannerResult(raw, 'game_content');
        if (!parsed.ok) throw new Error(parsed.error);
        return { rawText: parsed.value.rawText };
      },
      classifyFailure: planner.classifyPlannerFailure, extractOutline: planner.extractOutline,
      hash: planner.fnv1a, stop: id => host.stopGenerationById(id), notify() {}, log: {}, retryDelayMs: 0,
    });
    if (upstreamKnown) {
      assert.equal((await lifecycle.ensureCurrent()).body, '重试成功');
      assert.equal(sentBodies.length, 2);
      assert.equal(sentBodies[0], sentBodies[1]);
    } else {
      await assert.rejects(lifecycle.ensureCurrent());
      assert.equal(sentBodies.length, 3);
      assert.match(state.lastError, /酒馆宿主 HTTP 502.*上游状态未提供/);
      assert.equal(state.lastTask.attempt, 3);
    }
    lifecycle.destroy();
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

test('planner history removes complete multi-tool cycles by call id and keeps only the final narrative reply', () => {
  assert.equal(typeof planner.buildPlannerHistoryMessages, 'function');
  const messages = planner.buildSnapshot(toolTranscript()).messages;
  const history = planner.buildPlannerHistoryMessages(messages, 20);
  assert.deepEqual(history.map(item => item.messageId), [0, 1, 7]);
  assert.ok(history.every(item => item.role !== 'tool' && !item.toolCalls?.length && !item.toolCallId));
});

test('planner history drops incomplete and orphan tool protocols without sending their partial messages', () => {
  assert.equal(typeof planner.buildPlannerHistoryMessages, 'function');
  const messages = planner.buildSnapshot([
    { message_id: 0, role: 'assistant', message: '开场' },
    { message_id: 1, role: 'user', message: '行动' },
    { message_id: 2, role: 'assistant', message: '', tool_calls: [
      { id: 'missing-result', type: 'function', function: { name: 'inspect', arguments: '{}' } },
    ] },
    { message_id: 3, role: 'assistant', message: '副作用' },
    { message_id: 4, role: 'tool', message: 'orphan result', tool_call_id: 'unknown' },
  ]).messages;
  const history = planner.buildPlannerHistoryMessages(messages, 20);
  assert.deepEqual(history.map(item => item.messageId), [0, 1]);
});

test('tool continuations reuse the same outline, bind it to the final assistant floor, and do not pre-plan after reply', async () => {
  let messages = planner.buildSnapshot(toolTranscript({ final: false }).slice(0, 2)).messages;
  let state = {};
  let calls = 0;
  const lifecycle = planner.createPlanningLifecycle({
    readMessages: () => structuredClone(messages), readState: () => state,
    writeState: value => { state = value; },
    getConfig: () => ({ enabled: true, retryCount: 0, timeoutSeconds: 2 }),
    getSignature: () => 'preset',
    run: async () => ({ rawText: `<outline>规划${++calls}</outline>` }),
    classifyFailure: planner.classifyPlannerFailure, extractOutline: planner.extractOutline,
    hash: planner.fnv1a, stop() {}, notify() {}, log: {}, retryDelayMs: 0,
  });
  const initial = await lifecycle.ensureCurrent();
  assert.equal(lifecycle.markUsing(initial.id), true);
  messages = planner.buildSnapshot(toolTranscript({ final: false })).messages;
  lifecycle.onMessage();
  assert.equal(state.outlineHistory[0].status, 'using');
  assert.equal(state.outlineHistory[0].usedMessageId, null);
  assert.equal(calls, 1);
  assert.deepEqual(lifecycle.getCurrentTurn('normal'), {
    kind: 'initial', chatIdentity: lifecycle.identity(), type: 'normal', userMessageId: 1,
  });
  assert.equal((await lifecycle.ensureCurrent()).id, initial.id);
  assert.equal(lifecycle.markUsing(initial.id), true);
  messages = planner.buildSnapshot(toolTranscript()).messages;
  lifecycle.onMessage();
  assert.equal(state.outlineHistory[0].status, 'used');
  assert.equal(state.outlineHistory[0].usedMessageId, 7);
  assert.equal(calls, 1);
  lifecycle.destroy();
});

test('regenerate, swipe, and continue keep tool-assisted reply changes outside the current outline source', async () => {
  for (const type of ['regenerate', 'swipe', 'continue']) {
    let messages = planner.buildSnapshot(toolTranscript()).messages;
    let state = {};
    let calls = 0;
    const config = { enabled: true, retryCount: 0, timeoutSeconds: 2 };
    const lifecycle = planner.createPlanningLifecycle({
      readMessages: () => structuredClone(messages), readState: () => state,
      writeState: value => { state = value; }, getConfig: () => config,
      getSignature: () => 'preset',
      run: async () => { calls += 1; return { rawText: `<outline>${type} 细纲</outline>` }; },
      classifyFailure: planner.classifyPlannerFailure, extractOutline: planner.extractOutline,
      hash: planner.fnv1a, stop() {}, notify() {}, log: {}, retryDelayMs: 0,
    });
    const outline = await lifecycle.ensureCurrent(type);
    assert.equal(lifecycle.markUsing(outline.id, type), true);

    const regeneratedTranscript = toolTranscript({ final: false });
    regeneratedTranscript.push(
      { message_id: 7, role: 'assistant', mes: '', tool_calls: [
        { id: `${type}-call`, type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ] },
      { message_id: 8, role: 'tool', is_system: true, mes: 'lookup failed', tool_call_id: `${type}-call`, error: true },
      { message_id: 9, role: 'assistant', mes: `${type} 后的最终剧情`, is_user: false, is_system: false },
    );
    messages = planner.buildSnapshot(regeneratedTranscript).messages;
    config.enabled = false;
    lifecycle.onMessage();
    assert.equal(state.outlineHistory[0].status, 'used', `${type} should finish the claim`);
    assert.equal(state.outlineHistory[0].usedMessageId, 9, `${type} should bind the actual narrative floor`);
    assert.equal(calls, 1);

    messages = messages.filter(message => message.messageId !== 8);
    lifecycle.invalidate();
    assert.equal(state.outlineHistory[0].status, 'used', `${type} should preserve the current outline when its generated tool reply changes`);
    lifecycle.destroy();
  }
});

test('generation gate injects the same outline on recursive tool-generated requests', async () => {
  const listeners = new Map();
  const context = {
    eventTypes: { CHAT_COMPLETION_PROMPT_READY: 'prompt_ready', GENERATION_STARTED: 'started', GENERATION_ENDED: 'ended', GENERATION_STOPPED: 'stopped', CHAT_CHANGED: 'chat_changed' },
    eventSource: {
      on(name, listener) { listeners.set(name, listener); },
      removeListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
      emit(name, event) { listeners.get(name)?.(event); },
    },
  };
  const outline = { id: 'outline-1', fullTag: '<outline>本轮细纲</outline>' };
  let planningRequests = 0;
  let plannedOutline = null;
  const runtime = { gate: {
    version: 2, isEnabled: () => true, getChatIdentity: () => 'chat:1',
    getCurrentTurn: type => ({ kind: 'initial', chatIdentity: 'chat:1', type, userMessageId: 1 }),
    ensureCurrentOutline: async () => {
      if (!plannedOutline) { planningRequests += 1; plannedOutline = outline; }
      return plannedOutline;
    },
    getActiveOutline: () => outline, markUsing: () => true, clearClaim() {}, describeFailure: () => 'failed',
  } };
  const gate = createGenerationGate(runtime, context);
  const injected = [];
  for (let index = 0; index < 2; index += 1) {
    let aborted = false;
    await gate.interceptor([], 4096, value => { aborted = value; }, 'normal');
    assert.equal(aborted, false);
    const event = { chat: [], dryRun: false };
    context.eventSource.emit('prompt_ready', event);
    injected.push(event.chat.at(-1));
  }
  assert.equal(planningRequests, 1);
  assert.deepEqual(injected, [
    { role: 'system', content: '<outline>本轮细纲</outline>' },
    { role: 'system', content: '<outline>本轮细纲</outline>' },
  ]);
  gate.destroy();
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
