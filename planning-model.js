(function attachPlanningModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TWStoryPlannerModelV1 = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createPlanningModel() {
  'use strict';

  const TAG_TO_KIND = Object.freeze({
    overall_outline: 'overall',
    volume_outline: 'volume',
    event_outline: 'event',
    fine_outline: 'fine',
  });
  const KIND_TO_TAG = Object.freeze(Object.fromEntries(Object.entries(TAG_TO_KIND).map(([tag, kind]) => [kind, tag])));
  const REPORT_PATHS = Object.freeze({
    '卷纲.阶段完成': { type: 'boolean', layer: 'volume' },
    '事件纲.阶段完成': { type: 'boolean', layer: 'event' },
    '细纲.阶段完成': { type: 'boolean', layer: 'fine' },
    '重写.需要': { type: 'boolean', layer: 'rewrite' },
    '重写.问题提纲': { type: 'string', layer: 'rewriteTarget' },
    '重写.问题说明': { type: 'string', layer: 'rewriteDescription' },
  });
  const REWRITE_TARGETS = Object.freeze({ 卷纲: 'volume', 事件纲: 'event', 细纲: 'fine' });
  const REQUIRED_FIELDS = Object.freeze({
    overall: ['核心主题', '主角起点', '主线目标', '故事基调'],
    volume: ['卷名', '本卷定位', '本卷目标', '核心剧情', '关键事件', '结尾收束'],
    event: ['事件名', '事件定位', '事件目标', '核心剧情'],
  });
  const REQUIRED_STAGE_FIELDS = Object.freeze({
    event: ['阶段目标', '核心情节', '结尾收束'],
    fine: ['剧情目的', '时间', '地点', '核心情节', '结尾收束'],
  });

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  }

  function fail(error) {
    return { ok: false, error };
  }

  function findFieldLines(body, field) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^[ \\t]*${escaped}[ \\t]*[:：][ \\t]*(.*)$`, 'gm');
    return [...body.matchAll(pattern)];
  }

  function validateFields(body, fields, label) {
    for (const field of fields) {
      const matches = findFieldLines(body, field);
      if (!matches.length) return `缺少必需字段“${field}”`;
      if (matches.length > 1) return `${label}字段“${field}”重复`;
    }
    return null;
  }

  function parseKeyEvents(body) {
    const matches = findFieldLines(body, '关键事件');
    if (matches.length !== 1) return fail(matches.length ? '卷纲字段“关键事件”重复' : '缺少必需字段“关键事件”');
    const match = matches[0];
    const inline = match[1].trim();
    if (inline) return { ok: true, items: [inline] };
    const start = match.index + match[0].length;
    const tail = body.slice(start).split(/\r?\n/);
    const items = [];
    let current = null;
    for (const line of tail) {
      if (/^\s*[^\s#][^:：\r\n]*\s*[:：]/.test(line)) break;
      const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
      if (bullet) {
        if (current) items.push(current.trim());
        current = bullet[1];
      } else if (current && line.trim()) {
        current += ` ${line.trim()}`;
      }
    }
    if (current) items.push(current.trim());
    return items.length ? { ok: true, items } : fail('卷纲“关键事件”至少需要一项');
  }

  function parseStages(body, kind) {
    const lines = body.split(/\r?\n/);
    const starts = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s*(阶段[^:：\r\n]*?)\s*[:：]\s*$/);
      if (match) starts.push({ index, title: match[1].trim() });
    }
    if (!starts.length) return fail(`${kind === 'event' ? '事件纲' : '细纲'}至少需要一个“阶段x”`);
    const required = REQUIRED_STAGE_FIELDS[kind];
    const stages = [];
    for (let position = 0; position < starts.length; position += 1) {
      const start = starts[position];
      const end = starts[position + 1]?.index ?? lines.length;
      const content = lines.slice(start.index + 1, end).join('\n').trim();
      if (!content) return fail(`${start.title}内容为空`);
      const missing = validateFields(content, required, start.title);
      if (missing) return fail(`${start.title}${missing}`);
      stages.push({ index: position, title: start.title, content });
    }
    return { ok: true, stages };
  }

  function parseOutlineBlock(tagName, fullTag, body) {
    const kind = TAG_TO_KIND[tagName.toLowerCase()];
    if (!kind) return fail(`不支持的提纲标签 <${tagName}>`);
    const required = REQUIRED_FIELDS[kind] ?? [];
    const missing = validateFields(body, required, `${kind}提纲`);
    if (missing) return fail(`${kind}提纲${missing}`);
    const value = { kind, fullTag, body };
    if (kind === 'volume') {
      const keyEvents = parseKeyEvents(body);
      if (!keyEvents.ok) return keyEvents;
      value.stages = keyEvents.items.map((content, index) => ({ index, title: `关键事件${index + 1}`, content }));
    }
    if (kind === 'event' || kind === 'fine') {
      const parsedStages = parseStages(body, kind);
      if (!parsedStages.ok) return parsedStages;
      value.stages = parsedStages.stages;
    }
    return { ok: true, value };
  }

  function extractTaggedBlocks(rawText) {
    if (typeof rawText !== 'string') return fail('规划结果不是文本');
    const tags = [...rawText.matchAll(/<(\/)?(overall_outline|volume_outline|event_outline|fine_outline)\s*>/gi)];
    if (!tags.length) return fail('规划结果缺少有效的四层提纲标签');
    const blocks = [];
    let open = null;
    for (const tag of tags) {
      const closing = Boolean(tag[1]);
      const name = tag[2].toLowerCase();
      if (!closing) {
        if (open) return fail('提纲标签不能嵌套或交错');
        open = { name, start: tag.index, bodyStart: tag.index + tag[0].length };
        continue;
      }
      if (!open || open.name !== name) return fail(`</${name}> 标签没有对应开始标签`);
      const body = rawText.slice(open.bodyStart, tag.index).trim();
      if (!body) return fail(`<${name}> 内容为空`);
      const parsed = parseOutlineBlock(name, rawText.slice(open.start, tag.index + tag[0].length), body);
      if (!parsed.ok) return parsed;
      blocks.push(parsed.value);
      open = null;
    }
    if (open) return fail(`<${open.name}> 标签未闭合`);
    return { ok: true, blocks };
  }

  function parsePlannerOutput(rawText, { kind, rewriteTarget } = {}) {
    const extracted = extractTaggedBlocks(rawText);
    if (!extracted.ok) return extracted;
    const blocks = extracted.blocks;
    let expectedKinds;
    if (kind === 'initial') expectedKinds = new Set(['overall', 'volume']);
    else if (kind === 'volume' || kind === 'event' || kind === 'fine') expectedKinds = new Set([kind]);
    else if (kind === 'rewrite' && Object.values(REWRITE_TARGETS).includes(rewriteTarget)) expectedKinds = new Set([rewriteTarget]);
    else return fail('规划任务类型无效');
    if (blocks.some(block => !expectedKinds.has(block.kind))) return fail('规划输出含有不属于当前任务的提纲层级');
    const overall = blocks.filter(block => block.kind === 'overall');
    const volumes = blocks.filter(block => block.kind === 'volume');
    const events = blocks.filter(block => block.kind === 'event');
    const fines = blocks.filter(block => block.kind === 'fine');
    if (kind === 'initial' && (overall.length !== 1 || volumes.length === 0)) {
      return fail('开局规划必须包含且仅包含一个总纲，并至少包含一个卷纲');
    }
    if (kind === 'initial' && overall.length !== 1) return fail('总纲必须且只能出现一次');
    if (kind === 'volume' && !volumes.length) return fail('卷纲补充任务没有返回卷纲');
    if (kind === 'event' && !events.length) return fail('事件纲任务没有返回事件纲');
    if (kind === 'fine' && !fines.length) return fail('细纲任务没有返回细纲');
    if (kind === 'rewrite' && blocks.length !== 1) return fail('重写任务必须只返回一个目标提纲');
    return { ok: true, value: { overall: overall[0] ?? null, volumes, events, fines, blocks } };
  }

  function emptyReport() {
    return {
      completion: { volume: false, event: false, fine: false },
      rewrite: { needed: false, target: '', targetKind: null, description: '' },
      present: [],
    };
  }

  function parseLiteral(path, value) {
    const definition = REPORT_PATHS[path];
    if (!definition) return fail(`不允许的回报路径：${path}`);
    if (definition.type === 'boolean') {
      if (value !== 'true' && value !== 'false') return fail(`${path} 必须是布尔值`);
      return { ok: true, value: value === 'true' };
    }
    let parsed;
    try { parsed = JSON.parse(value); }
    catch { return fail(`${path} 必须使用合法的双引号字符串`); }
    return typeof parsed === 'string' ? { ok: true, value: parsed } : fail(`${path} 必须是字符串`);
  }

  function parsePlannerUpdate(rawText) {
    const report = emptyReport();
    if (typeof rawText !== 'string') return fail('助手回复不是文本');
    const opens = [...rawText.matchAll(/<planner_update\s*>/gi)];
    const closes = [...rawText.matchAll(/<\/planner_update\s*>/gi)];
    if (!opens.length && !closes.length) return { ok: true, report, present: false };
    if (opens.length !== 1 || closes.length !== 1 || closes[0].index < opens[0].index + opens[0][0].length) {
      return fail('planner_update 标签必须恰好成对出现一次');
    }
    const start = opens[0].index + opens[0][0].length;
    const content = rawText.slice(start, closes[0].index);
    const seen = new Set();
    const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^set\(\s*([^,]+?)\s*,\s*(.*?)\s*\)$/);
      if (!match) return fail('planner_update 中存在无效 set 语句');
      const path = match[1].trim();
      if (!Object.hasOwn(REPORT_PATHS, path)) return fail(`不允许的回报路径：${path}`);
      if (seen.has(path)) return fail(`回报路径重复：${path}`);
      seen.add(path);
      const parsed = parseLiteral(path, match[2]);
      if (!parsed.ok) return parsed;
      const field = REPORT_PATHS[path];
      if (field.layer === 'rewrite') report.rewrite.needed = parsed.value;
      else if (field.layer === 'rewriteTarget') report.rewrite.target = parsed.value;
      else if (field.layer === 'rewriteDescription') report.rewrite.description = parsed.value;
      else report.completion[field.layer] = parsed.value;
    }
    if (report.rewrite.target && !Object.hasOwn(REWRITE_TARGETS, report.rewrite.target)) {
      return fail('重写.问题提纲只能是卷纲、事件纲或细纲');
    }
    if (report.rewrite.needed) {
      if (!seen.has('重写.问题提纲') || !seen.has('重写.问题说明') || !report.rewrite.target || !report.rewrite.description.trim()) {
        return fail('需要重写时必须填写问题提纲和问题说明');
      }
      report.rewrite.targetKind = REWRITE_TARGETS[report.rewrite.target];
    } else if (report.rewrite.target || report.rewrite.description) {
      return fail('不需要重写时问题提纲和问题说明必须留空');
    }
    report.present = [...seen];
    return { ok: true, report, present: true };
  }

  function createVariablePlannerState({ chatId = '', planRevision = 0 } = {}) {
    return {
      schemaVersion: 1,
      chatId,
      planRevision,
      overall: null,
      volumes: [],
      events: [],
      fines: [],
      pendingAdvance: { volumeStageIds: [], eventStageIds: [] },
      pendingRewrite: null,
      settlements: [],
      updatedAt: null,
    };
  }

  function makeId(kind, idFactory) {
    return `${kind}-${idFactory()}`;
  }

  function makeStages(nodeId, revision, stages) {
    return stages.map((stage, index) => ({
      id: `${nodeId}:r${revision}:s${index + 1}`,
      index,
      title: stage.title,
      content: stage.content,
      completionRequested: false,
      completed: false,
      completionSource: null,
    }));
  }

  function makeNode(kind, parsed, state, context, idFactory) {
    const id = makeId(kind, idFactory);
    const revision = context.revision ?? (state.planRevision ?? 0) + 1;
    const node = { id, kind, revision, fullTag: parsed.fullTag, body: parsed.body, status: 'active', createdAt: new Date().toISOString() };
    if (kind === 'volume' || kind === 'event' || kind === 'fine') node.stages = makeStages(id, revision, parsed.stages ?? []);
    if (kind === 'volume') {
      node.parentId = context.parentId ?? state.overall?.id ?? null;
      node.parentRevision = context.parentRevision ?? state.overall?.revision ?? null;
    } else if (kind === 'event') {
      node.parentId = context.parentId;
      node.parentRevision = context.parentRevision;
      node.parentStageId = context.parentStageId;
    } else if (kind === 'fine') {
      node.parentId = context.parentId;
      node.parentRevision = context.parentRevision;
      node.parentStageId = context.parentStageId;
    }
    return node;
  }

  function applyInitialPlan(state, parsed, { idFactory = () => `${Date.now()}-${Math.random()}` } = {}) {
    if (!isRecord(state) || !parsed?.ok || !parsed.value?.overall || !parsed.value.volumes?.length) return fail('开局计划数据无效');
    const planRevision = (state.planRevision ?? 0) + 1;
    const overallId = makeId('overall', idFactory);
    const overall = { id: overallId, kind: 'overall', revision: planRevision,
      fullTag: parsed.value.overall.fullTag, body: parsed.value.overall.body, createdAt: new Date().toISOString() };
    const archived = [state.overall, ...(state.volumes ?? []), ...(state.events ?? []), ...(state.fines ?? [])]
      .filter(Boolean).map(node => ({ nodeId: node.id, kind: node.kind, revision: node.revision,
        fullTag: node.fullTag, body: node.body, stages: clone(node.stages ?? []), archivedAt: new Date().toISOString() }));
    const next = { ...clone(state), planRevision, overall, volumes: [], events: [], fines: [],
      pendingAdvance: { volumeStageIds: [], eventStageIds: [] }, pendingRewrite: null,
      revisionHistory: [...(state.revisionHistory ?? []), ...archived],
      settlementHistory: [...(state.settlementHistory ?? []), ...(state.settlements ?? []).map(item => ({ ...clone(item), archivedAt: new Date().toISOString() }))],
      settlements: [] };
    delete next.pendingTurn;
    next.volumes = parsed.value.volumes.map(item => makeNode('volume', item, next,
      { parentId: overall.id, parentRevision: overall.revision, revision: planRevision }, idFactory));
    next.updatedAt = new Date().toISOString();
    return { ok: true, state: next };
  }

  function findStage(state, stageId) {
    if (typeof stageId !== 'string') return null;
    for (const collection of ['volumes', 'events', 'fines']) {
      for (const node of state?.[collection] ?? []) {
        const stage = node.stages?.find(item => item.id === stageId);
        if (stage) return { collection, node, stage };
      }
    }
    return null;
  }

  function appendOutlineBatch(state, { kind, parsed, parentId, parentRevision, parentStageId, idFactory = () => `${Date.now()}-${Math.random()}` } = {}) {
    if (!isRecord(state)) return fail('规划器状态无效');
    if (state.pendingRewrite) return fail('存在待重写提纲，不能追加其他批次');
    const collection = kind === 'volume' ? 'volumes' : kind === 'event' ? 'events' : kind === 'fine' ? 'fines' : null;
    const items = kind === 'volume' ? parsed?.value?.volumes : kind === 'event' ? parsed?.value?.events : kind === 'fine' ? parsed?.value?.fines : null;
    if (!collection || !Array.isArray(items) || !items.length) return fail('规划批次必须包含有效提纲');
    const need = getPlanningNeed(state);
    if (need.kind !== kind || need.parentId !== parentId || need.parentRevision !== parentRevision
      || need.parentStageId !== (parentStageId ?? null)) return fail('规划批次与当前缺口或父阶段不匹配');
    if (kind === 'volume') {
      if (!state.overall || state.overall.id !== parentId || state.overall.revision !== parentRevision) return fail('卷纲批次的总纲修订号已失效');
    } else {
      const parent = findStage(state, parentStageId);
      const expectedParentCollection = kind === 'event' ? 'volumes' : 'events';
      if (!parent || parent.collection !== expectedParentCollection || parent.node.id !== parentId
        || parent.node.revision !== parentRevision || parent.stage.completed) return fail('规划批次的父阶段或修订号已失效');
    }
    const nodes = items.map(item => makeNode(kind, item, state, { parentId, parentRevision, parentStageId }, idFactory));
    const next = { ...clone(state), planRevision: (state.planRevision ?? 0) + 1,
      [collection]: [...(state[collection] ?? []), ...nodes], updatedAt: new Date().toISOString() };
    return { ok: true, state: next, nodes };
  }

  function firstOpenStage(nodes, predicate = () => true) {
    for (const node of nodes ?? []) {
      if (node.status === 'superseded' || !predicate(node)) continue;
      const stage = node.stages?.find(item => !item.completed);
      if (stage) return { node, stage };
    }
    return null;
  }

  function getActivePlanSnapshot(state) {
    if (!isRecord(state)) return null;
    const volume = firstOpenStage(state.volumes, node => node.parentId === state.overall?.id
      && node.parentRevision === state.overall?.revision);
    if (!volume) return null;
    const event = firstOpenStage(state.events, node => node.parentId === volume.node.id && node.parentStageId === volume.stage.id
      && node.parentRevision === volume.node.revision);
    const fine = event ? firstOpenStage(state.fines, node => node.parentId === event.node.id
      && node.parentStageId === event.stage.id && node.parentRevision === event.node.revision) : null;
    return {
      chatId: state.chatId,
      planRevision: state.planRevision,
      overall: state.overall ? { id: state.overall.id, revision: state.overall.revision, fullTag: state.overall.fullTag, body: state.overall.body } : null,
      volume: { id: volume.node.id, revision: volume.node.revision, fullTag: volume.node.fullTag,
        stageId: volume.stage.id, stageIndex: volume.stage.index, stageTitle: volume.stage.title, stageContent: volume.stage.content },
      event: event ? { id: event.node.id, revision: event.node.revision, parentStageId: volume.stage.id,
        fullTag: event.node.fullTag, stageId: event.stage.id, stageIndex: event.stage.index,
        stageTitle: event.stage.title, stageContent: event.stage.content } : null,
      fine: fine ? { id: fine.node.id, revision: fine.node.revision, parentStageId: event.stage.id,
        fullTag: fine.node.fullTag, stageId: fine.stage.id, stageIndex: fine.stage.index,
        stageTitle: fine.stage.title, stageContent: fine.stage.content } : null,
    };
  }

  function getPlanningNeed(state) {
    if (!isRecord(state) || !state.overall || !Array.isArray(state.volumes) || !state.volumes.length) {
      return { kind: 'initial', parentId: null, parentRevision: null, parentStageId: null };
    }
    const volume = firstOpenStage(state.volumes, node => node.parentId === state.overall.id
      && node.parentRevision === state.overall.revision);
    if (!volume) return { kind: 'volume', parentId: state.overall.id, parentRevision: state.overall.revision, parentStageId: null };
    const event = firstOpenStage(state.events, node => node.parentId === volume.node.id
      && node.parentRevision === volume.node.revision && node.parentStageId === volume.stage.id);
    if (!event) return { kind: 'event', parentId: volume.node.id, parentRevision: volume.node.revision, parentStageId: volume.stage.id };
    const fine = firstOpenStage(state.fines, node => node.parentId === event.node.id
      && node.parentRevision === event.node.revision && node.parentStageId === event.stage.id);
    if (!fine) return { kind: 'fine', parentId: event.node.id, parentRevision: event.node.revision, parentStageId: event.stage.id };
    return { kind: 'ready', parentId: null, parentRevision: null, parentStageId: null };
  }

  function childrenCompleteForEvent(state, eventStageId) {
    const children = (state.fines ?? []).filter(node => node.status !== 'superseded' && node.parentStageId === eventStageId);
    if (!children.length) return findStage(state, eventStageId)?.stage.completed === true;
    return children.every(node => node.stages.length > 0 && node.stages.every(stage => stage.completed));
  }

  function childrenCompleteForVolume(state, volumeStageId) {
    const events = (state.events ?? []).filter(node => node.status !== 'superseded' && node.parentStageId === volumeStageId);
    if (!events.length) return findStage(state, volumeStageId)?.stage.completed === true;
    return events.every(node => node.stages.length > 0
      && node.stages.every(stage => stage.completed && childrenCompleteForEvent(state, stage.id)));
  }

  function settleCompletions(state) {
    const next = clone(state);
    for (const node of next.events) {
      if (node.status === 'superseded') continue;
      for (const stage of node.stages) {
        if (stage.completionRequested && childrenCompleteForEvent(next, stage.id)) {
          stage.completed = true;
          stage.completionSource = 'reply';
        }
      }
    }
    for (const node of next.volumes) {
      if (node.status === 'superseded') continue;
      for (const stage of node.stages) {
        if (stage.completionRequested && childrenCompleteForVolume(next, stage.id)) {
          stage.completed = true;
          stage.completionSource = 'reply';
        }
      }
    }
    next.pendingAdvance = {
      volumeStageIds: next.volumes.filter(node => node.status !== 'superseded')
        .flatMap(node => node.stages.filter(stage => stage.completionRequested && !stage.completed).map(stage => stage.id)),
      eventStageIds: next.events.filter(node => node.status !== 'superseded')
        .flatMap(node => node.stages.filter(stage => stage.completionRequested && !stage.completed).map(stage => stage.id)),
    };
    return next;
  }

  function applyReportToState(state, snapshot, report, settlement) {
    const next = clone(state);
    const rewriteKind = report.rewrite?.needed ? report.rewrite.targetKind : null;
    const fields = [
      ['fine', 'fine'],
      ['event', 'event'],
      ['volume', 'volume'],
    ];
    for (const [layer, snapshotKey] of fields) {
      if (!report.completion?.[layer] || rewriteKind === layer) continue;
      const found = findStage(next, snapshot?.[snapshotKey]?.stageId);
      if (!found || found.node.kind !== layer || found.node.id !== snapshot?.[snapshotKey]?.id
        || found.node.revision !== snapshot?.[snapshotKey]?.revision) continue;
      found.stage.completionRequested = true;
      found.stage.completionSource = 'reply';
      if (layer === 'fine') found.stage.completed = true;
    }
    const settled = settleCompletions(next);
    if (report.rewrite?.needed) {
      settled.pendingRewrite = {
        target: report.rewrite.target,
        targetKind: report.rewrite.targetKind,
        description: report.rewrite.description,
        sourceReplyId: settlement.replyId,
        sourceReplyFingerprint: settlement.replyFingerprint,
        planRevision: snapshot?.planRevision ?? settled.planRevision,
        targetNodeId: snapshot?.[rewriteKind]?.id ?? null,
        targetStageId: snapshot?.[rewriteKind]?.stageId ?? null,
        targetRevision: snapshot?.[rewriteKind]?.revision ?? null,
      };
    }
    settled.settlements = [...(settled.settlements ?? []), {
      replyId: settlement.replyId,
      replyFingerprint: settlement.replyFingerprint ?? null,
      inputId: settlement.inputId ?? null,
      inputFingerprint: settlement.inputFingerprint ?? null,
      snapshot: clone(snapshot),
      report: clone(report),
    }];
    settled.updatedAt = new Date().toISOString();
    return settled;
  }

  function snapshotIsCurrent(state, snapshot) {
    if (!snapshot?.volume?.id || !snapshot?.event?.id || !snapshot?.fine?.id) return false;
    const volume = (state.volumes ?? []).find(node => node.id === snapshot.volume.id);
    const event = (state.events ?? []).find(node => node.id === snapshot.event.id);
    const fine = (state.fines ?? []).find(node => node.id === snapshot.fine.id);
    return Boolean(volume && event && fine
      && volume.revision === snapshot.volume.revision && event.revision === snapshot.event.revision
      && fine.revision === snapshot.fine.revision
      && volume.stages?.some(stage => stage.id === snapshot.volume.stageId && stage.index === snapshot.volume.stageIndex)
      && event.stages?.some(stage => stage.id === snapshot.event.stageId && stage.index === snapshot.event.stageIndex)
      && fine.stages?.some(stage => stage.id === snapshot.fine.stageId && stage.index === snapshot.fine.stageIndex)
      && volume.parentId === state.overall?.id && volume.parentRevision === state.overall?.revision
      && event.parentId === volume.id && event.parentRevision === volume.revision
      && event.parentStageId === snapshot.volume.stageId
      && fine.parentId === event.id && fine.parentRevision === event.revision
      && fine.parentStageId === snapshot.event.stageId);
  }

  function snapshotIsActive(state, snapshot) {
    const active = getActivePlanSnapshot(state);
    return Boolean(active && active.volume?.stageId === snapshot?.volume?.stageId
      && active.event?.stageId === snapshot?.event?.stageId
      && active.fine?.stageId === snapshot?.fine?.stageId);
  }

  function settlePlannerUpdate(state, { snapshot, report, replyId, replyFingerprint = null, inputId = null, inputFingerprint = null } = {}) {
    if (!isRecord(state) || !isRecord(snapshot) || !isRecord(report) || typeof replyId !== 'string' || !replyId) {
      return fail('阶段回报缺少聊天状态、注入快照、解析结果或回复身份');
    }
    if (snapshot.chatId !== state.chatId) return fail('阶段回报属于其他聊天');
    if ((state.settlements ?? []).some(item => item.replyId === replyId && item.replyFingerprint === replyFingerprint)) {
      return { ok: true, state, duplicate: true };
    }
    const withoutPreviousSwipe = (state.settlements ?? []).some(item => item.replyId === replyId)
      ? reconcileSettlements(state, (state.settlements ?? []).filter(item => item.replyId !== replyId)
        .map(item => ({ replyId: item.replyId, replyFingerprint: item.replyFingerprint,
          inputId: item.inputId, inputFingerprint: item.inputFingerprint }))).state
      : state;
    if (!snapshotIsCurrent(withoutPreviousSwipe, snapshot)) return fail('阶段回报对应的活动提纲版本已失效');
    if (!snapshotIsActive(withoutPreviousSwipe, snapshot)) return fail('阶段回报对应的活动阶段已变化');
    if (report.rewrite?.needed && !snapshot[report.rewrite.targetKind]?.id) return fail('重写目标不在本轮注入快照中');
    const settled = applyReportToState(withoutPreviousSwipe, snapshot, report, { replyId, replyFingerprint, inputId, inputFingerprint });
    return { ok: true, state: settled, duplicate: false };
  }

  function resetProgress(state) {
    const next = clone(state);
    for (const collection of ['volumes', 'events', 'fines']) {
      for (const node of next[collection] ?? []) {
        if (node.status === 'superseded') continue;
        for (const stage of node.stages ?? []) {
          if (stage.completionSource === 'preserved') continue;
          stage.completionRequested = false;
          stage.completed = false;
          stage.completionSource = null;
        }
      }
    }
    next.pendingAdvance = { volumeStageIds: [], eventStageIds: [] };
    next.pendingRewrite = null;
    next.settlements = [];
    return next;
  }

  function reconcileSettlements(state, selectedReplies) {
    const selected = new Map((selectedReplies ?? []).filter(isRecord).map(item => [String(item.replyId), item]));
    const history = state?.settlements ?? [];
    const candidates = history.flatMap(item => {
      const selectedReply = selected.get(String(item.replyId));
      if (!selectedReply) return [];
      if (item.inputId != null && (String(selectedReply.inputId ?? '') !== String(item.inputId)
        || (item.inputFingerprint && selectedReply.inputFingerprint !== item.inputFingerprint))) return [];
      const fingerprint = selectedReply.replyFingerprint ?? null;
      if (fingerprint == null || fingerprint === item.replyFingerprint) return [item];
      const parsed = parsePlannerUpdate(selectedReply.rawText);
      return parsed.ok ? [{ ...item, replyFingerprint: fingerprint, report: parsed.report }] : [];
    }).sort((left, right) => Number(left.replyId) - Number(right.replyId));
    const unchanged = candidates.length === history.length && candidates.every((item, index) =>
      item === history[index] || (item.replyId === history[index]?.replyId
        && item.replyFingerprint === history[index]?.replyFingerprint && item.report === history[index]?.report));
    if (unchanged) return { ok: true, state, changed: false };
    let next = resetProgress(state);
    const replayed = [];
    for (const entry of candidates) {
      if (!snapshotIsCurrent(next, entry.snapshot) || !snapshotIsActive(next, entry.snapshot)) continue;
      next = applyReportToState(next, entry.snapshot, entry.report, {
        replyId: entry.replyId, replyFingerprint: entry.replyFingerprint, inputId: entry.inputId,
        inputFingerprint: entry.inputFingerprint,
      });
      replayed.push(entry);
    }
    next.settlements = replayed;
    next.updatedAt = new Date().toISOString();
    return { ok: true, state: next, changed: true };
  }

  function appendRewriteResult(state, { targetKind, targetNodeId, parsed } = {}) {
    if (!state?.pendingRewrite || state.pendingRewrite.targetKind !== targetKind || !parsed?.ok) return fail('没有匹配的待重写提纲');
    targetNodeId ??= state.pendingRewrite.targetNodeId;
    if (targetNodeId !== state.pendingRewrite.targetNodeId) return fail('待重写提纲身份已变化');
    const target = [state.overall, ...state.volumes, ...state.events, ...state.fines].find(node => node?.id === targetNodeId);
    if (!target || target.status === 'superseded' || target.kind !== targetKind
      || target.revision !== state.pendingRewrite.targetRevision) return fail('待重写提纲版本已变化');
    const result = parsed.value.blocks?.[0];
    if (!result || result.kind !== targetKind) return fail('重写结果层级与目标不一致');
    const revision = (state.planRevision ?? 0) + 1;
    const replacement = { ...target, revision, fullTag: result.fullTag, body: result.body, updatedAt: new Date().toISOString() };
    if (result.stages) {
      const previousStages = new Map((target.stages ?? []).map(stage => [stage.index, stage]));
      const lastCompleted = Math.max(-1, ...(target.stages ?? []).filter(stage => stage.completed).map(stage => stage.index));
      if (result.stages.length <= lastCompleted) return fail('重写结果必须保留所有已完成阶段');
      replacement.stages = makeStages(target.id, revision, result.stages).map(stage => {
        const previous = previousStages.get(stage.index);
        if (!previous) return stage;
        if (previous.completed) return { ...stage, title: previous.title, content: previous.content,
          completionRequested: true, completed: true, completionSource: 'preserved', preservedFromStageId: previous.id };
        return stage;
      });
    }
    const next = clone(state);
    next.revisionHistory = [...(next.revisionHistory ?? []), {
      nodeId: target.id, kind: targetKind, revision: target.revision, fullTag: target.fullTag,
      body: target.body, stages: clone(target.stages ?? []), archivedAt: new Date().toISOString(),
    }];
    if (targetKind === 'overall') next.overall = replacement;
    else {
      const collection = targetKind === 'volume' ? 'volumes' : targetKind === 'event' ? 'events' : 'fines';
      next[collection] = next[collection].map(node => node.id === targetNodeId ? replacement : node);
    }
    if (targetKind === 'volume' || targetKind === 'overall') {
      const staleVolumes = targetKind === 'overall'
        ? next.volumes.filter(node => node.parentId === target.id && node.parentRevision === target.revision)
        : [];
      const staleVolumeIds = new Set(staleVolumes.map(node => node.id));
      const staleEvents = next.events.filter(node => (targetKind === 'volume'
        ? node.parentId === target.id && node.parentRevision === target.revision
        : staleVolumeIds.has(node.parentId)));
      const staleEventIds = new Set(staleEvents.map(node => node.id));
      next.volumes = next.volumes.map(node => staleVolumeIds.has(node.id) ? { ...node, status: 'superseded' } : node);
      next.events = next.events.map(node => staleEventIds.has(node.id) ? { ...node, status: 'superseded' } : node);
      next.fines = next.fines.map(node => staleEventIds.has(node.parentId) ? { ...node, status: 'superseded' } : node);
    } else if (targetKind === 'event') {
      const staleFineIds = new Set(next.fines.filter(node => node.parentId === target.id
        && node.parentRevision === target.revision).map(node => node.id));
      next.fines = next.fines.map(node => staleFineIds.has(node.id) ? { ...node, status: 'superseded' } : node);
    }
    next.planRevision = revision;
    next.pendingRewrite = null;
    next.updatedAt = new Date().toISOString();
    const settled = settleCompletions(next);
    settled.updatedAt = next.updatedAt;
    return { ok: true, state: settled, replacement };
  }

  return {
    TAG_TO_KIND,
    KIND_TO_TAG,
    REPORT_PATHS,
    REWRITE_TARGETS,
    extractTaggedBlocks,
    parseOutlineBlock,
    parsePlannerOutput,
    parsePlannerUpdate,
    createVariablePlannerState,
    applyInitialPlan,
    appendOutlineBatch,
    getActivePlanSnapshot,
    getPlanningNeed,
    settlePlannerUpdate,
    reconcileSettlements,
    appendRewriteResult,
  };
});
