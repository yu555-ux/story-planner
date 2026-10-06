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

test('manual replan preserves old result, supersedes only ready revision, and deduplicates active requests', async () => {
  let calls = 0;
  const f = fixture(async () => result(`版本${++calls}`), { retryCount: 0 });
  const first = await f.life.ensureCurrent();
  assert.equal(f.life.manual(), true);
  f.life.manual();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(f.state().outlineHistory.length, 2);
  assert.equal(f.state().outlineHistory[0].status, 'superseded');
  assert.equal(f.state().outlineHistory[0].body, first.body);
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

test('history can be reopened with stable chat identity; stale legacy outline is never injected', async () => {
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
  assert.equal(state.outlineHistory[0].status, 'invalid');
  assert.equal(state.outlineHistory[0].body, '旧细纲');
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
  assert.equal(state.outlineHistory.find(item => item.id === first.id).status, 'invalid');
  life.destroy();
});
