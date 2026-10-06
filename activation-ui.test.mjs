import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const engine = require('./planner.js');
const adapter = require('./runtime-adapter.js');

test('release version matches manifest, adapter and settings badge', () => {
  const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.1.5');
  assert.equal(adapter.VERSION, manifest.version);
  const document = { createElement: tag => new Element(tag, document), body: null };
  document.body = new Element('body', document);
  const panel = engine.createPlannerPanel({
    document, version: adapter.VERSION,
    getViewModel: () => ({ config: { enabled: false }, status: 'disabled', configErrors: {} }),
    getPresetState: () => ({ plannerPresets: [engine.createDefaultPlannerPreset()], activePlannerPresetId: 'tw-planner-default' }),
    setInterval: () => 1, clearInterval() {},
  });
  const nodes = [...document.body.children];
  let title;
  let badge;
  while (nodes.length) { const node = nodes.shift(); if (node.className === 'twsp-title') title = node; if (node.className === 'twsp-version') badge = node; nodes.push(...node.children); }
  assert.equal(title?.textContent, '剧情规划器');
  assert.equal(badge?.textContent, `v${manifest.version}`);
  panel.destroy();
});

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
    const match = selector.match(/^\[data-tw-action="([^"]+)"\]$/);
    if (!match) return null;
    const queue = [...this.children];
    while (queue.length) {
      const item = queue.shift();
      if (item.dataset.twAction === match[1]) return item;
      queue.push(...item.children);
    }
    return null;
  }
}

test('prominent activation button persists immediately and logs each state', () => {
  const document = { createElement: tag => new Element(tag, document), body: null };
  document.body = new Element('body', document);
  let config = { enabled: false, apiurl: '', key: '', model: '' };
  const logs = [];
  const panel = engine.createPlannerPanel({
    document,
    getViewModel: () => ({ config, status: config.enabled ? 'idle' : 'disabled', statusLabel: config.enabled ? '等待规划' : '自动规划已关闭', configErrors: {}, presetReady: false }),
    getPresetState: () => ({ plannerPresets: [engine.createDefaultPlannerPreset()], activePlannerPresetId: 'tw-planner-default' }),
    saveConfig: draft => { config = { ...config, ...draft }; logs.push(config.enabled ? '已开启' : '已关闭'); return config; },
    setInterval: () => 1, clearInterval() {},
  });
  panel.open();
  const button = document.body.children[0].querySelector('[data-tw-action="toggleEnabled"]');
  assert.ok(button);
  assert.match(button.textContent, /开启/);
  button.dispatch('click');
  assert.equal(config.enabled, true);
  assert.equal(button.attributes['aria-pressed'], 'true');
  button.dispatch('click');
  assert.equal(config.enabled, false);
  const nodes = [...document.body.children];
  for (let i = 0; i < nodes.length; i++) nodes.push(...nodes[i].children);
  assert.equal(nodes.some(node => node.dataset.twField === 'settingsEnabled'), false);
  assert.deepEqual(logs, ['已开启', '已关闭']);
  panel.destroy();
});

test('result page renders ordered floor history as safe outline text and exposes retry setting', () => {
  const document = { createElement: tag => new Element(tag, document), body: null };
  document.body = new Element('body', document);
  const config = { enabled: true, apiurl: 'https://api.example/v1', model: 'model', retryCount: 3 };
  const history = [
    { id: 'a', sequence: 1, sourceMessageId: 1, usedMessageId: 2, status: 'used', purpose: 'initial', body: '<script>保留原文</script>' },
    { id: 'b', sequence: 2, sourceMessageId: 2, usedMessageId: null, status: 'ready', purpose: 'next', body: '下一轮内容' },
  ];
  const panel = engine.createPlannerPanel({
    document, getViewModel: () => ({ config, status: 'ready', statusLabel: '已完成', configErrors: {}, outlineHistory: history }),
    getPresetState: () => ({ plannerPresets: [engine.createDefaultPlannerPreset()], activePlannerPresetId: 'tw-planner-default' }),
    setInterval: () => 1, clearInterval() {},
  });
  panel.open();
  const queue = [...document.body.children];
  const nodes = [];
  while (queue.length) { const node = queue.shift(); nodes.push(node); queue.push(...node.children); }
  const list = nodes.find(node => node.dataset.twView === 'outlineHistory');
  assert.equal(list.children.length, 1);
  const summary = list.children[0].children[0];
  assert.match(summary.children[1].children[1].textContent, /来源 #1 → 用于 #2/);
  assert.equal(list.children[0].children.at(-1).textContent, '<script>保留原文</script>');
  const current = nodes.find(node => node.dataset.twView === 'outlineBody');
  assert.equal(current.children.at(-1).textContent, '下一轮内容');
  assert.match(current.children[0].children[1].textContent, /来源楼层 2/);
  assert.equal(nodes.find(node => node.dataset.twField === 'retryCount').value, '3');
  panel.destroy();
});

test('outline card gives event content priority and uses SVG icons for time and place', () => {
  const document = { createElement: tag => new Element(tag, document), createElementNS: (_, tag) => new Element(tag, document), body: null };
  document.body = new Element('body', document);
  const body = '时间: 雨夜\n地点: 林家旧宅\n事件内容: 林澈发现遗失的信件。';
  const panel = engine.createPlannerPanel({
    document,
    getViewModel: () => ({ config: { enabled: true }, status: 'ready', statusLabel: '已完成', configErrors: {},
      outlineHistory: [{ id: 'a', sequence: 1, status: 'ready', body }] }),
    getPresetState: () => ({ plannerPresets: [engine.createDefaultPlannerPreset()], activePlannerPresetId: 'tw-planner-default' }),
    setInterval: () => 1, clearInterval() {},
  });
  panel.open();
  const nodes = [...document.body.children];
  for (let i = 0; i < nodes.length; i++) nodes.push(...nodes[i].children);
  assert.equal(nodes.find(node => node.className === 'twsp-outline-event')?.textContent, '林澈发现遗失的信件。');
  assert.equal(nodes.filter(node => node.className === 'twsp-outline-meta-item').length, 2);
  assert.equal(nodes.filter(node => node.tagName === 'svg' && node.attributes['aria-hidden'] === 'true').length >= 2, true);
  const feature = nodes.find(node => node.dataset.twView === 'outlineBody');
  const rawDetails = feature.children[1].children.at(-1);
  rawDetails.open = true;
  panel.render(false);
  assert.equal(feature.children[1].children.at(-1), rawDetails);
  assert.equal(rawDetails.open, true);
  panel.destroy();
});

test('settings UI states whether the host confirmed the save', async () => {
  const document = { createElement: tag => new Element(tag, document), body: null };
  document.body = new Element('body', document);
  let config = { enabled: true, apiurl: 'https://api.example/v1', key: '', model: 'planner' };
  const confirmations = [{ confirmed: true }, { confirmed: false }];
  const panel = engine.createPlannerPanel({
    document,
    getViewModel: () => ({ config, status: 'idle', statusLabel: '等待规划', configErrors: {}, presetReady: false }),
    getPresetState: () => ({ plannerPresets: [engine.createDefaultPlannerPreset()], activePlannerPresetId: 'tw-planner-default' }),
    saveConfig: draft => { config = { ...config, ...draft }; return config; },
    persistConfig: async () => confirmations.shift(),
    setInterval: () => 1, clearInterval() {},
  });
  panel.open();
  const root = document.body.children[0];
  const save = root.querySelector('[data-tw-action="save"]');
  const nodes = [...root.children];
  let checkStatus;
  while (nodes.length) {
    const node = nodes.shift();
    if (node.dataset.twView === 'checkStatus') checkStatus = node;
    nodes.push(...node.children);
  }
  await save.dispatch('click');
  assert.match(checkStatus.textContent, /保存已确认/);
  await save.dispatch('click');
  assert.match(checkStatus.textContent, /尚无落盘确认/);
  panel.destroy();
});

test('preset cards keep selection, editing, enable and management controls available', () => {
  const document = { createElement: tag => new Element(tag, document), body: null };
  document.body = new Element('body', document);
  const preset = engine.createDefaultPlannerPreset();
  preset.prompts.push({ identifier: 'intro', name: '规划器身份', role: 'system', content: '剧情规则', enabled: true });
  preset.promptOrder.push({ identifier: 'intro', enabled: true });
  const panel = engine.createPlannerPanel({
    document,
    getViewModel: () => ({ config: { enabled: true }, status: 'idle', configErrors: {} }),
    getPresetState: () => ({ plannerPresets: [preset], activePlannerPresetId: preset.id }),
    setInterval: () => 1, clearInterval() {},
  });
  panel.open();
  const root = document.body.children[0];
  for (const action of ['newPreset', 'importPresetButton', `exportPreset-${preset.id}`, `editPreset-${preset.id}`, `deletePreset-${preset.id}`, 'addPrompt', 'checkPreset', 'previewPreset', 'copyCurrentPrompt', 'savePreset']) {
    assert.ok(root.querySelector(`[data-tw-action="${action}"]`), `${action} remains available`);
  }
  const title = root.querySelector('[data-tw-action="title-intro"]');
  const editor = root.querySelector('[data-tw-action="edit-intro"]');
  assert.ok(title && editor);
  title.dispatch('click');
  assert.equal(editor.attributes['aria-expanded'], 'true');
  assert.ok(root.querySelector('[data-tw-action="remove-intro"]'));
  const queue = [...root.children];
  for (let i = 0; i < queue.length; i++) queue.push(...queue[i].children);
  const enabled = queue.find(node => node.dataset.twField === 'promptEnabled-intro');
  const card = queue.find(node => node.dataset.twView === 'promptCard-intro');
  enabled.checked = false;
  enabled.dispatch('change');
  assert.equal(card.dataset.enabled, 'false');
  panel.destroy();
});

test('result page can retry a failed metadata save without requesting another outline', async () => {
  const document = { createElement: tag => new Element(tag, document), body: null };
  document.body = new Element('body', document);
  let persistenceError = '聊天保存失败';
  let retries = 0;
  let plannerCalls = 0;
  const panel = engine.createPlannerPanel({
    document,
    getViewModel: () => ({ config: { enabled: true, apiurl: 'https://api.example/v1', model: 'planner' },
      status: 'ready', statusLabel: '已完成', configErrors: {}, persistenceError, outlineHistory: [] }),
    getPresetState: () => ({ plannerPresets: [engine.createDefaultPlannerPreset()], activePlannerPresetId: 'tw-planner-default' }),
    retryPersist: async () => { retries += 1; persistenceError = ''; return true; },
    runNow: () => { plannerCalls += 1; },
    setInterval: () => 1, clearInterval() {},
  });
  panel.open();
  const root = document.body.children[0];
  const retry = root.querySelector('[data-tw-action="retrySave"]');
  assert.ok(retry);
  assert.equal(retry.hidden, false);
  await retry.dispatch('click');
  assert.equal(retries, 1);
  assert.equal(plannerCalls, 0);
  assert.equal(retry.hidden, true);
  panel.destroy();
});
