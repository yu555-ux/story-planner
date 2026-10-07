import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const engine = require('./planner.js');

function fixture(run, overrides = {}, lifecycleOverrides = {}) {
  let state = {};
  const messages = [{ messageId: 0, role: 'assistant', content: '开场' }, { messageId: 1, role: 'user', content: '输入' }];
  const config = { enabled: true, retryCount: 1, timeoutSeconds: 1, ...overrides };
  const notices = [];
  const life = engine.createPlanningLifecycle({
    readMessages: () => structuredClone(messages), readState: () => state,
    writeState: value => { state = value; }, getConfig: () => config,
    getSignature: () => 'preset-and-config', run,
    classifyFailure: engine.classifyPlannerFailure, extractOutline: engine.extractOutline,
    hash: engine.fnv1a, stop() {}, notify: value => notices.push(value), log: {}, retryDelayMs: 0,
    ...lifecycleOverrides,
  });
  return { life, messages, config, notices, state: () => state };
}
const result = label => ({ rawText: `<outline>${label}</outline>` });

test('one current task retries malformed outline and creates only one history record', async () => {
  let calls = 0;
  const f = fixture(async () => (++calls === 1 ? { rawText: '缺标签' } : result('本轮')));
  const record = await f.life.ensureCurrent();
  assert.equal(calls, 2);
  assert.equal(record.body, '本轮');
  assert.equal(f.state().outlineHistory.length, 1);
  assert.equal(f.state().lastTask.attempt, 2);
  f.life.destroy();
});

test('running progress stays on the coalesced path while the successful outline gets one critical save', async () => {
  let release;
  let saves = 0;
  let signalRun;
  const runStarted = new Promise(resolve => { signalRun = resolve; });
  const f = fixture(async () => new Promise(resolve => { release = resolve; signalRun(); }),
    { retryCount: 0 }, { persistState: async () => { saves += 1; } });
  const pending = f.life.ensureCurrent();
  await runStarted;
  assert.equal(saves, 0);
  release(result('成功'));
  await pending;
  assert.equal(saves, 1);
  f.life.destroy();
});

test('manual replan removes the prior ready revision and deduplicates active requests', async () => {
  let calls = 0;
  const f = fixture(async () => result(`版本${++calls}`), { retryCount: 0 });
  const first = await f.life.ensureCurrent();
  assert.equal(f.life.manual(), true);
  f.life.manual();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(f.state().outlineHistory.length, 1);
  assert.equal(f.state().outlineHistory.some(item => item.id === first.id), false);
  assert.equal(f.state().outlineHistory[0].status, 'ready');
  assert.equal(f.state().outlineHistory[0].body, '版本2');
  assert.equal((await f.life.ensureCurrent()).body, '版本2');
  f.life.destroy();
});

test('swipe generation uses the preceding source rather than the next-round ready outline', async () => {
  let calls = 0;
  const f = fixture(async () => result(`细纲${++calls}`));
  const initial = await f.life.ensureCurrent();
  f.life.markUsing(initial.id);
  f.messages.push({ messageId: 2, role: 'assistant', content: '首轮' });
  f.life.onMessage();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.life.ensureCurrent('swipe')).id, initial.id);
  assert.equal(calls, 2);
  f.life.destroy();
});

test('history reopens with stable chat identity and drops an unverifiable legacy outline', async () => {
  let state = { activeOutline: '<outline>旧细纲</outline>' };
  let calls = 0;
  const options = {
    readMessages: () => [{ messageId: 0, role: 'assistant', content: '开场' }, { messageId: 1, role: 'user', content: '输入' }],
    readState: () => state, writeState: value => { state = value; },
    getConfig: () => ({ enabled: true, retryCount: 0, timeoutSeconds: 1 }), getSignature: () => 'preset',
    run: async () => { calls += 1; return result('新细纲'); }, classifyFailure: engine.classifyPlannerFailure,
    extractOutline: engine.extractOutline, hash: engine.fnv1a, stop() {}, notify() {}, log: {},
  };
  let life = engine.createPlanningLifecycle(options);
  const record = await life.ensureCurrent();
  const identity = life.identity();
  assert.equal(calls, 1);
  assert.equal(state.outlineHistory.some(item => item.body === '旧细纲'), false);
  assert.equal(state.activeOutline, '<outline>新细纲</outline>');
  life.destroy();
  life = engine.createPlanningLifecycle(options);
  assert.equal(life.identity(), identity);
  assert.equal((await life.ensureCurrent()).id, record.id);
  assert.equal(calls, 1);
  life.destroy();
});

test('player arrival waits for the same background task and binds the actual assistant floor', async () => {
  let release;
  let calls = 0;
  const f = fixture(async () => {
    calls += 1;
    return calls === 1 ? result('初始') : new Promise(resolve => { release = resolve; });
  });
  const initial = await f.life.ensureCurrent();
  f.life.markUsing(initial.id);
  f.messages.push({ messageId: 2, role: 'assistant', content: '第一轮' });
  f.life.onMessage();
  await Promise.resolve();
  f.messages.push({ messageId: 3, role: 'user', content: '第二次输入' });
  let finished = false;
  const waiting = f.life.ensureCurrent().then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(calls, 2);
  release(result('下一轮'));
  const next = await waiting;
  f.life.markUsing(next.id);
  f.messages.push({ messageId: 4, role: 'system', content: '系统' }, { messageId: 5, role: 'assistant', content: '第二轮' });
  // Disable further prefetch to inspect the completed cycle.
  f.config.enabled = false;
  f.life.onMessage();
  assert.deepEqual(f.state().outlineHistory.map(item => item.usedMessageId), [2, 5]);
  assert.equal(f.state().outlineHistory[1].purpose, 'next');
  f.life.destroy();
});

test('failed next planning is rescued before sending and never selects a consumed outline', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls += 1;
    if (calls === 1) return result('旧');
    if (calls === 2) throw new Error('规划 API 返回了空内容');
    return result('补救');
  }, { retryCount: 0 });
  const old = await f.life.ensureCurrent();
  f.life.markUsing(old.id);
  f.messages.push({ messageId: 2, role: 'assistant', content: '第一轮' });
  f.life.onMessage();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.notices.length, 1);
  f.messages.push({ messageId: 3, role: 'user', content: '继续' });
  const next = await f.life.ensureCurrent();
  assert.equal(next.body, '补救');
  assert.equal(calls, 3);
  assert.equal(f.state().outlineHistory.length, 2);
  f.life.destroy();
});

test('editing an earlier floor invalidates a ready outline; late cancelled result cannot publish', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = f.life.ensureCurrent();
  await Promise.resolve();
  f.messages[0].content = '改后的开场';
  f.life.invalidate();
  release(result('过时'));
  await assert.rejects(pending);
  assert.equal(f.state().outlineHistory.length, 0);
  f.life.destroy();
});

test('total timeout covers all attempts; HTTP 404 is not retried', async () => {
  let calls = 0;
  const f = fixture(async () => { calls += 1; throw Object.assign(new Error('x'), { status: 404 }); });
  await assert.rejects(f.life.ensureCurrent());
  assert.equal(calls, 1);
  f.life.destroy();
  let attempts = 0;
  const timed = fixture(async () => {
    attempts += 1;
    await new Promise(resolve => setTimeout(resolve, 35));
    return { rawText: '缺标签' };
  }, { retryCount: 10, timeoutSeconds: 0.05 });
  await assert.rejects(timed.life.ensureCurrent(), /请求超时/);
  assert.ok(attempts <= 2);
  assert.equal(timed.state().outlineHistory.length, 0);
  timed.life.destroy();
});

test('cancelled planner requests do not retry or report a missing outline', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls += 1;
    const error = new Error('规划请求已取消');
    error.code = 'CANCELLED';
    throw error;
  }, { retryCount: 3 });
  await assert.rejects(f.life.ensureCurrent());
  assert.equal(calls, 1);
  assert.match(f.state().lastError, /已取消/);
  assert.doesNotMatch(f.state().lastError, /<outline>|缺少标签/);
  f.life.destroy();
});

test('metadata save failure is reported separately and never repeats a successful planner request', async () => {
  let calls = 0;
  let saves = 0;
  let failSave = true;
  const f = fixture(async () => { calls += 1; return result('只生成一次'); }, { retryCount: 3 }, {
    notify: () => { throw new Error('toast unavailable'); },
    persistState: async () => { saves += 1; if (failSave) throw new Error('metadata disk failure'); },
  });
  const life = f.life;
  const outline = await life.ensureCurrent();
  assert.equal(outline.body, '只生成一次');
  assert.equal(calls, 1);
  assert.equal(saves, 1);
  assert.equal((await life.ensureCurrent()).id, outline.id);
  assert.equal(calls, 1);
  assert.match(life.getStatus().persistenceError, /聊天保存失败/);
  assert.equal(life.getState().lastError, null);
  failSave = false;
  assert.equal(await life.retryPersistence(), true);
  assert.equal(saves, 2);
  assert.equal(calls, 1);
  assert.equal(life.getStatus().persistenceError, null);
  life.destroy();
});

test('restart marks an unresolved task interrupted, keeps successful history, and repairs before the next send', async () => {
  let state = {};
  const messages = [{ messageId: 0, role: 'assistant', content: '开场' }, { messageId: 1, role: 'user', content: '第一幕' }];
  const config = { enabled: true, retryCount: 0, timeoutSeconds: 1 };
  let calls = 0;
  const options = {
    readMessages: () => structuredClone(messages), readState: () => state, writeState: value => { state = value; },
    getConfig: () => config, getSignature: () => 'preset',
    run: async () => { calls += 1; return result(`细纲${calls}`); },
    classifyFailure: engine.classifyPlannerFailure, extractOutline: engine.extractOutline,
    hash: engine.fnv1a, stop() {}, notify() {}, log: {}, persistState: async () => {},
  };
  let life = engine.createPlanningLifecycle(options);
  const first = await life.ensureCurrent();
  messages.push({ messageId: 2, role: 'assistant', content: '第一幕回复' }, { messageId: 3, role: 'user', content: '第二幕' });
  state = { ...state, status: 'running', lastTask: { ...state.lastTask, status: 'running', key: 'unfinished-task' } };
  life.destroy();

  life = engine.createPlanningLifecycle(options);
  assert.equal(life.getState().status, 'interrupted');
  assert.equal(life.getState().lastTask.status, 'interrupted');
  assert.equal(life.getState().outlineHistory.find(item => item.id === first.id).status, 'ready');
  const rescued = await life.ensureCurrent();
  assert.equal(rescued.body, '细纲2');
  assert.equal(calls, 2);
  assert.equal(life.getState().outlineHistory.find(item => item.id === first.id).status, 'ready');
  life.destroy();
});

test('actual used message floor is flushed as a critical metadata save', async () => {
  const persisted = [];
  const f = fixture(async () => result('用于本轮'), { retryCount: 0 }, {
    persistState: async () => { persisted.push(structuredClone(f.state())); },
  });
  const life = f.life;
  const outline = await life.ensureCurrent();
  assert.equal(life.markUsing(outline.id), true);
  f.messages.push({ messageId: 2, role: 'assistant', content: '最终回复' });
  life.onMessage();
  assert.equal(persisted.at(-1).outlineHistory[0].usedMessageId, 2);
  await life.flushPersistence();
  assert.equal(persisted.at(-1).outlineHistory[0].usedMessageId, 2);
  assert.ok(persisted.length >= 2);
  life.destroy();
});

test('a failed save remains attached to its chat when the user switches chats', async () => {
  const states = [{}, {}];
  let active = 0;
  const messages = [{ messageId: 0, role: 'assistant', content: '开场' }, { messageId: 1, role: 'user', content: '输入' }];
  const life = engine.createPlanningLifecycle({
    readMessages: () => structuredClone(messages), readState: () => states[active],
    writeState: value => { states[active] = value; },
    getConfig: () => ({ enabled: true, retryCount: 0, timeoutSeconds: 1 }), getSignature: () => 'preset',
    run: async () => result('第一聊天'), persistState: async () => { throw new Error('disk failed'); },
    classifyFailure: engine.classifyPlannerFailure, extractOutline: engine.extractOutline,
    hash: engine.fnv1a, stop() {}, notify() {}, log: {},
  });
  await life.ensureCurrent();
  assert.match(life.getStatus().persistenceError, /聊天保存失败/);
  active = 1;
  life.invalidate();
  assert.equal(life.getStatus().persistenceError, null);
  assert.equal(states[1].outlineHistory.length, 0);
  active = 0;
  life.invalidate();
  assert.match(life.getStatus().persistenceError, /聊天保存失败/);
  life.destroy();
});

test('exported or copied chat state reuses only a source-verified outline', async () => {
  let state = {};
  const messages = [{ messageId: 0, role: 'assistant', content: '开场' }, { messageId: 1, role: 'user', content: '玩家输入' }];
  let calls = 0;
  const options = {
    readMessages: () => structuredClone(messages), readState: () => state, writeState: value => { state = value; },
    getConfig: () => ({ enabled: true, retryCount: 0, timeoutSeconds: 1 }), getSignature: () => 'preset',
    run: async () => result(`细纲${++calls}`), classifyFailure: engine.classifyPlannerFailure,
    extractOutline: engine.extractOutline, hash: engine.fnv1a, stop() {}, notify() {}, log: {},
  };
  let life = engine.createPlanningLifecycle(options);
  const first = await life.ensureCurrent();
  life.destroy();

  state = structuredClone(state); // chat JSONL metadata survives export, copy, or rename
  life = engine.createPlanningLifecycle(options);
  assert.equal((await life.ensureCurrent()).id, first.id);
  assert.equal(calls, 1);
  messages[0].content = '复制后改动的开场';
  const replanned = await life.ensureCurrent();
  assert.equal(replanned.body, '细纲2');
  assert.equal(state.outlineHistory.some(item => item.id === first.id), false);
  life.destroy();
});

test('repeated regenerate requests reuse the same current outline after temporary assistant deletion', async () => {
  let calls = 0;
  const f = fixture(async () => result(`细纲${++calls}`), { retryCount: 0 });
  const waitForCalls = async expected => {
    for (let attempt = 0; attempt < 30 && calls < expected; attempt += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, expected);
  };

  const initial = await f.life.ensureCurrent();
  assert.equal(f.life.markUsing(initial.id), true);
  f.messages.push({ messageId: 2, role: 'assistant', content: '2楼回复' });
  f.life.onMessage();
  await waitForCalls(2);
  f.messages.push({ messageId: 3, role: 'user', content: '3楼输入' });
  const current = await f.life.ensureCurrent();
  const currentId = current.id;
  assert.equal(f.life.markUsing(currentId), true);
  f.messages.push({ messageId: 4, role: 'assistant', content: '4楼回复0' });
  f.life.onMessage();
  await waitForCalls(3);

  for (let roll = 1; roll <= 3; roll += 1) {
    f.messages.pop();
    f.life.invalidate(); // SillyTavern may emit MESSAGE_DELETED before the regenerate interceptor.
    const reused = await f.life.ensureCurrent('regenerate');
    assert.equal(reused.id, currentId);
    assert.equal(f.life.markUsing(reused.id, 'regenerate'), true);
    f.messages.push({ messageId: 4, role: 'assistant', content: `4楼重roll${roll}` });
    f.life.onMessage();
    await waitForCalls(3 + roll);
  }
  assert.equal(f.state().outlineHistory.find(item => item.id === currentId).status, 'used');
  f.life.destroy();
});

test('swiping the current assistant preserves the current outline while replacing only its next outline', async () => {
  let calls = 0;
  const f = fixture(async () => result(`细纲${++calls}`), { retryCount: 0 });
  const initial = await f.life.ensureCurrent();
  f.life.markUsing(initial.id);
  f.messages.push({ messageId: 2, role: 'assistant', content: '2楼回复' });
  f.life.onMessage();
  await new Promise(resolve => setImmediate(resolve));
  f.messages.push({ messageId: 3, role: 'user', content: '3楼输入' });
  const current = await f.life.ensureCurrent();
  f.life.markUsing(current.id);
  f.messages.push({ messageId: 4, role: 'assistant', content: '4楼回复A' });
  f.life.onMessage();
  await new Promise(resolve => setImmediate(resolve));
  const callsBeforeSwipe = calls;

  f.messages[4].content = '4楼回复B';
  f.life.onMessage(); // MESSAGE_SWIPED for the existing assistant floor.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, callsBeforeSwipe + 1);
  assert.equal((await f.life.ensureCurrent('swipe')).id, current.id);
  f.life.destroy();
});

test('first use locks a pre-generated outline to the player input fingerprint', async () => {
  let calls = 0;
  const f = fixture(async () => result(`细纲${++calls}`), { retryCount: 0 });
  const initial = await f.life.ensureCurrent();
  f.life.markUsing(initial.id);
  f.messages.push({ messageId: 2, role: 'assistant', content: '2楼回复' });
  f.life.onMessage();
  await new Promise(resolve => setImmediate(resolve));
  f.messages.push({ messageId: 3, role: 'user', content: '原输入' });
  const firstUse = await f.life.ensureCurrent();
  assert.equal(f.life.markUsing(firstUse.id), true);
  f.messages[3].content = '不同输入';

  const replanned = await f.life.ensureCurrent();
  assert.notEqual(replanned.id, firstUse.id);
  assert.equal(replanned.body, '细纲3');
  f.life.destroy();
});

async function preparedUsedRound() {
  let calls = 0;
  const f = fixture(async () => result(`细纲${++calls}`), { retryCount: 0 });
  const initial = await f.life.ensureCurrent();
  assert.equal(f.life.markUsing(initial.id), true);
  f.messages.push({ messageId: 2, role: 'assistant', content: '2楼回复' });
  f.life.onMessage();
  for (let attempt = 0; attempt < 30 && calls < 2; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  f.messages.push({ messageId: 3, role: 'user', content: '3楼输入' });
  const current = await f.life.ensureCurrent();
  assert.equal(f.life.markUsing(current.id), true);
  f.messages.push({ messageId: 4, role: 'assistant', content: '4楼回复' });
  f.life.onMessage();
  for (let attempt = 0; attempt < 30 && calls < 3; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
  const next = f.state().outlineHistory.findLast(item => item.status === 'ready');
  return { f, current, next, calls: () => calls };
}

test('deleting only the used assistant floor returns its outline to ready and removes its derived next outline', async () => {
  const { f, current, next } = await preparedUsedRound();
  f.messages.pop();
  const changes = f.life.invalidate('MESSAGE_DELETED');
  assert.equal(f.state().outlineHistory.find(item => item.id === current.id).status, 'ready');
  assert.equal(f.state().outlineHistory.some(item => item.id === next.id), false);
  assert.deepEqual(changes.returnedToReadyIds, [current.id]);
  assert.deepEqual(changes.prunedIds, [next.id]);
  f.life.destroy();
});

test('deleting from the player floor through the end preserves a same-input candidate and replans different input', async () => {
  for (const input of ['3楼输入', '不同输入']) {
    const { f, current, next, calls } = await preparedUsedRound();
    f.messages.splice(3);
    const changes = f.life.invalidate('MESSAGE_DELETED');
    assert.equal(changes.returnedToReadyIds.includes(current.id), true);
    assert.equal(f.state().outlineHistory.some(item => item.id === next.id), false);
    f.messages.push({ messageId: 3, role: 'user', content: input });
    const selected = await f.life.ensureCurrent();
    if (input === '3楼输入') assert.equal(selected.id, current.id);
    else {
      assert.notEqual(selected.id, current.id);
      assert.equal(calls(), 4);
    }
    f.life.destroy();
  }
});

test('deleting a generation source floor prunes every outline derived from it', async () => {
  const { f, current } = await preparedUsedRound();
  f.messages.splice(2);
  const changes = f.life.invalidate('MESSAGE_DELETED');
  assert.equal(f.state().outlineHistory.some(item => item.id === current.id), false);
  assert.ok(changes.prunedIds.includes(current.id));
  f.life.destroy();
});

test('schema migration removes invalid and superseded records and clears stale active outline text', () => {
  let state = {
    schemaVersion: 3,
    chatId: 'persisted-chat',
    activeOutline: '<outline>不再可用的细纲</outline>',
    outlineHistory: [
      { id: 'invalid-old', sequence: 1, status: 'invalid', fullTag: '<outline>失效</outline>', body: '失效' },
      { id: 'superseded-old', sequence: 2, status: 'superseded', fullTag: '<outline>替代</outline>', body: '替代' },
    ],
  };
  const messages = [{ messageId: 0, role: 'assistant', content: '开场' }, { messageId: 1, role: 'user', content: '输入' }];
  const life = engine.createPlanningLifecycle({
    readMessages: () => structuredClone(messages), readState: () => state, writeState: value => { state = value; },
    getConfig: () => ({ enabled: true, retryCount: 0, timeoutSeconds: 1 }), getSignature: () => 'preset',
    run: async () => result('新细纲'), classifyFailure: engine.classifyPlannerFailure,
    extractOutline: engine.extractOutline, hash: engine.fnv1a, stop() {}, notify() {}, log: {},
  });
  const migrated = life.getState();
  assert.equal(migrated.schemaVersion, 4);
  assert.deepEqual(migrated.outlineHistory, []);
  assert.equal(migrated.activeOutline, '');
  assert.doesNotMatch(JSON.stringify(migrated), /失效|替代|不再可用/);
  life.destroy();
});

test('schema migration retains a ready record whose older source hash still verifies', async () => {
  const messages = engine.buildSnapshot([
    { message_id: 0, role: 'assistant', message: '开场', message_fingerprint: 'old-opening-fingerprint', input_fingerprint: 'opening-input' },
    { message_id: 1, role: 'user', message: '输入', message_fingerprint: 'old-user-fingerprint', input_fingerprint: 'same-user-input' },
  ]).messages;
  const oldSourceHash = engine.fnv1a(JSON.stringify(messages.map(({ messageId, role, content }) => ({ messageId, role, content }))));
  let state = {
    schemaVersion: 3, chatId: 'persisted-chat', activeOutline: '<outline>旧格式仍可验证</outline>',
    outlineHistory: [{ id: 'old-ready', sequence: 7, key: `persisted-chat:1:${oldSourceHash}:preset`,
      chatId: 'persisted-chat', signature: 'preset', sourceHash: oldSourceHash, sourceMessageId: 1,
      purpose: 'initial', status: 'ready', fullTag: '<outline>旧格式仍可验证</outline>', body: '旧格式仍可验证',
      usedMessageId: null, createdAt: '2026-01-01T00:00:00.000Z' }],
  };
  let calls = 0;
  const life = engine.createPlanningLifecycle({
    readMessages: () => structuredClone(messages), readState: () => state, writeState: value => { state = value; },
    getConfig: () => ({ enabled: true, retryCount: 0, timeoutSeconds: 1 }), getSignature: () => 'preset',
    run: async () => { calls += 1; return result('新细纲'); }, classifyFailure: engine.classifyPlannerFailure,
    extractOutline: engine.extractOutline, hash: engine.fnv1a, stop() {}, notify() {}, log: {},
  });
  assert.equal((await life.ensureCurrent()).id, 'old-ready');
  assert.equal(calls, 0);
  assert.equal(state.outlineHistory[0].sourceHash === oldSourceHash, false);
  life.destroy();
});

test('middle deletion with duplicate message fingerprints is treated as ambiguous and pruned', async () => {
  let state = {};
  let calls = 0;
  const messages = [
    { messageId: 0, role: 'assistant', content: '开场' },
    { messageId: 1, role: 'assistant', content: '重复回复' },
    { messageId: 2, role: 'assistant', content: '重复回复' },
    { messageId: 3, role: 'user', content: '继续' },
  ];
  const life = engine.createPlanningLifecycle({
    readMessages: () => structuredClone(messages), readState: () => state, writeState: value => { state = value; },
    getConfig: () => ({ enabled: true, retryCount: 0, timeoutSeconds: 1 }), getSignature: () => 'preset',
    run: async () => { calls += 1; return result(`细纲${calls}`); }, classifyFailure: engine.classifyPlannerFailure,
    extractOutline: engine.extractOutline, hash: engine.fnv1a, stop() {}, notify() {}, log: {},
  });
  const outline = await life.ensureCurrent();
  messages.splice(1, 1);
  messages.forEach((message, messageId) => { message.messageId = messageId; });
  const changes = life.invalidate('MESSAGE_DELETED');
  assert.equal(state.outlineHistory.some(record => record.id === outline.id), false);
  assert.deepEqual(changes.ambiguousIds, [outline.id]);
  assert.equal(calls, 1);
  life.destroy();
});

test('deleting one of two identical player inputs does not preserve an ambiguous candidate', async () => {
  let state = {};
  const messages = [
    { messageId: 0, role: 'assistant', content: '开场' },
    { messageId: 1, role: 'assistant', content: '共同来源' },
    { messageId: 2, role: 'user', content: '重复输入' },
    { messageId: 3, role: 'user', content: '重复输入' },
  ];
  const life = engine.createPlanningLifecycle({
    readMessages: () => structuredClone(messages), readState: () => state, writeState: value => { state = value; },
    getConfig: () => ({ enabled: true, retryCount: 0, timeoutSeconds: 1 }), getSignature: () => 'preset',
    run: async () => result('输入细纲'), classifyFailure: engine.classifyPlannerFailure,
    extractOutline: engine.extractOutline, hash: engine.fnv1a, stop() {}, notify() {}, log: {},
  });
  const outline = await life.ensureCurrent();
  messages.splice(2, 1);
  messages.forEach((message, messageId) => { message.messageId = messageId; });
  const changes = life.invalidate('MESSAGE_DELETED');
  assert.equal(state.outlineHistory.some(record => record.id === outline.id), false);
  assert.deepEqual(changes.ambiguousIds, [outline.id]);
  life.destroy();
});

test('deleting the source while a plan request is in flight cancels its late result', async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }), { retryCount: 0 });
  const pending = f.life.ensureCurrent();
  await Promise.resolve();
  f.messages.splice(1);
  const changes = f.life.invalidate('MESSAGE_DELETED');
  release(result('迟到细纲'));
  await assert.rejects(pending);
  assert.equal(f.state().outlineHistory.length, 0);
  assert.deepEqual(changes.cancelledTaskIds.length, 1);
  assert.doesNotMatch(JSON.stringify(f.state()), /迟到细纲/);
  f.life.destroy();
});

test('stopping current foreground planning cancels it without stopping background next planning', async () => {
  let releaseCurrent;
  const foreground = fixture(() => new Promise(resolve => { releaseCurrent = resolve; }), { retryCount: 0 });
  const pendingCurrent = foreground.life.ensureCurrent();
  await Promise.resolve();
  foreground.life.stopCurrent();
  assert.equal(foreground.state().lastTask.status, 'cancelled');
  assert.equal(engine.buildPanelViewModel({ enabled: true }, foreground.state(), foreground.life.getStatus()).status, 'idle');
  releaseCurrent(result('停止后迟到的细纲'));
  await assert.rejects(pendingCurrent);
  assert.equal(foreground.state().outlineHistory.length, 0);
  foreground.life.destroy();

  let calls = 0;
  let releaseNext;
  const background = fixture(() => {
    calls += 1;
    return calls === 1 ? Promise.resolve(result('本轮')) : new Promise(resolve => { releaseNext = resolve; });
  }, { retryCount: 0 });
  const initial = await background.life.ensureCurrent();
  assert.equal(background.life.markUsing(initial.id), true);
  background.messages.push({ messageId: 2, role: 'assistant', content: '本轮回复' });
  background.life.onMessage();
  for (let attempt = 0; attempt < 30 && calls < 2; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(background.life.getStatus().phase, 'next');
  background.life.stopCurrent();
  assert.equal(background.life.getStatus().running, true);
  releaseNext(result('后台下一轮'));
  for (let attempt = 0; attempt < 30 && background.state().outlineHistory.length < 2; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(background.state().outlineHistory.some(record => record.body === '后台下一轮'), true);
  background.life.destroy();
});

test('stopping planner-owned next task rejects its late result and rescues on the next send', async () => {
  let calls = 0;
  let releaseNext;
  const phases = [];
  const f = fixture(() => {
    calls += 1;
    return calls === 2 ? new Promise(resolve => { releaseNext = resolve; }) : Promise.resolve(result(`细纲${calls}`));
  }, { retryCount: 0 }, { onTaskChange: status => phases.push(status) });
  const first = await f.life.ensureCurrent();
  f.life.markUsing(first.id);
  f.messages.push({ messageId: 2, role: 'assistant', content: '第一轮回复' });
  f.life.onMessage();
  for (let attempt = 0; attempt < 30 && calls < 2; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.life.getStatus().phase, 'next');
  assert.equal(phases.at(-1).phase, 'next');
  assert.equal(phases.at(-1).running, true);
  f.life.stopActivePlanning();
  assert.equal(phases.at(-1).running, false);
  assert.equal(f.state().lastTask.status, 'cancelled');
  assert.equal(engine.buildPanelViewModel({ enabled: true }, f.state(), f.life.getStatus()).status, 'idle');
  releaseNext(result('不应保存的迟到细纲'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state().outlineHistory.some(item => item.body === '不应保存的迟到细纲'), false);
  assert.equal(f.notices.length, 0);
  f.messages.push({ messageId: 3, role: 'user', content: '下一步' });
  assert.equal((await f.life.ensureCurrent()).body, '细纲3');
  f.life.destroy();
});

test('stopping after outline injection restores ready or last-used state', async () => {
  const fresh = fixture(async () => result('待用细纲'), { retryCount: 0 });
  const ready = await fresh.life.ensureCurrent();
  assert.equal(fresh.life.markUsing(ready.id), true);
  fresh.life.stopCurrent();
  assert.equal(fresh.state().outlineHistory.find(record => record.id === ready.id).status, 'ready');
  fresh.life.destroy();

  const { f, current } = await preparedUsedRound();
  const previousUsedMessageId = f.state().outlineHistory.find(record => record.id === current.id).usedMessageId;
  assert.equal(f.life.markUsing(current.id, 'regenerate'), true);
  f.life.stopCurrent();
  const restored = f.state().outlineHistory.find(record => record.id === current.id);
  assert.equal(restored.status, 'used');
  assert.equal(restored.usedMessageId, previousUsedMessageId);
  f.life.destroy();
});
