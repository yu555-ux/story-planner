import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let createStartupCoordinator;
try {
  ({ createStartupCoordinator } = require('./startup.js'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('startup module exposes a coordinator for lifecycle-safe extension activation', () => {
  assert.equal(typeof createStartupCoordinator, 'function');
});

test('startup coordinator waits for Tauri host readiness before initializing', async t => {
  if (typeof createStartupCoordinator !== 'function') return t.skip('startup coordinator not implemented yet');
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const listeners = new Map();
  const context = { eventTypes: { APP_READY: 'app_ready' }, eventSource: {
    on(name, listener) { listeners.set(name, listener); },
    removeListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
  } };
  const hostWindow = { __TAURITAVERN__: { ready }, SillyTavern: { getContext: () => context } };
  let calls = 0;
  const startup = createStartupCoordinator({ hostWindow, initialize: () => { calls += 1; return true; } });
  const initial = startup.start();
  listeners.get('app_ready')?.();
  assert.equal(calls, 0);
  resolveReady();
  assert.equal(await initial, true);
  assert.equal(calls, 1);
  startup.destroy();
});

test('startup coordinator deduplicates readiness and repeated start signals', async t => {
  if (typeof createStartupCoordinator !== 'function') return t.skip('startup coordinator not implemented yet');
  const listeners = new Map();
  const context = { eventTypes: { APP_READY: 'app_ready' }, eventSource: {
    on(name, listener) { listeners.set(name, listener); },
    removeListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
  } };
  let calls = 0;
  const startup = createStartupCoordinator({
    hostWindow: { SillyTavern: { getContext: () => context } },
    initialize: () => { calls += 1; return true; },
  });
  await startup.start();
  await startup.start();
  listeners.get('app_ready')?.();
  assert.equal(calls, 1);
  startup.destroy();
});

test('startup coordinator retries once on APP_READY when native context arrives late', async t => {
  if (typeof createStartupCoordinator !== 'function') return t.skip('startup coordinator not implemented yet');
  const listeners = new Map();
  let runtimeAvailable = false;
  const context = { eventTypes: { APP_READY: 'app_ready' }, eventSource: {
    on(name, listener) { listeners.set(name, listener); },
    removeListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
  } };
  const hostWindow = { SillyTavern: { getContext: () => context } };
  const calls = [];
  const startup = createStartupCoordinator({
    hostWindow,
    initialize: () => { calls.push(runtimeAvailable); return runtimeAvailable; },
  });
  const initial = startup.start();
  assert.equal(await initial, false);
  runtimeAvailable = true;
  listeners.get('app_ready')?.();
  assert.deepEqual(calls, [false, true]);
  assert.equal(startup.initialized, true);
  startup.destroy();
});

test('startup coordinator cleans readiness listeners and ignores late resolution after disable', async t => {
  if (typeof createStartupCoordinator !== 'function') return t.skip('startup coordinator not implemented yet');
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const listeners = new Map();
  const context = { eventTypes: { APP_READY: 'app_ready' }, eventSource: {
    on(name, listener) { listeners.set(name, listener); },
    removeListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
  } };
  let calls = 0;
  const startup = createStartupCoordinator({
    hostWindow: { __TAURITAVERN__: { ready }, SillyTavern: { getContext: () => context } },
    initialize: () => { calls += 1; return true; },
  });
  const initial = startup.start();
  startup.destroy();
  resolveReady();
  assert.equal(await initial, false);
  assert.equal(calls, 0);
  assert.equal(listeners.size, 0);
});
