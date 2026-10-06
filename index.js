import './runtime-adapter.js';
import './planner.js';
import './generation-gate.js';
import './startup.js';

const hostWindow = globalThis.window ?? globalThis;
const runtimeSlot = '__twStoryPlannerNativeRuntimeV1';
const startupSlot = '__twStoryPlannerStartupV1';
const interceptorName = 'twStoryPlannerInterceptorV1';
let runtime = null;
let host = null;
let generationGate = null;
let startup = null;

function teardownRuntime() {
  generationGate?.destroy();
  generationGate = null;
  runtime?.destroy();
  runtime = null;
  host?.destroy();
  host = null;
  if (hostWindow[interceptorName]) delete hostWindow[interceptorName];
}

function initialize() {
  const context = hostWindow.SillyTavern?.getContext?.();
  const engine = hostWindow.TWStoryPlannerEngineV1;
  const adapter = hostWindow.TWStoryPlannerNativeHost;
  const gateApi = hostWindow.TWStoryPlannerGenerationGate;
  if (!context || !engine || !adapter || !gateApi) return false;
  try {
    const capabilities = adapter.inspectHostCapabilities(context, { window: hostWindow });
    if (!capabilities.ok) throw new Error(`缺少宿主能力：${capabilities.missing.join(', ')}`);
    host = adapter.createNativeHost(context, { window: hostWindow, document: hostWindow.document });
    const savedSettings = host.getVariables({ type: 'script' });
    runtime = engine.createTavernRuntime(host, savedSettings.config);
    generationGate = gateApi.createGenerationGate(runtime, context, {
      notify: message => hostWindow.toastr?.error?.(message),
      logger: hostWindow.console,
    });
    hostWindow[interceptorName] = (...args) => generationGate?.interceptor(...args);
    hostWindow.console?.info?.('[剧情规划器][ready]', { surface: 'SillyTavern UI extension', version: adapter.VERSION });
    return true;
  } catch (error) {
    teardownRuntime();
    hostWindow.console?.error?.('[剧情规划器][startup:error]', error);
    hostWindow.toastr?.error?.('剧情规划器启动失败，请检查 SillyTavern 版本与扩展上下文。');
    return false;
  }
}

function teardown() {
  startup?.destroy();
  if (hostWindow[startupSlot] === startup) delete hostWindow[startupSlot];
  if (hostWindow[runtimeSlot]?.teardown === teardown) delete hostWindow[runtimeSlot];
  startup = null;
  teardownRuntime();
}

hostWindow[runtimeSlot]?.teardown?.();
const startupApi = hostWindow.TWStoryPlannerExtensionStartup;
if (!startupApi?.createStartupCoordinator) {
  hostWindow.console?.error?.('[剧情规划器][startup:error]', new Error('启动协调器未加载'));
} else {
  startup = startupApi.createStartupCoordinator({
    hostWindow,
    initialize,
    onError: error => {
      hostWindow.console?.error?.('[剧情规划器][startup:error]', error);
      hostWindow.toastr?.error?.('剧情规划器等待宿主就绪失败，请检查 TauriTavern 版本与扩展上下文。');
    },
  });
  hostWindow[startupSlot] = startup;
  hostWindow[runtimeSlot] = { teardown };
  void startup.start();
}

export function onDisable() {
  teardown();
}

export function onDelete() {
  teardown();
}
