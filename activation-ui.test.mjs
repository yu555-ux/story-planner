import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const engine = require('./planner.js');
const adapter = require('./runtime-adapter.js');

class Element {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.children = []; this.dataset = {};
    this.attributes = {}; this.listeners = new Map(); this.textContent = ''; this.open = false;
  }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  dispatch(name) { return this.listeners.get(name)?.({ target: this, preventDefault() {} }); }
  click() { return this.dispatch('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
  querySelector(selector) {
    const match = selector.match(/^\[data-tw-(action|field)="([^"]+)"\]$/);
    if (!match) return null;
    const key = match[1] === 'action' ? 'twAction' : 'twField';
    const queue = [...this.children];
    while (queue.length) {
      const item = queue.shift();
      if (item.dataset[key] === match[2]) return item;
      queue.push(...item.children);
    }
    return null;
  }
}

function panelFixture(planningState = {}) {
  const document = { createElement: tag => new Element(tag, document), body: null };
  document.body = new Element('body', document);
  const presetState = engine.normalizePlannerPresetState({});
  const panel = engine.createPlannerPanel({ document,
    getViewModel: () => ({ ...engine.buildPanelViewModel({ enabled: true }, planningState),
      chatLabel: '测试聊天', variablePlannerRunning: false }),
    getPresetState: () => presetState,
    setInterval: () => 1, clearInterval() {},
  });
  panel.open();
  const root = document.body.children[0];
  const nodes = [root];
  for (let index = 0; index < nodes.length; index += 1) nodes.push(...nodes[index].children);
  return { panel, root, nodes };
}

test('manifest and runtime adapter use the same release version', () => {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(adapter.VERSION, manifest.version);
});

test('result page shows four current layers and no legacy planning controls', () => {
  const { panel, root, nodes } = panelFixture();
  const headings = nodes.filter(node => node.tagName === 'h4').map(node => node.textContent);
  assert.deepEqual(headings.filter(label => ['总纲', '卷纲', '事件纲', '细纲'].includes(label)),
    ['总纲', '卷纲', '事件纲', '细纲']);
  assert.ok(root.querySelector('[data-tw-field="variablePlannerDraft"]'));
  assert.equal(root.querySelector('[data-tw-action="runUpperPlan"]'), null);
  assert.equal(root.querySelector('[data-tw-action="run"]'), null);
  assert.equal(root.querySelector('[data-tw-field="upperPremiseDraft"]'), null);
  panel.destroy();
});

test('current plan view model ignores legacy outline history', () => {
  const view = engine.buildPanelViewModel({ enabled: true }, {
    activeOutline: '<outline>旧细纲</outline>', outlineHistory: [{ body: '旧细纲', status: 'ready' }],
  });
  assert.equal(view.variablePlanner, null);
  assert.equal(view.variablePlannerNeed.kind, 'initial');
  assert.equal(Object.hasOwn(view, 'outlineHistory'), false);
});

test('current stage cards show named goals before the full raw tags', () => {
  const state = {
    chatId: 'chat-A', planRevision: 1,
    overall: { id: 'overall', revision: 1, body: '核心主题: 成长\n主角起点: 山村', fullTag: '<overall_outline>...</overall_outline>' },
    volumes: [{ id: 'volume', revision: 1, parentId: 'overall', parentRevision: 1,
      body: '卷名: 第一卷\n本卷目标: 入城', fullTag: '<volume_outline>...</volume_outline>',
      stages: [{ id: 'volume-stage', index: 0, title: '关键事件1', content: '找到信件', completed: false }] }],
    events: [{ id: 'event', revision: 1, parentId: 'volume', parentRevision: 1,
      parentStageId: 'volume-stage', body: '事件名: 信件\n事件目标: 拿到信件',
      fullTag: '<event_outline>...</event_outline>',
      stages: [{ id: 'event-stage', index: 0, title: '阶段1', content: '入宅', completed: false }] }],
    fines: [{ id: 'fine', revision: 1, parentId: 'event', parentRevision: 1,
      parentStageId: 'event-stage', body: '阶段1: 搜索', fullTag: '<fine_outline>...</fine_outline>',
      stages: [{ id: 'fine-stage', index: 0, title: '阶段1', content: '搜索书房', completed: false }] }],
  };
  const { panel, nodes } = panelFixture({ variablePlanner: state });
  const details = nodes.filter(node => node.tagName === 'dd').map(node => node.textContent);
  assert.deepEqual(details, ['成长', '山村', '第一卷', '入城', '信件', '拿到信件']);
  assert.ok(nodes.some(node => node.className === 'twsp-layer-content' && node.textContent === '搜索书房'));
  panel.destroy();
});
