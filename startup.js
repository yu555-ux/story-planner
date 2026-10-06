(function attachPlannerStartup(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TWStoryPlannerExtensionStartup = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createStartupModule() {
  'use strict';

  function isPromise(value) {
    return value != null && typeof value.then === 'function';
  }

  function createStartupCoordinator({ hostWindow = globalThis.window ?? globalThis, initialize, onError = () => {} } = {}) {
    if (typeof initialize !== 'function') throw new TypeError('initialize 必须是函数');
    let started = false;
    let destroyed = false;
    let initialized = false;
    let attemptPromise = null;
    let hostReadyPromise = null;
    let hostReadySettled = false;
    const disposers = [];

    function context() {
      try { return hostWindow.SillyTavern?.getContext?.() ?? null; }
      catch { return null; }
    }

    function subscribeAppReady() {
      const current = context();
      const eventName = current?.eventTypes?.APP_READY ?? current?.event_types?.APP_READY;
      const source = current?.eventSource;
      if (typeof eventName !== 'string' || typeof source?.on !== 'function') return;
      const listener = () => { void attempt(); };
      source.on(eventName, listener);
      disposers.push(() => {
        if (typeof source.removeListener === 'function') source.removeListener(eventName, listener);
        else source.off?.(eventName, listener);
      });
    }

    function getHostReadyPromise() {
      const bridge = hostWindow.__TAURITAVERN__;
      const ready = bridge?.ready ?? hostWindow.__TAURITAVERN_MAIN_READY__;
      if (isPromise(ready)) return ready;
      if (bridge) throw new Error('TauriTavern Host Ready 能力不可用');
      return null;
    }

    function invokeInitialize() {
      if (destroyed || initialized) return initialized;
      try {
        const result = initialize();
        if (isPromise(result)) {
          attemptPromise = Promise.resolve(result).then(value => {
            initialized = value === true;
            return initialized;
          }).catch(error => {
            onError(error);
            return false;
          }).finally(() => { attemptPromise = null; });
          return attemptPromise;
        }
        initialized = result === true;
        return initialized;
      } catch (error) {
        onError(error);
        return false;
      }
    }

    function attempt() {
      if (destroyed || initialized) return initialized;
      if (attemptPromise) return attemptPromise;
      if (hostReadySettled) return invokeInitialize();
      if (!hostReadyPromise) {
        try { hostReadyPromise = getHostReadyPromise(); }
        catch (error) {
          hostReadySettled = true;
          onError(error);
          return false;
        }
        if (!hostReadyPromise) {
          hostReadySettled = true;
          return invokeInitialize();
        }
      }
      attemptPromise = Promise.resolve(hostReadyPromise).then(() => {
        if (destroyed) return false;
        hostReadySettled = true;
        return invokeInitialize();
      }).catch(error => {
        hostReadySettled = true;
        if (!destroyed) onError(error);
        return false;
      }).finally(() => { attemptPromise = null; });
      return attemptPromise;
    }

    return {
      start() {
        if (destroyed) return false;
        if (initialized) return true;
        if (!started) {
          started = true;
          subscribeAppReady();
        }
        return attempt();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        while (disposers.length) {
          try { disposers.pop()(); } catch { /* Continue releasing the other listeners. */ }
        }
      },
      get initialized() { return initialized; },
    };
  }

  return { createStartupCoordinator };
});
