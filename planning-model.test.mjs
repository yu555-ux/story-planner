import test from 'node:test';
import assert from 'node:assert/strict';
import model from './planning-model.js';

const overall = `<overall_outline>\n核心主题: 成长\n主角起点: 山村\n主线目标: 寻找真相\n故事基调: 悬疑\n</overall_outline>`;
const volume = `<volume_outline>\n卷名: 第一卷\n本卷定位: 起点\n本卷目标: 入城\n核心剧情: 追查线索\n关键事件:\n  - 找到信件\n  - 寻找证人\n结尾收束: 得知真相\n</volume_outline>`;
const event = `<event_outline>\n事件名: 信件\n事件定位: 开端\n事件目标: 拿到信件\n核心剧情: 进入旧宅\n阶段1:\n  阶段目标: 入宅\n  核心情节: 搜索\n  结尾收束: 找到暗格\n</event_outline>`;
const fine = `<fine_outline>\n阶段1:\n  剧情目的: 入宅\n  时间: 夜晚\n  地点: 旧宅\n  核心情节: 绕开守卫\n  结尾收束: 进入书房\n阶段2:\n  剧情目的: 找信\n  时间: 夜晚\n  地点: 书房\n  核心情节: 打开暗格\n  结尾收束: 取出信件\n</fine_outline>`;

function parse(text, kind) {
  const result = model.parsePlannerOutput(text, { kind });
  assert.equal(result.ok, true, result.error);
  return result;
}

function append(state, kind, text, id) {
  const need = model.getPlanningNeed(state);
  assert.equal(need.kind, kind);
  const result = model.appendOutlineBatch(state, {
    kind, parsed: parse(text, kind), ...need, idFactory: () => id,
  });
  assert.equal(result.ok, true, result.error);
  return result.state;
}

test('four-layer plan is built in order and rejects an obsolete parent stage', () => {
  const initial = model.applyInitialPlan(model.createVariablePlannerState({ chatId: 'chat-A' }),
    parse(overall + volume, 'initial'), { idFactory: () => 'first' });
  assert.equal(initial.ok, true);
  let state = initial.state;
  assert.equal(model.getPlanningNeed(state).kind, 'event');
  const staleNeed = model.getPlanningNeed(state);
  state = append(state, 'event', event, 'event');
  assert.equal(model.getPlanningNeed(state).kind, 'fine');
  const stale = model.appendOutlineBatch(state, { kind: 'event', parsed: parse(event, 'event'), ...staleNeed });
  assert.equal(stale.ok, false);
  state = append(state, 'fine', fine, 'fine');
  assert.equal(model.getPlanningNeed(state).kind, 'ready');
  assert.equal(model.getActivePlanSnapshot(state).fine.stageTitle, '阶段1');
});

test('body completion advances each layer only when its own stage and descendants complete', () => {
  let state = model.applyInitialPlan(model.createVariablePlannerState({ chatId: 'chat-A' }),
    parse(overall + volume, 'initial'), { idFactory: () => 'first' }).state;
  state = append(state, 'event', event, 'event');
  state = append(state, 'fine', fine, 'fine');
  const snapshot = model.getActivePlanSnapshot(state);
  const report = model.parsePlannerUpdate(`<planner_update>\nset(卷纲.阶段完成, true)\nset(事件纲.阶段完成, true)\nset(细纲.阶段完成, true)\n</planner_update>`);
  assert.equal(report.ok, true, report.error);
  const settled = model.settlePlannerUpdate(state, { snapshot, report: report.report, replyId: 'reply-1' });
  assert.equal(settled.ok, true, settled.error);
  state = settled.state;
  assert.equal(state.volumes[0].stages[0].completed, false);
  assert.equal(state.events[0].stages[0].completed, false);
  assert.equal(state.fines[0].stages[0].completed, true);
  assert.equal(model.getActivePlanSnapshot(state).fine.stageTitle, '阶段2');
  const second = model.parsePlannerUpdate(`<planner_update>\nset(细纲.阶段完成, true)\n</planner_update>`);
  const done = model.settlePlannerUpdate(state, {
    snapshot: model.getActivePlanSnapshot(state), report: second.report, replyId: 'reply-2',
  });
  assert.equal(done.ok, true, done.error);
  state = done.state;
  assert.equal(state.events[0].stages[0].completed, true);
  assert.equal(state.volumes[0].stages[0].completed, true);
  assert.equal(model.getPlanningNeed(state).kind, 'event');
});

test('a reported rewrite invalidates only the affected lower plans before the next turn', () => {
  let state = model.applyInitialPlan(model.createVariablePlannerState({ chatId: 'chat-A' }),
    parse(overall + volume, 'initial'), { idFactory: () => 'first' }).state;
  state = append(state, 'event', event, 'event');
  state = append(state, 'fine', fine, 'fine');
  const snapshot = model.getActivePlanSnapshot(state);
  const report = model.parsePlannerUpdate(`<planner_update>\nset(重写.需要, true)\nset(重写.问题提纲, "事件纲")\nset(重写.问题说明, "玩家已经取走信件，进入旧宅的前提失效。")\n</planner_update>`);
  assert.equal(report.ok, true, report.error);
  state = model.settlePlannerUpdate(state, { snapshot, report: report.report, replyId: 'rewrite-reply' }).state;
  assert.equal(state.pendingRewrite.targetKind, 'event');
  const replacement = event.replace('进入旧宅', '追查送信人');
  const rewritten = model.appendRewriteResult(state, {
    targetKind: 'event', targetNodeId: snapshot.event.id,
    parsed: model.parsePlannerOutput(replacement, { kind: 'rewrite', rewriteTarget: 'event' }),
  });
  assert.equal(rewritten.ok, true, rewritten.error);
  state = rewritten.state;
  assert.equal(state.pendingRewrite, null);
  assert.equal(state.events[0].body.includes('追查送信人'), true);
  assert.equal(state.fines[0].status, 'superseded');
  assert.equal(model.getPlanningNeed(state).kind, 'fine');
});
