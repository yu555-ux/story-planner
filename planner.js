(function initStoryPlannerModule(root, factory) {
  const api = factory();
  const isCommonJs = typeof module === 'object' && module.exports;
  if (isCommonJs) module.exports = api;
  else root.TWStoryPlannerEngineV1 = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function createStoryPlannerModule() {
  'use strict';

  const EXTENSION_ID = 'tw-story-planner-v1';
  const BUTTON_NAME = '剧情规划器';
  const STATE_KEY = '__tw_story_planner_v1';
  const DEFAULT_LIMITS = Object.freeze({ maxTextLength: 240 });
  const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    apiurl: '',
    key: '',
    model: '',
    timeoutSeconds: 100,
    retryCount: 2,
    maxTokens: 1200,
    temperature: 0.3,
    debounceMs: 800,
    historyLimit: 12,
  });
  const DEFAULT_PRESET_ID = 'tw-planner-default';
  const MAX_PRESET_PROMPT_LENGTH = 250_000;
  const MAX_PRESET_JSON_LENGTH = 1_000_000;
  const LEGACY_DEFAULT_FINGERPRINT = { length: 1654, hash: '0ce4fd1b' };
  const MARKERS = new Set(['personaDescription', 'charDescription', 'charPersonality', 'scenario', 'dialogueExamples', 'chatHistory', 'worldInfoBefore', 'worldInfoAfter']);
  function createDefaultPlannerPreset() {
    return { id: DEFAULT_PRESET_ID, name: '默认预设', prompts: [], promptOrder: [], raw: {} };
  }
  function selectPromptOrder(groups) {
    const valid = (Array.isArray(groups) ? groups : []).map((group, index) => ({
      group: isRecord(group) && Array.isArray(group.order)
        ? { ...group, order: group.order.filter(item => isRecord(item) && typeof item.identifier === 'string') }
        : null,
      index,
    })).filter(({ group }) => group?.order.length);
    return valid.find(({ group }) => Number(group.character_id) === 100000)
      ?? valid.find(({ group }) => Number(group.character_id) === 100001)
      ?? valid[0] ?? null;
  }
  function importPlannerPreset(input, fileName = '导入预设.json') {
    const raw = typeof input === 'string' ? JSON.parse(input) : input;
    if (!isRecord(raw) || (raw.prompts !== undefined && !Array.isArray(raw.prompts)) || (raw.prompts?.length ?? 0) > 250 || JSON.stringify(raw).length > MAX_PRESET_JSON_LENGTH) throw new Error('预设格式或体积不符合要求');
    const prompts = (raw.prompts ?? []).map((item, index) => {
      if (!isRecord(item)) throw new Error(`第 ${index + 1} 个 Prompt 格式不正确`);
      const identifier = typeof item.identifier === 'string' && item.identifier.trim() ? item.identifier : `prompt-${index + 1}`;
      const content = typeof item.content === 'string' ? item.content : '';
      if (content.length > MAX_PRESET_PROMPT_LENGTH) throw new Error(`Prompt 正文过长：${identifier}`);
      return { ...item, identifier,
        name: typeof item.name === 'string' ? item.name : identifier,
        role: ['system', 'user', 'assistant'].includes(item.role) ? item.role : 'system',
        content, enabled: item.enabled !== false,
        injection_position: item.injection_position === 1 || item.injection_position === 'in_chat' ? 1 : 0,
        injection_depth: typeof item.injection_depth === 'number' ? item.injection_depth : 4,
        injection_order: typeof item.injection_order === 'number' ? item.injection_order : 100,
        injection_trigger: Array.isArray(item.injection_trigger) ? item.injection_trigger.filter(value => typeof value === 'string') : [],
      };
    });
    const ids = new Set(prompts.map(item => item.identifier));
    if (ids.size !== prompts.length) throw new Error('预设包含重复的 identifier');
    const selected = selectPromptOrder(raw.prompt_order);
    const promptOrder = selected ? selected.group.order.filter(item => ids.has(item.identifier)).map(item => ({ identifier: item.identifier, enabled: item.enabled !== false }))
      : prompts.map(item => ({ identifier: item.identifier, enabled: item.enabled !== false }));
    if (new Set(promptOrder.map(item => item.identifier)).size !== promptOrder.length) throw new Error('prompt_order 包含重复的 identifier');
    const enabledByOrder = new Map(promptOrder.map(item => [item.identifier, item.enabled]));
    for (const prompt of prompts) if (enabledByOrder.has(prompt.identifier)) prompt.enabled = enabledByOrder.get(prompt.identifier);
    const name = [raw.preset, raw.name, raw.preset_name, raw.presetName, raw.title].find(item => typeof item === 'string' && item.trim()) ?? fileName.replace(/\.json$/i, '');
    return { id: `preset-${fnv1a(`${Date.now()}-${Math.random()}-${name}`)}`, name, prompts, promptOrder, raw: { ...raw }, selectedGroupIndex: selected?.index ?? null };
  }
  function exportPlannerPreset(preset) {
    const raw = isRecord(preset.raw) ? { ...preset.raw } : {};
    const groups = Array.isArray(raw.prompt_order) ? raw.prompt_order.map(group => ({ ...group })) : [];
    const order = preset.promptOrder.map(item => ({ identifier: item.identifier, enabled: item.enabled !== false }));
    if (Number.isInteger(preset.selectedGroupIndex) && groups[preset.selectedGroupIndex]) groups[preset.selectedGroupIndex] = { ...groups[preset.selectedGroupIndex], order };
    else groups.push({ character_id: 100000, order });
    return { ...raw, name: preset.name, prompts: preset.prompts.map(item => ({ ...item })), prompt_order: groups };
  }
  function getOrderedPlannerPrompts(preset) {
    const byId = new Map((preset?.prompts ?? []).map(prompt => [prompt.identifier, prompt]));
    return (preset?.promptOrder ?? []).flatMap((order, index) => {
      const prompt = byId.get(order.identifier);
      return prompt && order.enabled !== false && prompt.enabled !== false ? [{ prompt, order: index }] : [];
    });
  }
  function getTriggeredPlannerPrompts(preset, generationType = 'normal') {
    return getOrderedPlannerPrompts(preset).filter(({ prompt }) =>
      !Array.isArray(prompt.injection_trigger)
      || prompt.injection_trigger.length === 0
      || prompt.injection_trigger.includes(generationType));
  }
  function identifySPresetSendTransform(config) {
    const chatSquash = config?.ChatSquash;
    if (chatSquash?.squashed_post_script_enable !== true) return { supported: false, kind: null, reason: 'disabled' };
    if (chatSquash.enabled !== false) return { supported: false, kind: null, reason: 'unverified-combination' };
    const script = chatSquash.squashed_post_script;
    if (typeof script === 'string' && script.length === 11128 && fnv1a(script) === 'f8e05dc4') {
      return { supported: true, kind: 'reborn-2.3', enabledBy: 'ChatSquash.squashed_post_script_enable' };
    }
    return { supported: false, kind: null, reason: 'unknown-script', enabledBy: 'ChatSquash.squashed_post_script_enable' };
  }
  function getSPresetSettings(preset) {
    const prompt = preset?.prompts?.find(item => item?.identifier === 'SPresetSettings');
    if (!prompt) return { present: false, config: null, rules: [], diagnostics: [], summary: '' };
    let config;
    try { config = JSON.parse(prompt.content); }
    catch { return { present: true, config: null, rules: [], diagnostics: ['SPresetSettings 不是有效 JSON；原始内容已保留'], summary: 'SPresetSettings 配置无法解析，原文已保留' }; }
    if (!isRecord(config)) return { present: true, config: null, rules: [], diagnostics: ['SPresetSettings 顶层不是对象；原始内容已保留'], summary: 'SPresetSettings 格式无法识别，原文已保留' };
    const diagnostics = [];
    const sendTransform = identifySPresetSendTransform(config);
    if (sendTransform.reason === 'unknown-script') diagnostics.push('SPreset 发送前脚本已启用，但版本未经验证；原文保留，规划器未执行');
    if (sendTransform.reason === 'unverified-combination') diagnostics.push('SPreset 聊天合并与发送前脚本的组合未验证；规划器未执行该组合');
    if (sendTransform.supported) diagnostics.push('SPreset Reborn 2.3 发送前脚本已适配；目标酒馆运行阶段仍待实机核验');
    const storedRules = config.RegexBinding?.regexes;
    const rules = [];
    if (storedRules !== undefined && !Array.isArray(storedRules)) diagnostics.push('RegexBinding.regexes 不是数组');
    for (const rule of Array.isArray(storedRules) ? storedRules : []) {
      if (!isRecord(rule) || rule.disabled === true || rule.promptOnly !== true || !Array.isArray(rule.placement) || !rule.placement.some(value => value === 1 || value === 2)) continue;
      if (Number(rule.substituteRegex ?? 0) !== 0) { diagnostics.push(`正则「${rule.scriptName ?? '未命名'}」使用动态宏替换，未应用`); continue; }
      if (typeof rule.findRegex !== 'string' || typeof rule.replaceString !== 'string') { diagnostics.push(`正则「${rule.scriptName ?? '未命名'}」字段不完整，未应用`); continue; }
      const trimStrings = Array.isArray(rule.trimStrings) ? rule.trimStrings.filter(item => typeof item === 'string') : [];
      if (/\{\{(?!match\}\})[^}]+\}\}/i.test(rule.replaceString) || trimStrings.some(item => /\{\{[^}]+\}\}/.test(item))) {
        diagnostics.push(`正则「${rule.scriptName ?? '未命名'}」包含未解析宏，未应用`); continue;
      }
      const expression = parseSillyTavernRegex(rule.findRegex);
      if (!expression) { diagnostics.push(`正则「${rule.scriptName ?? '未命名'}」格式无效，未应用`); continue; }
      rules.push({ ...rule, expression });
    }
    const enabledModules = [];
    if (config.ChatSquash?.enabled === true) enabledModules.push('ChatSquash');
    if (config.MacroNest === true || config.MacroNest?.enabled === true) enabledModules.push('MacroNest');
    const outputScript = config.OutputPreprocessing?.script;
    const knownOutputScript = config.OutputPreprocessing?.enabled === true
      && typeof outputScript === 'string' && outputScript.length === 890 && fnv1a(outputScript) === 'e60758cf';
    if (knownOutputScript) diagnostics.push('SPreset Reborn 输出前缀清理已适配；consumeToolCalls 的运行阶段仍待实机核验');
    else if (config.OutputPreprocessing?.enabled === true) enabledModules.push('OutputPreprocessing');
    const enabledTools = Object.entries(isRecord(config.ToolBindings) ? config.ToolBindings : {}).filter(([, value]) => value?.enabled === true);
    const activeIds = new Set(getTriggeredPlannerPrompts(preset).map(({ prompt: activePrompt }) => activePrompt.identifier));
    const gameContentBinding = enabledTools.find(([identifier, value]) =>
      activeIds.has(identifier) && value.valid === true
      && (value.resolvedName ?? value.form?.name) === 'game_content'
      && value.form?.name === 'game_content'
      && Array.isArray(value.form.parameters)
      && value.form.parameters.some(parameter => parameter?.name === 'content' && parameter.type === 'string' && parameter.required === true));
    const gameContentTool = gameContentBinding ? {
      type: 'function', function: {
        name: 'game_content',
        description: typeof gameContentBinding[1].form.description === 'string' && gameContentBinding[1].form.description.trim()
          ? gameContentBinding[1].form.description : '将全部输出放入 content 参数。',
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      },
    } : null;
    const unsupportedTools = enabledTools.filter(([identifier]) => identifier !== gameContentBinding?.[0]);
    if (unsupportedTools.length) enabledModules.push('ToolBindings');
    if (config.ForcedPostProcessing?.enabled === true) enabledModules.push('ForcedPostProcessing');
    if (enabledModules.length) diagnostics.push(`SPreset 模块已保留但未执行：${enabledModules.join('、')}`);
    const toolNames = unsupportedTools.map(([, value]) => value.resolvedName ?? value.form?.name).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 80));
    if (toolNames.length) diagnostics.push(`SPreset 工具未注册到规划器：${[...new Set(toolNames)].slice(0, 20).join('、')}；若预设要求调用这些工具，需核对实际生成结果`);
    if (gameContentTool) diagnostics.push('SPreset 工具 game_content 将随规划请求发送；实际调用仍需模型返回验证');
    const allEnabledRegexes = Array.isArray(storedRules) ? storedRules.filter(rule => isRecord(rule) && rule.disabled !== true) : [];
    const promptOnlyCount = rules.length;
    const nonPromptOnlyCount = allEnabledRegexes.filter(rule => rule.promptOnly !== true).length;
    if (nonPromptOnlyCount) diagnostics.push(`另有 ${nonPromptOnlyCount} 条未标记 promptOnly 的正则，规划器未应用`);
    const ruleNames = rules.map(rule => rule.scriptName || '未命名').join('、');
    return {
      present: true, config, rules, diagnostics, gameContentTool, sendTransform, knownOutputScript,
      summary: `SPreset 配置：${allEnabledRegexes.length} 条启用正则，${promptOnlyCount} 条可用于规划请求${ruleNames ? `（${ruleNames}）` : ''}；${sendTransform.supported ? 'Reborn 发送前脚本已适配；' : ''}${enabledModules.length ? `保留但未执行：${enabledModules.join('、')}` : '未发现其他启用脚本模块'}`,
    };
  }
  function classifySPresetCompatibility(preset) {
    const settings = getSPresetSettings(preset);
    return {
      sendTransform: settings.sendTransform ?? { supported: false, kind: null, reason: 'absent' },
      toolBinding: { supported: Boolean(settings.gameContentTool), tool: settings.gameContentTool ?? null },
      responseTransform: settings.knownOutputScript
        ? { supported: true, kind: 'reborn-2.3-raw-prefix', consumeToolCallsVerified: false }
        : { supported: false, reason: settings.config?.OutputPreprocessing?.enabled === true ? 'unknown-script' : 'disabled' },
      conditionalMergeTag: settings.config?.ChatSquash?.conditional_enabled === true
        && typeof settings.config.ChatSquash.conditional_tag === 'string'
        ? settings.config.ChatSquash.conditional_tag : null,
      diagnostics: settings.diagnostics,
    };
  }
  function applySupportedSPresetSendTransform(inputMessages, compatibility) {
    const messages = structuredClone(inputMessages);
    const diagnostics = [];
    if (compatibility?.sendTransform?.kind !== 'reborn-2.3' || compatibility.sendTransform.supported !== true) {
      return { messages, diagnostics };
    }
    if (messages.some(message => message?.tool_calls || message?.tool_call_id || message?.signature)) {
      diagnostics.push('SPreset 发送变换遇到结构化工具或签名消息，已保留原消息并阻止本次转换');
      return { messages, diagnostics };
    }
    if (messages.some(message => typeof message?.content !== 'string')) {
      diagnostics.push('SPreset 发送变换遇到非文本消息，已保留原消息并阻止本次转换');
      return { messages, diagnostics };
    }
    const thinking = [];
    const cleaned = messages.map(message => ({ ...message, content: message.content.replace(/<prefill_thinking\b[^>]*>([\s\S]*?)<\/prefill_thinking>/gi, (_tag, value) => {
      thinking.push(value.trim());
      return '';
    }) }));
    let conversionStart = 0;
    cleaned.forEach((message, index) => { if (message.content.includes('<|no-convert|>')) conversionStart = index + 1; });
    const untouched = cleaned.slice(0, conversionStart).map(message => ({ ...message, content: message.content.replaceAll('<|no-convert|>', '') }));
    if (conversionStart === cleaned.length) return { messages: untouched, diagnostics };
    const source = cleaned.slice(conversionStart);
    const cleanContent = content => String(content ?? '').replace(/\|用户：(.*?)\|/, '');
    const expanded = [];
    for (const message of source) {
      const content = cleanContent(message.content);
      const marker = /\|(用户|小猫之神)\|/g;
      let currentRole = null;
      let cursor = 0;
      let found = false;
      let match;
      while ((match = marker.exec(content)) !== null) {
        const segment = content.slice(cursor, match.index).trim();
        if (segment) expanded.push(currentRole ? { role: currentRole, content: segment } : { ...message, content: segment });
        currentRole = match[1] === '用户' ? 'user' : 'assistant';
        cursor = marker.lastIndex;
        found = true;
      }
      if (!found) expanded.push({ ...message, content });
      else {
        const tail = content.slice(cursor).trim();
        if (tail && currentRole) expanded.push({ role: currentRole, content: tail });
      }
    }
    const merged = [];
    for (const message of expanded) {
      const previous = merged.at(-1);
      if (previous && previous.role === message.role && previous.name === message.name) {
        previous.content = [previous.content, message.content].filter(Boolean).join('\n');
        for (const key of ['reasoning', 'reasoning_content']) {
          if (message[key] != null) previous[key] = [previous[key], message[key]].filter(value => value != null && value !== '').join('\n');
        }
      } else merged.push({ ...message });
    }
    const fake = (role, content) => `{"role":${JSON.stringify(String(role))},"content":"${cleanContent(content)}"}`;
    const modelOpen = '{"role":"model","content":"Pass';
    const soliumbraOpen = key => `{"role":"soliumbra","${key}":"`;
    const result = [];
    let historyStart = 0;
    if (conversionStart === 0) {
      const systems = [];
      while (historyStart < merged.length && merged[historyStart].role === 'system') systems.push(merged[historyStart++].content);
      result.push({ role: 'system', content: `<clear>\n[${fake('system', systems.filter(Boolean).join('\n'))},{"role":"fake_system","content":"` });
    }
    const history = merged.slice(historyStart);
    let pending = [];
    let openRole = 'fake_system';
    const appendModel = userMessage => {
      const fragments = [];
      let start = 0;
      const hadOpen = Boolean(openRole);
      if (hadOpen) {
        if (openRole === 'soliumbra' && pending[0]?.role === 'assistant') {
          fragments.push(`${cleanContent(pending[0].content)}"}`);
          start = 1;
        } else fragments.push('"}');
        openRole = null;
      }
      for (let index = start; index < pending.length; index += 1) {
        const message = pending[index];
        fragments.push(fake(message.role === 'assistant' ? 'soliumbra' : message.role || 'fake_system', message.content));
      }
      if (userMessage) fragments.push(fake('user', userMessage.content));
      if (fragments.length) {
        result.push({ role: 'assistant', content: fragments.map((fragment, index) => index === 0 && hadOpen ? fragment : `,${fragment}`).join('') + `,${modelOpen}` });
        openRole = 'model';
      }
      pending = [];
    };
    const appendGuide = () => { result.push({ role: 'user', content: `"},${soliumbraOpen('content')}` }); openRole = 'soliumbra'; };
    for (const message of history) {
      if (message.role !== 'user') pending.push(message);
      else { appendModel(message); appendGuide(); }
    }
    if (pending.length || history.length === 0) { appendModel(null); appendGuide(); }
    const last = result.at(-1);
    if (last?.role === 'user' && last.content.endsWith(soliumbraOpen('content'))) {
      last.content = last.content.slice(0, -soliumbraOpen('content').length) + soliumbraOpen('reasoning')
        + (thinking.length ? `${thinking.join('\n')}","content":"` : '');
    }
    return { messages: [...untouched, ...result], diagnostics };
  }
  function applySupportedSPresetResponseTransform(rawText, compatibility) {
    if (typeof rawText !== 'string' || compatibility?.responseTransform?.kind !== 'reborn-2.3-raw-prefix'
      || compatibility.responseTransform.supported !== true) return rawText;
    let result = rawText;
    while (/^\s*(?:finishReason|finishMessage):/i.test(result)) {
      const line = result.match(/^\s*(?:finishReason|finishMessage):[^\r\n]*(?:\r\n|\r|\n)/i);
      if (!line) return '';
      result = result.slice(line[0].length);
    }
    return result;
  }
  function parseSillyTavernRegex(value) {
    let pattern = value; let flags = '';
    if (value.startsWith('/')) {
      let end = -1;
      for (let index = value.length - 1; index > 0; index--) {
        if (value[index] !== '/') continue;
        let escapes = 0;
        for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) escapes++;
        if (escapes % 2 === 0) { end = index; break; }
      }
      if (end < 0) return null;
      pattern = value.slice(1, end); flags = value.slice(end + 1);
      if (!/^[dgimsuvy]*$/.test(flags)) return null;
    }
    try { return new RegExp(pattern, flags); }
    catch { return null; }
  }
  function applySPresetPromptRules(preset, messages) {
    const settings = getSPresetSettings(preset);
    const diagnostics = [...settings.diagnostics];
    if (!settings.rules.length) return { messages: messages.map(item => ({ ...item })), diagnostics };
    const result = messages.map((message, index) => {
      const placement = message.role === 'assistant' ? 2 : message.role === 'user' ? 1 : null;
      if (placement === null) return { ...message };
      let content = message.content;
      const depth = messages.length - index - 1;
      for (const rule of settings.rules) {
        if (!rule.placement.includes(placement)) continue;
        const minimum = rule.minDepth == null ? null : Number(rule.minDepth);
        const maximum = rule.maxDepth == null ? null : Number(rule.maxDepth);
        if (Number.isFinite(minimum) && minimum >= -1 && depth < minimum) continue;
        if (Number.isFinite(maximum) && maximum >= 0 && depth > maximum) continue;
        const expression = new RegExp(rule.expression.source, rule.expression.flags);
        const trims = Array.isArray(rule.trimStrings) ? rule.trimStrings.filter(item => typeof item === 'string') : [];
        const replacement = rule.replaceString.replace(/\{\{match\}\}/gi, '$0');
        content = content.replace(expression, (...args) => replacement.replace(/\$(\d+)|\$<([^>]+)>/g, (_token, groupIndex, groupName) => {
          const groups = args[args.length - 1];
          const matched = groupName ? groups?.[groupName] : args[Number(groupIndex)];
          if (typeof matched !== 'string') return '';
          return trims.reduce((value, trim) => value.replaceAll(trim, ''), matched);
        }));
      }
      return { ...message, content };
    });
    return { messages: result, diagnostics };
  }
  function hasEffectivePlannerPrompt(preset, generationType = 'normal') {
    return getTriggeredPlannerPrompts(preset, generationType).some(({ prompt }) =>
      (generationType !== 'initial' || !/\{\{last_maintext\}\}/i.test(String(prompt.content ?? ''))) && (
      prompt.marker === true && MARKERS.has(prompt.identifier)
      || typeof prompt.content === 'string' && Boolean(prompt.content.trim())));
  }
  function canonicalPresetJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalPresetJson).join(',')}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPresetJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }
  function normalizePlannerPresetState(raw) {
    const presets = Array.isArray(raw?.plannerPresets) ? raw.plannerPresets.filter(item => isRecord(item) && Array.isArray(item.prompts) && Array.isArray(item.promptOrder)) : [];
    const plannerPresets = presets.length ? presets.map(preset => {
      const serialized = preset.id === DEFAULT_PRESET_ID ? canonicalPresetJson(preset) : '';
      return serialized.length === LEGACY_DEFAULT_FINGERPRINT.length && fnv1a(serialized) === LEGACY_DEFAULT_FINGERPRINT.hash
        ? createDefaultPlannerPreset() : preset;
    }) : [createDefaultPlannerPreset()];
    return { plannerPresets, activePlannerPresetId: plannerPresets.some(item => item.id === raw?.activePlannerPresetId) ? raw.activePlannerPresetId : plannerPresets[0].id };
  }
  function validatePlannerPreset(preset) {
    const errors = [];
    if (!isRecord(preset) || !Array.isArray(preset.prompts) || !Array.isArray(preset.promptOrder)) return ['预设格式不正确'];
    if (preset.prompts.length > 250) errors.push('Prompt 数量超过 250');
    const ids = new Set();
    for (const prompt of preset.prompts) {
      if (!isRecord(prompt) || typeof prompt.identifier !== 'string' || !prompt.identifier || typeof prompt.content !== 'string') { errors.push('Prompt 格式不正确'); continue; }
      if (ids.has(prompt.identifier)) errors.push(`重复的 identifier：${prompt.identifier}`);
      ids.add(prompt.identifier);
      if (prompt.content.length > MAX_PRESET_PROMPT_LENGTH) errors.push(`Prompt 正文过长：${prompt.identifier}`);
    }
    const orderIds = new Set();
    for (const item of preset.promptOrder) {
      if (!isRecord(item) || typeof item.identifier !== 'string' || !ids.has(item.identifier)) errors.push(`prompt_order 引用无效：${item?.identifier ?? ''}`);
      else if (orderIds.has(item.identifier)) errors.push(`prompt_order 重复引用：${item.identifier}`);
      else orderIds.add(item.identifier);
    }
    if (JSON.stringify(exportPlannerPreset(preset)).length > MAX_PRESET_JSON_LENGTH) errors.push('预设总长度超过 1000000 字符');
    return errors;
  }
  async function readPlannerContext(globals, snapshot, generationType = 'normal') {
    const diagnostics = [];
    function macro(token) {
      if (typeof globals.substitudeMacros !== 'function') { diagnostics.push(`缺少 substitudeMacros：${token}`); return ''; }
      try {
        const result = globals.substitudeMacros(token);
        if (typeof result !== 'string' || !result.trim() || result.trim() === token) {
          if (token === '{{persona}}') diagnostics.push('当前 Persona 为空或宏没有解析；Persona 块不能注入真实设定');
          return '';
        }
        return result;
      } catch { diagnostics.push(`宏读取失败：${token}`); return ''; }
    }
    const personaDescription = macro('{{persona}}');
    const userName = macro('{{user}}');
    const characterName = macro('{{char}}');
    const characterPersonality = macro('{{personality}}');
    const scenario = macro('{{scenario}}');
    const dialogueExamples = macro('{{mesExamples}}');
    let characterDescription = '';
    if (typeof globals.getCharacter === 'function') {
      try { characterDescription = (await globals.getCharacter('current'))?.description ?? ''; }
      catch { diagnostics.push('当前角色资料读取失败'); }
    } else diagnostics.push('缺少 getCharacter，无法读取当前角色描述');
    const names = [];
    if (typeof globals.getGlobalWorldbookNames !== 'function') diagnostics.push('缺少全局世界书绑定接口 getGlobalWorldbookNames');
    else try { names.push(...globals.getGlobalWorldbookNames()); } catch { diagnostics.push('全局世界书名称读取失败'); }
    if (typeof globals.getCharWorldbookNames !== 'function') diagnostics.push('缺少角色世界书绑定接口 getCharWorldbookNames');
    else try {
      const bound = globals.getCharWorldbookNames('current');
      if (bound?.primary) names.push(bound.primary);
      if (Array.isArray(bound?.additional)) names.push(...bound.additional);
    } catch { diagnostics.push('角色世界书名称读取失败'); }
    if (typeof globals.getChatWorldbookName !== 'function') diagnostics.push('缺少聊天世界书绑定接口 getChatWorldbookName');
    else try { const chatBook = globals.getChatWorldbookName('current'); if (chatBook) names.push(chatBook); }
    catch { diagnostics.push('聊天世界书名称读取失败'); }
    const worldbooks = [];
    for (const name of [...new Set(names.filter(item => typeof item === 'string' && item.trim()))]) {
      if (typeof globals.getWorldbook !== 'function') { diagnostics.push(`缺少 getWorldbook，无法读取世界书：${name}`); break; }
      try {
        const entries = await globals.getWorldbook(name);
        if (!Array.isArray(entries)) diagnostics.push(`世界书格式错误：${name}`);
        else worldbooks.push({ name, entries });
      }
      catch { diagnostics.push(`世界书读取失败：${name}`); }
    }
    return { snapshot, generationType, personaDescription, userName, characterName, characterDescription, characterPersonality, scenario, dialogueExamples, worldbooks, diagnostics };
  }
  function stripPresetComments(content) {
    let result = '';
    let cursor = 0;
    while (true) {
      const start = content.indexOf('{{//', cursor);
      if (start < 0) return result + content.slice(cursor);
      result += content.slice(cursor, start);
      let depth = 1;
      let index = start + 4;
      while (index < content.length && depth > 0) {
        if (content.startsWith('{{', index)) { depth += 1; index += 2; }
        else if (content.startsWith('}}', index)) { depth -= 1; index += 2; }
        else index += 1;
      }
      if (depth > 0) return result + content.slice(start);
      cursor = index;
    }
  }
  function compilePlannerMessages(preset, context) {
    const diagnostics = [...(context.diagnostics ?? [])];
    const blocks = [];
    const ordered = getTriggeredPlannerPrompts(preset, context.generationType ?? 'normal')
      .filter(({ prompt }) => context.generationType !== 'initial' || !/\{\{last_maintext\}\}/i.test(String(prompt.content ?? '')));
    const macroState = new Map();
    const originalHistory = getStoryMessages(context.snapshot?.messages ?? []);
    const lastMaintext = extractLastAssistantTaggedBody(originalHistory);
    let missingLastMaintext = false;
    const processedHistory = applySPresetPromptRules(preset, originalHistory.map(item => {
      const { text: _text, message: _message, ...metadata } = item;
      void _text; void _message;
      return { ...metadata, content: getPlannerMessageContent(item) };
    }));
    const history = processedHistory.messages;
    diagnostics.push(...processedHistory.diagnostics);
    const scanText = history.slice(-3).map(getPlannerMessageContent).join('\n');
    const lanes = new Map();
    const outlet = new Map();
    const deferred = [];
    const unresolvedWorldbookIdentity = new Set();
    function keywordHit(value, haystack) {
      if (value instanceof RegExp) { value.lastIndex = 0; return value.test(haystack); }
      return typeof value === 'string' && haystack.toLowerCase().includes(value.toLowerCase());
    }
    for (const book of context.worldbooks ?? []) for (const entry of book.entries ?? []) {
      if (!entry?.enabled || !entry.content) continue;
      const label = `${book.name} / ${entry.name ?? entry.uid ?? '未命名'}`;
      // This planner performs one activation pass and never recursively scans injected entries.
      // Zero-valued effects and recursion guards cannot alter that first pass.
      const unsupported = entry.strategy?.type === 'vectorized'
        || (entry.effect && Object.values(entry.effect).some(value => value != null && Number(value) !== 0))
        || (entry.recursion?.delay_until != null && Number(entry.recursion.delay_until) > 0);
      if (unsupported) { diagnostics.push(`世界书 ${label} 的高级激活策略未覆盖，已跳过`); continue; }
      if (!['constant', 'selective'].includes(entry.strategy?.type)) { diagnostics.push(`世界书 ${label} 策略未知，已跳过`); continue; }
      if (entry.strategy.type === 'selective') {
        const depth = entry.strategy.scan_depth;
        const source = typeof depth === 'number' && depth > 0 ? history.slice(-depth).map(getPlannerMessageContent).join('\n') : scanText;
        const keys = entry.strategy.keys ?? [];
        if (!keys.some(key => keywordHit(key, source))) continue;
        const secondary = entry.strategy.keys_secondary;
        if (secondary?.keys?.length) {
          const hits = secondary.keys.map(key => keywordHit(key, source));
          const checks = { and_any: hits.some(Boolean), and_all: hits.every(Boolean), not_all: !hits.every(Boolean), not_any: !hits.some(Boolean) };
          if (!checks[secondary.logic]) continue;
        }
      }
      const probability = Number(entry.probability ?? 100);
      if (probability <= 0 || (probability < 100 && Math.random() * 100 >= probability)) continue;
      const position = entry.position?.type;
      if (!['before_character_definition', 'after_character_definition', 'before_example_messages', 'after_example_messages', 'at_depth', 'outlet'].includes(position)) {
        diagnostics.push(`世界书 ${label} 的位置 ${position ?? '未知'} 未覆盖，已跳过`); continue;
      }
      const worldbookContent = entry.content.replace(/\{\{(user|persona)\}\}/gi, (match, rawName) => {
        const name = rawName.toLowerCase();
        const value = name === 'user' ? context.userName : context.personaDescription;
        if (value) return value;
        if (!unresolvedWorldbookIdentity.has(name)) {
          diagnostics.push(`世界书${name === 'user' ? '用户名' : 'Persona'}宏未解析；已阻止本次转换`);
          unresolvedWorldbookIdentity.add(name);
        }
        return match;
      });
      const block = { role: position === 'at_depth' ? entry.position.role ?? 'system' : 'system', content: worldbookContent, source: 'worldbook', sourceName: label, depth: position === 'at_depth' ? Math.max(0, Number(entry.position.depth) || 0) : null, order: Number(entry.position?.order) || 0, region: position };
      if (position === 'outlet') {
        const name = entry.extra?.outlet_name;
        if (!name) { diagnostics.push(`世界书 ${label} 缺少 outlet_name，已跳过`); continue; }
        outlet.set(name, [...(outlet.get(name) ?? []), block]);
      } else lanes.set(position, [...(lanes.get(position) ?? []), block]);
    }
    function add(block) { if (typeof block?.content === 'string' && block.content.trim()) blocks.push(block); }
    function addLane(name) { for (const item of (lanes.get(name) ?? []).sort((a, b) => a.order - b.order)) add(item); }
    function markerValue(identifier) {
      return ({ personaDescription: context.personaDescription, charDescription: context.characterDescription, charPersonality: context.characterPersonality,
        scenario: context.scenario, dialogueExamples: context.dialogueExamples })[identifier] ?? '';
    }
    let historyPlaced = false;
    for (const { prompt, order } of ordered) {
      const id = prompt.identifier;
      if (prompt.marker === true && MARKERS.has(id)) {
        if (id === 'worldInfoBefore') addLane('before_character_definition');
        else if (id === 'worldInfoAfter') addLane('after_character_definition');
        else if (id === 'chatHistory') {
          for (const item of history) add({ role: item.role === 'assistant' ? 'assistant' : 'user', content: getPlannerMessageContent(item), source: 'history', sourceName: String(item.messageId ?? ''), region: 'chat-history', order });
          historyPlaced = true;
        } else {
          if (id === 'dialogueExamples') addLane('before_example_messages');
          add({ role: prompt.role ?? 'system', content: markerValue(id), source: 'marker', sourceName: id, region: 'before-history', order });
          if (id === 'dialogueExamples') addLane('after_example_messages');
        }
      } else {
        const content = stripPresetComments(prompt.content ?? '')
          .replace(/\{\{outlet::([^}]+)\}\}/g, (_, name) => (outlet.get(name.trim()) ?? []).map(item => item.content).join('\n\n'));
        const depth = Number(prompt.injection_depth ?? 0);
        const replacements = { user: context.userName, char: context.characterName, persona: context.personaDescription, description: context.characterDescription, personality: context.characterPersonality, scenario: context.scenario, mesExamples: context.dialogueExamples };
        const withoutTrim = content.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '');
        const withVariables = withoutTrim.replace(/\{\{(setvar|addvar|getvar)::([\s\S]*?)\}\}/gi, (_match, operation, rawArguments) => {
          const separator = rawArguments.indexOf('::');
          const name = (separator < 0 ? rawArguments : rawArguments.slice(0, separator)).trim();
          if (!name) return '';
          if (operation.toLowerCase() === 'getvar') return macroState.get(name) ?? '';
          const value = separator < 0 ? '' : rawArguments.slice(separator + 2);
          macroState.set(name, operation.toLowerCase() === 'addvar' ? `${macroState.get(name) ?? ''}${value}` : value);
          return '';
        });
        const rendered = withVariables.replace(/\{\{([^}]+)\}\}/g, (match, rawName) => {
          const name = rawName.trim();
          if (name.toLowerCase() === 'last_maintext') {
            if (lastMaintext) return lastMaintext;
            if (!missingLastMaintext) diagnostics.push('宏 {{last_maintext}} 未找到最新助手回复中完整且非空的 <maintext>/<content> 标签；已阻止本次转换');
            missingLastMaintext = true;
            return '';
          }
          if (Object.hasOwn(replacements, name)) return replacements[name] ?? '';
          diagnostics.push(`未识别的预设宏：${name}`); return match;
        });
        const block = { role: ['system', 'assistant', 'user'].includes(prompt.role) ? prompt.role : 'system', content: rendered, source: 'preset', sourceName: prompt.name ?? id, region: Number(prompt.injection_position) === 1 ? 'chat-history' : 'before-history', depth: Number(prompt.injection_position) === 1 ? depth : null, order: Number(prompt.injection_order) || order };
        if (Number(prompt.injection_position) === 1) deferred.push(block); else add(block);
      }
    }
    if (missingLastMaintext || unresolvedWorldbookIdentity.size) return { blocks: [], messages: [], diagnostics };
    if (!historyPlaced) for (const item of history) add({ role: item.role === 'assistant' ? 'assistant' : 'user', content: getPlannerMessageContent(item), source: 'history', sourceName: String(item.messageId ?? ''), region: 'chat-history', order: 0 });
    // Depth zero follows the latest history message, before relative prompts after history.
    // Grouping by boundary preserves order among entries at the same depth.
    const injections = [...(lanes.get('at_depth') ?? []), ...deferred];
    const historyCount = blocks.filter(item => item.source === 'history').length;
    const boundaries = new Map();
    for (const [stableIndex, block] of injections.entries()) {
      const depth = Math.max(0, Math.floor(Number(block.depth) || 0));
      const boundary = Math.max(0, historyCount - depth);
      boundaries.set(boundary, [...(boundaries.get(boundary) ?? []), { block, stableIndex, depth }]);
    }
    for (const boundary of [...boundaries.keys()].sort((a, b) => b - a)) {
      const historyIndexes = blocks.map((item, index) => item.source === 'history' ? index : -1).filter(index => index >= 0);
      const target = historyIndexes.length
        ? boundary === 0 ? historyIndexes[0] : historyIndexes[boundary - 1] + 1
        : blocks.findIndex(item => item.region === 'after-history');
      const group = boundaries.get(boundary).sort((a, b) => b.depth - a.depth || a.block.order - b.block.order || a.stableIndex - b.stableIndex);
      blocks.splice(target < 0 ? blocks.length : target, 0, ...group.map(item => item.block));
    }
    blocks.forEach((item, index) => { item.sourceIndex = index; });
    return { blocks, messages: blocks.map(({ role, content }) => ({ role, content })), diagnostics };
  }
  function getPlannerMessageContent(item) {
    return typeof item?.content === 'string' ? item.content
      : typeof item?.text === 'string' ? item.text
        : typeof item?.message === 'string' ? item.message : '';
  }
  function extractLastAssistantTaggedBody(messages) {
    const history = Array.isArray(messages) ? messages : [];
    let latestAssistant = null;
    for (let index = history.length - 1; index >= 0; index--) {
      if (history[index]?.role === 'assistant') { latestAssistant = history[index]; break; }
    }
    if (!latestAssistant) return '';
    const withoutVariableUpdate = getPlannerMessageContent(latestAssistant)
      .replace(/<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable\s*>/gi, '');
    return withoutVariableUpdate.match(/<(maintext|content)\b[^>]*>([\s\S]*?)<\/\1\s*>/i)?.[2]?.trim() ?? '';
  }
  function applyPlannerKemini(blocks, preset) {
    const selected = getTriggeredPlannerPrompts(preset).map(({ prompt }) => prompt.content ?? '');
    const tags = selected.flatMap(content => content.match(/<regex(?:\s+order\s*=\s*\d+)?\s*>[\s\S]*?<\/regex>/g) ?? []);
    if (!tags.length) return selected.some(content => content.includes('<regex'))
      ? { blocks: [], diagnostics: ['Kemini 规则标签不完整，已阻止本次转换'] }
      : { blocks: blocks.map(block => ({ ...block })), diagnostics: [] };
    const diagnostics = [];
    const rules = [];
    for (const tag of tags) {
      const match = tag.match(/^<regex(?:\s+order\s*=\s*(\d+))?\s*>\s*"([\s\S]*)"\s*:\s*"([\s\S]*)"\s*<\/regex>$/);
      if (!match) { diagnostics.push('Kemini 规则格式无法解析，已阻止本次转换'); continue; }
      const literal = match[2].match(/^\/(.*)\/([dgimsuvy]*)$/s);
      try { rules.push({ order: Number(match[1] ?? 2), pattern: literal ? new RegExp(literal[1], literal[2]) : new RegExp(match[2]), replacement: match[3].replace(/\\n/g, '\n') }); }
      catch { diagnostics.push('Kemini 正则表达式无效，已阻止本次转换'); }
    }
    if (diagnostics.length) return { blocks: [], diagnostics };
    const prefixes = { system: 'SYSTEM', user: 'Human', assistant: 'Assistant' };
    function pass(value, order) {
      let next = value;
      for (const rule of rules.filter(item => item.order === order)) { rule.pattern.lastIndex = 0; next = next.replace(rule.pattern, rule.replacement); }
      return next;
    }
    function hyperMerge(content, disable) {
      const split = content.split(/\n\n(Assistant|Human|SYSTEM):/g);
      if (split.length < 2) return content;
      return split[0] + split.slice(1).reduce((acc, current, index, array) => {
        const previousRole = index > 1 ? array[index - 2] : undefined;
        const merge = index > 1 && current === previousRole && !disable.all && !disable[current];
        return acc + (index % 2 !== 0 ? current.trim() : `\n\n${merge ? '' : `${current}: `}`);
      }, '');
    }
    function process(group) {
      const combined = group.filter(block => block.content.trim()).map(block => `\n\n${prefixes[block.role] ?? 'SYSTEM'}: ${block.content.trim()}`).join('');
      if (!combined.trim()) return [];
      let content = pass(combined.replace(/<regex(?:\s+order\s*=\s*\d+)?\s*>[\s\S]*?<\/regex>/g, ''), 1);
      const disable = { all: content.includes('<|Merge Disable|>'), SYSTEM: content.includes('<|Merge System Disable|>'), Human: content.includes('<|Merge Human Disable|>'), Assistant: content.includes('<|Merge Assistant Disable|>') };
      content = content.replace(/(^|\n\n)SYSTEM:\s*/g, disable.all || disable.Human || disable.SYSTEM ? '$1' : '\n\nHuman: ');
      content = hyperMerge(content, disable);
      // Reference Clew <@n> tags restore text to an earlier role segment.
      const parts = content.split(/\n\n(?=Assistant:|Human:)/g);
      content = parts.map((part, index) => part.replace(/<@(\d+)>([\s\S]*?)<\/\1>/g, (_tag, distance, value) => {
        const target = index - Number(distance); if (target >= 0) parts[target] += `\n\n${value}`;
        return '';
      })).join('\n\n');
      content = hyperMerge(pass(content, 2), disable);
      content = pass(content, 3).replace(/<\/?additional_settings>/g, '').replace(/\r\n|\r/g, '\n')
        .replace(/\s*<\|curtail\|>\s*/g, '\n').replace(/\s*<\|join\|>\s*/g, '').replace(/\s*<\|space\|>\s*/g, ' ')
        .replace(/<\|(\\.*?)\|>/g, (_tag, value) => { try { return JSON.parse(`"${value}"`); } catch { return value; } })
        .replace(/\s*<\|.*?\|>\s*/g, '\n\n').trim();
      if (!content) return [];
      return [{ ...group[0], role: 'user', content: content.replace(/^.+:/, '\n\n$&').replace(/(?<=\n)\n(?=\n)/g, ''), provenance: group.map(item => ({ source: item.source, sourceName: item.sourceName, sourceIndex: item.sourceIndex })) }];
    }
    const output = []; let group = [];
    const flush = () => { output.push(...process(group)); group = []; };
    for (const block of blocks) {
      if (block.source === 'history' || block.source === 'input') { flush(); output.push(...process([block])); continue; }
      if (block.content.includes('<|no-trans|>')) {
        flush(); const content = block.content.replaceAll('<|no-trans|>', '').replace(/<regex(?:\s+order\s*=\s*\d+)?\s*>[\s\S]*?<\/regex>/g, '').trim();
        if (content) output.push({ ...block, content });
      } else group.push(block);
    }
    flush();
    return { blocks: output, diagnostics };
  }  function buildFinalPlannerPrompt(preset, context) {
    const compiled = compilePlannerMessages(preset, context);
    const kemini = applyPlannerKemini(compiled.blocks, preset);
    const diagnostics = [...compiled.diagnostics, ...kemini.diagnostics];
    return { blocks: kemini.blocks, messages: kemini.blocks.map(({ role, content }) => ({ role, content })), diagnostics };
  }
  function buildPlannerRequest(preset, context) {
    const final = buildFinalPlannerPrompt(preset, context);
    const compatibility = classifySPresetCompatibility(preset);
    const transformed = applySupportedSPresetSendTransform(final.messages, compatibility);
    const conditionalMergeUnverified = compatibility.conditionalMergeTag
      && final.messages.some(message => typeof message.content === 'string' && message.content.includes(compatibility.conditionalMergeTag));
    const gameContentTool = compatibility.toolBinding.tool;
    return { ...final, messages: transformed.messages, diagnostics: [...final.diagnostics, ...transformed.diagnostics,
      ...(conditionalMergeUnverified ? ['SPreset 条件合并标签已出现，但运行规则尚未核验；已阻止本次转换'] : [])], request: {
      ordered_prompts: transformed.messages.map(message => ({ ...message })),
      ...(gameContentTool ? {
        tools: [gameContentTool],
        tool_choice: { type: 'function', function: { name: 'game_content' } },
      } : {}),
    } };
  }
  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value, maxLength) {
    if (typeof value !== 'string') return '';
    return Array.from(value.trim()).slice(0, maxLength).join('');
  }

  function fnv1a(value) {
    let hash = 0x811c9dc5;
    const bytes = new TextEncoder().encode(String(value));
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function summarizePromptMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    let serialized;
    try { serialized = JSON.stringify(list); }
    catch { serialized = '[unserializable]'; }
    const messageTextChars = list.map(message => {
      if (typeof message?.content === 'string') return message.content.length;
      if (!Array.isArray(message?.content)) return 0;
      return message.content.reduce((total, part) => {
        if (typeof part === 'string') return total + part.length;
        return total + (typeof part?.text === 'string' ? part.text.length : 0);
      }, 0);
    });
    return {
      messageCount: list.length,
      roles: list.map(message => typeof message?.role === 'string' ? message.role : null),
      messageTextChars,
      totalTextChars: messageTextChars.reduce((total, length) => total + length, 0),
      fingerprint: `fnv1a-${fnv1a(serialized)}`,
    };
  }

  function parsePlannerResult(raw, expectedToolName = null, compatibility = null) {
    const completionMessage = raw?.choices?.[0]?.message;
    if (completionMessage) {
      if (expectedToolName) raw = { tool_calls: completionMessage.tool_calls ?? [], content: completionMessage.content };
      else if (typeof completionMessage.content === 'string') raw = completionMessage.content;
    }
    if (expectedToolName) {
      const textReply = typeof raw === 'string' ? raw : raw?.content;
      if ((!Array.isArray(raw?.tool_calls) || !raw.tool_calls.length)
        && (typeof textReply !== 'string' || !textReply.trim())) {
        return { ok: false, error: '规划 API 返回了空内容' };
      }
      if (!isRecord(raw) || !Array.isArray(raw.tool_calls) || raw.tool_calls.length !== 1
        || raw.tool_calls[0]?.function?.name !== expectedToolName) {
        return { ok: false, error: `规划 API 未返回 ${expectedToolName} 工具调用` };
      }
      let args;
      try { args = JSON.parse(raw.tool_calls[0].function.arguments); }
      catch { return { ok: false, error: `${expectedToolName} 工具参数不是有效 JSON` }; }
      if (!isRecord(args) || typeof args.content !== 'string' || !args.content.trim()) {
        return { ok: false, error: `${expectedToolName} 工具缺少非空 content 参数` };
      }
      const rawText = applySupportedSPresetResponseTransform(args.content, compatibility);
      if (!rawText.trim()) return { ok: false, error: `${expectedToolName} 工具内容经过输出清理后为空` };
      return { ok: true, value: { schemaVersion: 2, rawText } };
    }
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: '规划 API 返回了空内容' };
    const rawText = applySupportedSPresetResponseTransform(raw, compatibility);
    if (!rawText.trim()) return { ok: false, error: '规划 API 返回内容经过输出清理后为空' };
    return { ok: true, value: { schemaVersion: 2, rawText } };
  }

  function getToolCalls(message) {
    const calls = message?.toolCalls ?? message?.tool_calls;
    return Array.isArray(calls) ? calls : [];
  }
  function analyzeToolProtocol(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const owners = [];
    const ownerById = new Map();
    const resultsById = new Map();
    let hasProtocol = false;
    let invalid = false;
    for (const [index, message] of list.entries()) {
      const calls = getToolCalls(message);
      if (message?.role === 'assistant' && calls.length) {
        hasProtocol = true;
        const ids = calls.map(call => typeof call?.id === 'string' ? call.id.trim() : '');
        const owner = { ownerIndex: index, ids, valid: ids.every(Boolean) && new Set(ids).size === ids.length };
        if (!owner.valid) invalid = true;
        owners.push(owner);
        for (const id of ids.filter(Boolean)) {
          if (ownerById.has(id)) { ownerById.set(id, null); invalid = true; }
          else ownerById.set(id, owner);
        }
      }
      if (message?.role === 'tool') {
        hasProtocol = true;
        const id = typeof (message.toolCallId ?? message.tool_call_id) === 'string'
          ? (message.toolCallId ?? message.tool_call_id).trim() : '';
        if (!id) { invalid = true; continue; }
        const indexes = resultsById.get(id) ?? [];
        indexes.push(index);
        resultsById.set(id, indexes);
      }
    }
    const cycles = owners.map(owner => {
      let complete = owner.valid;
      const resultIndexes = [];
      for (const id of owner.ids) {
        const matchingOwner = ownerById.get(id);
        const indexes = resultsById.get(id) ?? [];
        if (!matchingOwner || matchingOwner !== owner || indexes.length !== 1 || indexes[0] <= owner.ownerIndex) complete = false;
        else resultIndexes.push(indexes[0]);
      }
      const lastResultIndex = resultIndexes.length ? Math.max(...resultIndexes) : owner.ownerIndex;
      const finalIndex = complete
        ? list.findIndex((message, index) => index > lastResultIndex && message?.role === 'assistant'
          && getToolCalls(message).length === 0 && String(message?.content ?? '').trim())
        : -1;
      if (finalIndex < 0) complete = false;
      return { ownerIndex: owner.ownerIndex, complete, finalIndex };
    });
    for (const [id, indexes] of resultsById) {
      const owner = ownerById.get(id);
      if (!owner || indexes.length !== 1 || indexes[0] <= owner.ownerIndex) invalid = true;
    }
    return { hasProtocol, invalid, cycles };
  }
  function getStoryMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const protocol = analyzeToolProtocol(list);
    let openCycleStart = list.length;
    const omitted = new Set();
    for (const cycle of protocol.cycles) {
      if (!cycle.complete) openCycleStart = Math.min(openCycleStart, cycle.ownerIndex);
      else for (let index = cycle.ownerIndex; index < cycle.finalIndex; index += 1) omitted.add(index);
    }
    return list.filter((message, index) => index < openCycleStart && !omitted.has(index)
      && message?.role !== 'tool' && getToolCalls(message).length === 0);
  }
  function isFinalNarrativeAssistant(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const latest = list.at(-1);
    if (latest?.role !== 'assistant' || getToolCalls(latest).length || !String(latest.content ?? '').trim()) return false;
    const lastUser = list.findLastIndex(message => message?.role === 'user');
    const protocol = analyzeToolProtocol(list.slice(lastUser + 1));
    return !protocol.invalid && protocol.cycles.every(cycle => cycle.complete);
  }
  function buildPlannerHistoryMessages(messages, historyLimit = 12) {
    const limit = Math.max(0, Math.floor(Number(historyLimit) || 0));
    if (!limit) return [];
    return getStoryMessages(messages).slice(-limit).map(message => ({
      messageId: message.messageId,
      role: message.role,
      content: message.content,
    }));
  }
  function buildSnapshot(messages, previousState = null) {
    const normalized = (Array.isArray(messages) ? messages : [])
      .filter((message) => isRecord(message) && message.is_hidden !== true && Number.isInteger(message.message_id))
      .map((message) => {
        const role = ['system', 'assistant', 'user', 'tool'].includes(message.role)
          ? message.role : message.is_user ? 'user' : message.is_system ? 'system' : 'assistant';
        return {
          messageId: message.message_id,
          role,
          content: String(message.message ?? message.content ?? message.mes ?? ''),
          ...(getToolCalls(message).length ? { toolCalls: structuredClone(getToolCalls(message)) } : {}),
          ...(typeof (message.tool_call_id ?? message.toolCallId) === 'string'
            ? { toolCallId: message.tool_call_id ?? message.toolCallId } : {}),
          ...(typeof message.name === 'string' ? { name: message.name } : {}),
        };
      })
      .sort((left, right) => left.messageId - right.messageId);
    const snapshot = {
      schemaVersion: 2,
      baseMessageId: normalized.at(-1)?.messageId ?? -1,
      baseStateVersion: Number.isInteger(previousState?.stateVersion) ? previousState.stateVersion : 0,
      messages: normalized,
    };
    return { ...snapshot, inputHash: hashSnapshot(snapshot) };
  }

  function classifyPlanningTurn(snapshot, state, generationType = 'normal') {
    if (generationType !== 'normal') return 'skip';
    const messages = snapshot?.messages ?? [];
    if (!messages.length) return 'skip';
    const latest = messages.at(-1);
    if (messages.length === 1 && latest.messageId === 0) return 'skip';
    const openingOnly = messages[0].messageId === 0
      && !messages.slice(1).some(message => message.role === 'assistant');
    if (openingOnly && latest.role === 'user' && state?.initialStatus !== 'ready') return 'initial';
    return 'normal';
  }

  function extractOutline(rawText) {
    if (typeof rawText !== 'string') return { ok: false, error: '规划结果不是文本' };
    const opens = [...rawText.matchAll(/<outline(?:\s[^<>]*)?>/gi)];
    const closes = [...rawText.matchAll(/<\/outline\s*>/gi)];
    if (opens.length !== 1 || closes.length !== 1 || closes[0].index < opens[0].index + opens[0][0].length) {
      return { ok: false, error: '规划结果须包含一对完整的 <outline> 标签' };
    }
    const innerStart = opens[0].index + opens[0][0].length;
    const body = rawText.slice(innerStart, closes[0].index).trim();
    if (!body) return { ok: false, error: '<outline> 内容为空' };
    return { ok: true, fullTag: rawText.slice(opens[0].index, closes[0].index + closes[0][0].length), body };
  }

  function classifyPlannerFailure(error) {
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      const details = {
        400: '请求参数被拒绝；请核对模型和工具调用支持情况。',
        401: '身份验证失败；请核对 API 密钥。',
        403: '访问被拒绝；请核对密钥权限。',
        404: '接口路径或模型不存在；请核对 API 地址和模型名称。',
        408: '接口请求超时；请稍后重试。',
        429: '请求过于频繁或额度不足；请稍后重试或检查额度。',
      };
      return { code: `HTTP_${status}`, message: `HTTP ${status}：${details[status] ?? (status >= 500 ? '服务端暂时出错；请稍后重试。' : '接口拒绝了请求；请检查配置。')}` };
    }
    const message = String(error?.message ?? '');
    if (message === '请求超时') return { code: 'TIMEOUT', message: '规划请求超时；请检查连接或调大超时时间。' };
    if (error?.code === 'CANCELLED') return { code: 'CANCELLED', message: '规划请求已取消。' };
    if (error?.code === 'NETWORK') return { code: 'NETWORK', message: '网络请求失败；请检查酒馆与接口连接。' };
    if (error?.code === 'INVALID_RESPONSE') return { code: 'INVALID_RESPONSE', message: '接口返回了无法解析的响应格式。' };
    if (error?.code === 'API_RESPONSE_ERROR') {
      const hostStatus = Number(error?.hostStatus);
      return { code: 'API_RESPONSE_ERROR', message: Number.isInteger(hostStatus) && hostStatus >= 400 && hostStatus <= 599
        ? `酒馆宿主 HTTP ${hostStatus}：上游状态未知；请检查酒馆服务器日志。`
        : '接口返回错误，但上游状态未知；请检查酒馆服务器日志。' };
    }
    if (/^规划 API 未返回 game_content 工具调用/.test(message)) return { code: 'TOOL_CALL_MISSING', message: '接口返回了普通文本或其他工具，没有返回 game_content 调用。请用“测试工具调用”区分独立请求链路与完整规划提示词。' };
    if (/^game_content 工具参数不是有效 JSON/.test(message)) return { code: 'TOOL_ARGS_INVALID', message: 'game_content 工具参数不是有效 JSON。' };
    if (/^game_content 工具缺少非空 content 参数|^game_content 工具内容经过输出清理后为空/.test(message)) return { code: 'TOOL_CONTENT_EMPTY', message: 'game_content 工具返回了空内容。' };
    if (/^规划 API 返回了空内容|^规划 API 返回内容经过输出清理后为空/.test(message)) return { code: 'EMPTY_RESPONSE', message: '规划 API 返回空回复。' };
    if (/^规划结果须包含一对完整的 <outline> 标签/.test(message)) return { code: 'OUTLINE_MISSING', message: '规划结果缺少完整的 <outline> 标签。' };
    if (/^<outline> 内容为空/.test(message)) return { code: 'OUTLINE_EMPTY', message: '<outline> 标签内没有内容。' };
    if (/^API 设置不完整/.test(message)) return { code: 'CONFIG_INCOMPLETE', message: 'API 设置不完整；请填写地址和模型。' };
    if (/^预设没有可发送的 Prompt/.test(message)) return { code: 'PRESET_EMPTY', message: '规划预设没有可发送的 Prompt；请导入或填写预设。' };
    if (/^预设无法生成有效消息/.test(message)) return { code: 'PRESET_INVALID', message: '规划预设无法生成有效消息；请检查预设。' };
    if (/^世界书接口缺失|^世界书读取失败/.test(message)) return { code: 'WORLDBOOK_ERROR', message: '世界书读取失败；请检查绑定和酒馆接口。' };
    if (/^角色资料接口缺失|^当前 Persona 无法读取/.test(message)) return { code: 'CONTEXT_ERROR', message: '角色或玩家资料读取失败；请检查当前聊天。' };
    if (/^最新助手回复缺少/.test(message)) return { code: 'MAIN_TEXT_MISSING', message: '最新酒馆回复缺少预设所需的正文标签。' };
    if (/^API 地址必须使用|^API 基址不能包含|^当前浏览器未提供 fetch/.test(message)) return { code: 'API_ADDRESS_INVALID', message: 'API 地址或浏览器请求能力不可用；请检查设置。' };
    if (error?.name === 'TypeError' || error?.name === 'AbortError') return { code: 'NETWORK', message: '网络请求失败或被中断；请检查酒馆与接口连接。' };
    return { code: 'UNKNOWN', message: '规划失败，原因未能安全识别；请检查酒馆服务器日志。' };
  }

  function hashSnapshot(snapshot) {
    const { inputHash: _ignored, ...hashable } = isRecord(snapshot) ? snapshot : {};
    void _ignored;
    return `fnv1a-${fnv1a(JSON.stringify(hashable))}`;
  }

  function isSnapshotCurrent(job, snapshot, epoch) {
    return Boolean(job && snapshot
      && job.epoch === epoch
      && job.baseMessageId === snapshot.baseMessageId
      && job.inputHash === snapshot.inputHash);
  }

  function createPlannerScheduler(options) {
    const setTimer = options.setTimer ?? setTimeout;
    const clearTimer = options.clearTimer ?? clearTimeout;
    const debounceMs = Math.max(0, Number(options.debounceMs) || 0);
    let running = null;
    let pending = false;
    let pendingReason = 'unknown';
    let timer = null;
    let epoch = 0;
    let destroyed = false;
    let sequence = 0;

    function nextGenerationId() {
      sequence += 1;
      const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${sequence}`;
      return `tw-planner-${randomPart}`;
    }

    function clearScheduledStart() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    }

    function arm(delay) {
      clearScheduledStart();
      timer = setTimer(() => {
        timer = null;
        void startLatest();
      }, delay);
    }

    async function startLatest() {
      if (destroyed || running || !pending) return;
      pending = false;
      const reason = pendingReason;
      let snapshot;
      try {
        snapshot = await options.readSnapshot();
      } catch (error) {
        if (!destroyed) options.publish({ error: error instanceof Error ? error : new Error(String(error)), phase: 'snapshot' });
        return;
      }
      const job = {
        jobId: `job-${nextGenerationId()}`,
        generationId: nextGenerationId(),
        reason,
        epoch,
        baseMessageId: snapshot.baseMessageId,
        baseStateVersion: snapshot.baseStateVersion ?? 0,
        inputHash: snapshot.inputHash,
        startedAt: new Date().toISOString(),
      };
      running = { job };
      try {
        const result = await options.runJob(job, snapshot);
        const currentSnapshot = await options.readSnapshot();
        if (!destroyed && isSnapshotCurrent(job, currentSnapshot, epoch)) {
          options.publish({ job, snapshot, result });
        }
      } catch (error) {
        let currentSnapshot = null;
        try {
          currentSnapshot = await options.readSnapshot();
        } catch { /* the original contained failure remains the useful diagnostic */ }
        if (!destroyed && isSnapshotCurrent(job, currentSnapshot, epoch)) {
          options.publish({ job, snapshot, error: error instanceof Error ? error : new Error(String(error)) });
        }
      } finally {
        if (running?.job === job) running = null;
        if (!destroyed && pending) arm(0);
      }
    }

    function schedule(reason = 'unknown') {
      if (destroyed) return;
      pending = true;
      pendingReason = reason;
      if (!running) arm(debounceMs);
    }

    function changeChat() {
      if (destroyed) return;
      epoch += 1;
      pending = false;
      clearScheduledStart();
      if (running?.job.generationId) options.cancelGeneration(running.job.generationId);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      pending = false;
      clearScheduledStart();
      if (running?.job.generationId) options.cancelGeneration(running.job.generationId);
    }

    function getStatus() {
      return {
        destroyed,
        epoch,
        pending,
        running: Boolean(running),
        generationId: running?.job.generationId ?? null,
      };
    }

    return { schedule, changeChat, destroy, getStatus };
  }

  function normalizeConfig(value) {
    const source = isRecord(value) ? value : {};
    return {
      enabled: source.enabled === true,
      apiurl: text(source.apiurl, 2048),
      key: typeof source.key === 'string' ? source.key.trim() : '',
      model: text(source.model, 120),
      timeoutSeconds: Math.min(600, Math.max(0.01, Number(source.timeoutSeconds) || DEFAULT_CONFIG.timeoutSeconds)),
      retryCount: Math.min(10, Math.max(0, Math.trunc(Number.isFinite(Number(source.retryCount)) ? Number(source.retryCount) : DEFAULT_CONFIG.retryCount))),
      maxTokens: Math.min(65535, Math.max(1, Math.trunc(Number(source.maxTokens) || DEFAULT_CONFIG.maxTokens))),
      temperature: Math.min(2, Math.max(0, Number.isFinite(Number(source.temperature)) ? Number(source.temperature) : DEFAULT_CONFIG.temperature)),
      debounceMs: Math.min(10000, Math.max(0, Math.trunc(Number(source.debounceMs) || 0))),
      historyLimit: Math.min(40, Math.max(2, Math.trunc(Number(source.historyLimit) || DEFAULT_CONFIG.historyLimit))),
    };
  }

  function validateConfig(config) {
    const errors = {};
    if (!config.apiurl) errors.apiurl = '请填写 API 地址';
    else {
      try {
        const url = new URL(config.apiurl);
        if (!['http:', 'https:'].includes(url.protocol)) errors.apiurl = '地址必须是 http 或 https';
      } catch { errors.apiurl = 'API 地址不是有效网址'; }
    }
    if (!config.model) errors.model = '请填写模型名';
    return errors;
  }

  function buildCustomApi(config) {
    return {
      apiurl: config.apiurl,
      key: config.key,
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    };
  }

  function buildPanelViewModel(requestedConfig, planningState, runtimeStatus = {}, presetReady = true) {
    const config = normalizeConfig({ ...DEFAULT_CONFIG, ...(isRecord(requestedConfig) ? requestedConfig : {}) });
    const state = isRecord(planningState) ? planningState : {};
    const status = !config.enabled ? 'disabled'
      : runtimeStatus.running ? state.status === 'retrying' ? 'retrying' : 'running'
        : runtimeStatus.pending ? 'pending'
          : ['ready', 'failed', 'interrupted'].includes(state.status) ? state.status : 'idle';
    const statusLabels = {
      disabled: '自动规划已关闭', idle: '等待规划', pending: '等待中', running: '规划中', retrying: '重试中', ready: '已完成', failed: '失败', interrupted: '上次任务中断',
    };
    const outline = typeof state.activeOutline === 'string' ? extractOutline(state.activeOutline) : null;
    const activationHint = !config.enabled ? '规划器已关闭，不会调用规划 API。'
      : Object.keys(validateConfig(config)).length ? '规划器已开启，请在设置中填写 API 地址和模型。'
        : !presetReady ? '规划器已开启，请先导入或填写可用预设。'
          : '规划器已开启；首次玩家消息发送后、酒馆首次回复前执行初始规划。';
    return {
      config,
      status,
      statusLabel: `${statusLabels[status]}${runtimeStatus.running ? ` · ${runtimeStatus.phase === 'next' ? '下一轮' : '本轮'} · 第 ${runtimeStatus.attempt ?? 1} 次尝试` : ''}`,
      activationHint,
      updatedAt: text(state.updatedAt, 80),
      outlineBody: outline?.ok ? outline.body : '',
      outlineHistory: Array.isArray(state.outlineHistory) ? structuredClone(state.outlineHistory) : [],
      lastTask: state.lastTask ?? null,
      lastError: text(state.lastError, DEFAULT_LIMITS.maxTextLength),
      persistenceError: text(state.persistenceError ?? runtimeStatus.persistenceError, DEFAULT_LIMITS.maxTextLength),
      configErrors: validateConfig(config),
    };
  }

  function persistPlannerConfig(globals, draft, currentConfig = {}, clearKey = false) {
    const config = normalizeConfig({ ...DEFAULT_CONFIG, ...currentConfig, ...(isRecord(draft) ? draft : {}) });
    if (!clearKey && !draft?.key) config.key = currentConfig.key || '';
    if (clearKey) config.key = '';
    globals.updateVariablesWith((variables) => ({ ...(isRecord(variables) ? variables : {}), config }), {
      type: 'script',
    });
    return config;
  }

  function bindPlannerButton(globals, openPanel) {
    if (typeof globals.getButtonEvent !== 'function' || typeof globals.eventOn !== 'function') return () => {};
    const eventName = globals.getButtonEvent(BUTTON_NAME);
    if (typeof eventName !== 'string') return () => {};
    const subscription = globals.eventOn(eventName, openPanel);
    return typeof subscription?.stop === 'function' ? () => subscription.stop() : () => {};
  }

  function createPlannerPanel(options) {
    const doc = options.document;
    if (!doc?.body || typeof doc.createElement !== 'function') throw new Error('剧情规划器无法访问面板文档');
    const root = doc.createElement('dialog');
    root.id = 'tw-story-planner-dialog-v1';
    root.className = 'twsp-dialog';
    root.setAttribute('aria-labelledby', 'tw-story-planner-title-v1');
    const style = doc.createElement('style');
    style.textContent = `
      .twsp-dialog{width:min(1180px,calc(100vw - 20px));max-height:calc(100dvh - 24px);padding:0;border:1px solid #48251f;border-radius:0;color:#e9c39e;background:#170807}
      .twsp-dialog::backdrop{background:rgba(7,2,2,.78)}
      .twsp-shell{box-sizing:border-box;max-height:calc(100dvh - 24px);overflow:auto;padding:24px 30px;font:15px/1.5 system-ui,"Microsoft YaHei",sans-serif}
      .twsp-head,.twsp-tabs,.twsp-actions,.twsp-statusline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .twsp-head{justify-content:space-between}.twsp-title{margin:0;font-size:20px}.twsp-activation{margin-left:auto;border-color:#a16937;background:#3f2415;color:#ffe0ac;font-weight:700}
      .twsp-activation[data-enabled="true"]{border-color:#588b65;background:#203d2b;color:#d6f5db}
      .twsp-button,.twsp-close,.twsp-tab{min-height:42px;padding:8px 15px;border:1px solid #4b2521;border-radius:0;color:inherit;background:#1b0a09;cursor:pointer}
      .twsp-close{min-width:42px;font-size:20px}.twsp-button--primary,.twsp-tab[aria-selected="true"]{border-color:#9b602c;background:#573013;color:#ffd994}
      .twsp-button:disabled{opacity:.5;cursor:not-allowed}
      .twsp-button:focus-visible,.twsp-close:focus-visible,.twsp-tab:focus-visible,.twsp-input:focus-visible{outline:2px solid #d5964e;outline-offset:2px}
      .twsp-tabs{margin:14px 0}.twsp-panel{padding:18px;border:1px solid #48251f;background:#170807}
      .twsp-statusline{margin-bottom:12px;color:#ae8777}.twsp-badge{padding:4px 10px;background:#4b2521}
      .twsp-raw{white-space:pre-wrap;overflow-wrap:anywhere;max-height:50dvh;overflow:auto;margin:0;font:inherit}
      .twsp-grid{display:grid;grid-template-columns:1fr;gap:18px}.twsp-field{display:grid;gap:5px;min-width:0;color:#a87967}.twsp-wide{grid-column:1/-1}
      .twsp-input{box-sizing:border-box;width:100%;min-height:48px;padding:9px 14px;border:1px solid #4b2521;border-radius:0;color:#e9c39e;background:#1b0a09;font:inherit}
      .twsp-model-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end}.twsp-model-row>.twsp-button{min-height:48px}
      .twsp-hint{color:#ae8777}.twsp-error{color:#efa69d;overflow-wrap:anywhere}.twsp-actions{justify-content:flex-end;margin-top:18px}
      .twsp-advanced{margin-top:16px;color:#ae8777}.twsp-advanced>.twsp-grid{margin-top:12px}.twsp-advanced .twsp-actions{justify-content:flex-start}
      .twsp-advanced-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
      .twsp-preset-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) minmax(220px,1.4fr);gap:14px;margin:14px 0 18px}
      .twsp-preset-toolbar .twsp-field{margin:0}.twsp-preset-import{display:grid;gap:5px;color:#a87967}
      .twsp-prompt-list{display:grid;gap:8px;margin:16px 0}.twsp-prompt-card{border:1px solid #48251f;background:#1c0e0d}
      .twsp-prompt-card[data-enabled="false"]{opacity:.57}.twsp-prompt-card[data-enabled="false"] .twsp-prompt-head{background:#170c0b}
      .twsp-prompt-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto auto auto auto;align-items:center;gap:12px;min-height:68px;padding:4px 16px;background:#211211}
      .twsp-prompt-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e9b588;font-size:16px}
      .twsp-prompt-role{min-width:64px;padding:5px 9px;border:1px solid #8b5d28;color:#e7b95e;text-align:center;font:12px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.04em}
      .twsp-prompt-size{min-width:42px;color:#9b7162;text-align:right;font:13px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
      .twsp-prompt-icon{min-width:34px;min-height:42px;padding:5px;border:0;color:#ae8777;background:transparent;font-size:21px;cursor:pointer}
      .twsp-prompt-icon:hover{color:#ffd994}.twsp-prompt-icon:focus-visible,.twsp-switch input:focus-visible{outline:2px solid #d5964e;outline-offset:2px}
      .twsp-prompt-move{display:flex;flex-direction:column;gap:0}.twsp-prompt-move .twsp-prompt-icon{min-height:20px;font-size:14px;line-height:1}
      .twsp-switch{display:inline-flex;align-items:center;min-width:58px;min-height:44px;cursor:pointer}
      .twsp-switch input{appearance:none;width:58px;height:29px;margin:0;border:1px solid #694a35;border-radius:20px;background:#2d1b19;cursor:pointer;transition:background .18s ease}
      .twsp-switch input:before{content:"";display:block;width:22px;height:22px;margin:2px;border-radius:50%;background:#a88c79;transition:transform .18s ease,background .18s ease}
      .twsp-switch input:checked{background:#8a683a}.twsp-switch input:checked:before{transform:translateX(28px);background:#ffe4ba}
      .twsp-prompt-editor{display:grid;gap:18px;padding:24px;border-top:1px solid #48251f;background:#1a0b0a}
      .twsp-prompt-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}
      .twsp-prompt-fields--position{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}
      .twsp-prompt-content{min-height:175px;resize:vertical;line-height:1.65}
      .twsp-prompt-advanced{margin:0}.twsp-prompt-advanced summary{min-height:38px;color:#a87967;cursor:pointer}
      .twsp-prompt-advanced .twsp-grid{margin-top:10px}
      .twsp-prompt-hint{margin:0;color:#a87967;font-size:13px}
      .twsp-prompt-footer{display:flex;justify-content:flex-end;gap:8px}
      .twsp-preset-actions{border-top:1px solid #48251f;padding-top:15px}
      .twsp-preset-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin:14px 0 16px;padding-bottom:12px;border-bottom:1px solid #3a1717}
      .twsp-preset-toolbar-actions,.twsp-preset-card-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
      .twsp-preset-active{color:#9c8979;font-size:11px;letter-spacing:.06em}.twsp-preset-active strong{color:#e2bc43;font-weight:normal}
      .twsp-preset-import{display:none}.twsp-preset-cards{display:grid;gap:8px;margin:12px 0}
      .twsp-preset-card{display:flex;align-items:center;gap:12px;min-height:48px;padding:8px 16px;border:1px solid #3a1717;background:#180909}
      .twsp-preset-card[data-selected="true"]{border-color:#69452b;background:#21120f}
      .twsp-preset-select{display:grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:1px solid #69452b;border-radius:50%;color:transparent;background:transparent;cursor:pointer}
      .twsp-preset-card[data-selected="true"] .twsp-preset-select{border-color:#b5523b;color:#e2bc43;background:#3c1713}
      .twsp-preset-card-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;color:#e2bc43;background:transparent;text-align:left;font:inherit;cursor:pointer}
      .twsp-preset-kind{padding:4px 8px;border:1px solid #8a4a3d;color:#e6c978;font-size:10px;letter-spacing:.12em}
      .twsp-preset-editname{margin:10px 0 18px}.twsp-preset-editname[hidden]{display:none}
      .twsp-preset-compat{margin:12px 0;padding:12px 16px;border:1px solid #69452b;background:#21120f;color:#c4a88d;font-size:12px;line-height:1.7}
      .twsp-preset-compat:empty{display:none}.twsp-preset-compat strong{color:#e2bc43;font-weight:normal}.twsp-preset-compat p{margin:0}.twsp-preset-compat p+p{margin-top:4px;color:#a87967}
      .twsp-prompt-list{gap:6px}.twsp-prompt-card{border-color:#42221e;background:#1b1010}.twsp-prompt-card[data-enabled="false"]{opacity:.45}.twsp-prompt-card[data-enabled="false"] .twsp-prompt-head{background:transparent}
      .twsp-prompt-head{display:flex;align-items:center;gap:12px;min-height:48px;padding:0 16px;background:transparent}
      .twsp-prompt-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;color:#d8b9a0;background:transparent;text-align:left;font-size:12px;letter-spacing:.05em;cursor:pointer}
      .twsp-prompt-title:hover{color:#e2bc43}.twsp-prompt-meta{display:grid;grid-template-columns:auto 40px 40px 18px 18px;align-items:center;justify-content:end;gap:12px;width:320px;flex:none}
      .twsp-prompt-role{min-width:0;padding:4px 8px;border-color:#8b6a2f;color:#e1c36d;font-size:9px;line-height:1.3;letter-spacing:.12em}
      .twsp-prompt-role[data-role="user"]{border-color:#7e3b32;color:#d27b68}.twsp-prompt-role[data-role="assistant"]{border-color:#80683a;color:#d7b76d}
      .twsp-prompt-size{min-width:0;width:40px;color:#9d7662;font-size:10px}.twsp-prompt-icon{min-width:18px;min-height:28px;width:18px;height:28px;padding:0;font-size:17px}.twsp-prompt-icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
      .twsp-prompt-drag{flex:none;color:#8c6757;opacity:.55;cursor:grab;user-select:none}.twsp-prompt-drag:active{cursor:grabbing}
      .twsp-switch{min-width:40px;min-height:20px;width:40px;height:20px}.twsp-switch input{width:40px;height:20px;border-color:#4b3b3b;background:#201414}
      .twsp-switch input:before{width:16px;height:16px;margin:1px 2px;background:#f1dfbd}.twsp-switch input:checked{border-color:#a88958;background:#7b5a2f}.twsp-switch input:checked:before{transform:translateX(20px);background:#f1dfbd}
      .twsp-prompt-editor{gap:16px;padding:16px;border-top-color:#4a221d;background:#160909}.twsp-prompt-fields,.twsp-prompt-fields--position{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
      .twsp-prompt-editor .twsp-input{min-height:36px;padding:7px 12px;border-color:#3a1717;color:#c4b5a2;background:#1a0b0b;font-size:12px}
      .twsp-prompt-content{min-height:128px;line-height:1.7}.twsp-prompt-content:read-only{opacity:.5;cursor:not-allowed}.twsp-prompt-advanced-button{justify-self:start;padding:0;border:0;color:#a87967;background:transparent;font-size:11px;letter-spacing:.08em;cursor:pointer}
      .twsp-prompt-advanced-button:hover{color:#e2bc43}.twsp-prompt-advanced-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding-top:12px;border-top:1px solid #3a1717}
      .twsp-prompt-advanced-grid[hidden],.twsp-position-detail[hidden]{display:none}.twsp-prompt-hint{font-size:11px}.twsp-prompt-flag{display:flex;align-items:center;gap:8px;color:#c4b5a2;font-size:11px}.twsp-prompt-flag input{accent-color:#c9a84c}
      .twsp-add-prompt{display:block;width:100%;border-style:dashed;border-color:#5b3025;color:#c9a84c;background:transparent;font-size:11px;letter-spacing:.08em}
      .twsp-delete-overlay{position:fixed;inset:0;z-index:120;display:grid;place-items:center;padding:20px;background:rgba(0,0,0,.6)}
      .twsp-delete-dialog{width:min(420px,calc(100vw - 40px));border:1px solid #713126;color:#d8c1ad;background:linear-gradient(145deg,#2b1110,#180908 65%,#35130f);box-shadow:0 0 40px rgba(20,0,0,.65)}
      .twsp-delete-dialog-header{padding:16px 20px;border-bottom:1px solid #713126;background:#3c1713;color:#e2bc43}.twsp-delete-dialog-body{display:grid;gap:18px;padding:20px}.twsp-delete-dialog-actions{display:flex;justify-content:flex-end;gap:10px}
      .twsp-preset-internal{display:none!important}
      @media(max-width:520px){.twsp-shell{padding:12px}.twsp-grid,.twsp-advanced-grid{grid-template-columns:1fr}.twsp-wide{grid-column:auto}.twsp-model-row{grid-template-columns:1fr}.twsp-model-row>.twsp-button{width:100%}}
      @media(max-width:720px){.twsp-prompt-fields,.twsp-prompt-fields--position,.twsp-prompt-advanced-grid{grid-template-columns:1fr}.twsp-prompt-head{flex-wrap:wrap;gap:8px;padding:8px 10px}.twsp-prompt-title{flex:1 1 120px}.twsp-prompt-meta{width:auto;grid-template-columns:auto 40px 30px 18px 18px;gap:8px}.twsp-prompt-editor{padding:14px}.twsp-preset-card{padding:8px}}
      @media(prefers-reduced-motion:reduce){.twsp-dialog *{animation:none!important;transition:none!important}}
      .twsp-dialog{border:1px solid #e8e1d7;border-radius:26px;color:#26312d;background:#faf8f3;box-shadow:0 24px 65px #211b151f}
      .twsp-dialog::backdrop{background:rgba(20,25,25,.55)}
      .twsp-shell{padding:0;font:15px/1.55 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
      .twsp-head{padding:22px 30px 17px;gap:12px}.twsp-title{font-size:20px;letter-spacing:-.02em}.twsp-head-subtitle{display:block;color:#8c9089;font-size:12px}
      .twsp-button,.twsp-close,.twsp-tab{min-height:44px;border:1px solid #e6e0d7;border-radius:13px;color:#665f55;background:#fff;transition:background .18s ease,box-shadow .18s ease}
      .twsp-button:hover,.twsp-close:hover,.twsp-tab:hover{background:#f5f0e9}
      .twsp-button--primary,.twsp-tab[aria-selected="true"]{border-color:#a9671c;background:#a9671c;color:#fff}
      .twsp-button--primary:hover,.twsp-tab[aria-selected="true"]:hover{background:#915718}
      .twsp-activation{margin-left:auto;border-color:#d8e7d7;border-radius:999px;background:#edf3eb;color:#416148;font-size:13px}
      .twsp-activation[data-enabled="true"]{border-color:#d8e7d7;background:#e8f0e8;color:#416148}
      .twsp-close{width:44px;padding:5px;background:#efede8;color:#66706e}
      .twsp-button:focus-visible,.twsp-close:focus-visible,.twsp-tab:focus-visible,.twsp-input:focus-visible,.twsp-prompt-icon:focus-visible,.twsp-prompt-title:focus-visible,.twsp-preset-card-name:focus-visible,.twsp-switch input:focus-visible{outline:2px solid #a9671c;outline-offset:2px}
      .twsp-tabs{margin:0;padding:0 30px 16px;border-bottom:1px solid #e7e3dc;gap:6px}.twsp-tab{padding:9px 18px;border-color:transparent;border-radius:999px;background:transparent;color:#6f7875;font-weight:600}
      .twsp-panel{margin:0;padding:30px;border:0;background:transparent}.twsp-panel[hidden]{display:none}
      .twsp-page-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:23px}.twsp-page-title{margin:0;font-size:28px;line-height:1.2;letter-spacing:-.03em}.twsp-page-description{margin:5px 0 0;color:#8d948f;font-size:13px}.twsp-version{padding:6px 11px;border-radius:999px;background:#f2e5d4;color:#a9671c;font-size:12px;font-weight:700}
      .twsp-statusline{gap:8px;color:#8d948f;font-size:12px}.twsp-badge{border-radius:999px;background:#f9edda;color:#9a641f;font-weight:700}.twsp-hint{color:#7d8781}.twsp-error{color:#a43e32}
      .twsp-result-card,.twsp-history-entry,.twsp-preset-card,.twsp-prompt-card,.twsp-settings-section,.twsp-preset-toolbar{border:1px solid #e9e3da;border-radius:17px;background:#fff;box-shadow:0 6px 18px #58453608}
      .twsp-result-card{padding:21px 23px;margin:16px 0}.twsp-result-card .twsp-raw{margin-top:12px}.twsp-history{display:grid;gap:10px}.twsp-history-entry{margin:0;overflow:hidden}.twsp-history-entry>summary{padding:17px 19px;min-height:66px;list-style:none;color:#303c35;font-weight:650}.twsp-history-entry>summary::-webkit-details-marker{display:none}.twsp-history-entry>summary:hover{background:#fcfaf6}.twsp-history-entry>p{margin:0;padding:0 19px;color:#8d948f;font-size:12px}.twsp-history-entry>.twsp-outline,.twsp-history-entry>.twsp-raw{margin:12px 19px 18px}
      .twsp-outline{padding:15px 17px;border-radius:15px;background:#faf8f3}.twsp-outline-meta{display:flex;flex-wrap:wrap;gap:8px 22px;margin-bottom:16px}.twsp-outline-meta-item{display:flex;align-items:center;gap:7px;color:#6c7770;font-size:12px}.twsp-outline-meta-item svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;color:#a79a88}.twsp-outline-event-label{display:block;margin-bottom:7px;color:#a36b2d;font-size:12px;font-weight:700}.twsp-outline-event{margin:0;color:#303c35;font-size:16px;font-weight:500;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere}.twsp-outline>details{margin-top:15px;border-top:1px solid #e8e2d7;padding-top:10px}.twsp-outline>details summary{color:#a9671c;font-size:12px;cursor:pointer}.twsp-outline .twsp-raw{margin:10px 0 0;color:#66716a;font-size:13px}
      .twsp-input{border-color:#e6e4dd;border-radius:11px;color:#39413b;background:#faf9f6}.twsp-field{color:#757b75;font-size:13px;font-weight:600}.twsp-grid{gap:15px}.twsp-model-row>.twsp-button{min-height:48px}.twsp-actions{gap:10px}
      .twsp-settings-section{padding:21px;margin:12px 0}.twsp-settings-section>summary{list-style:none;cursor:pointer;font-size:16px;font-weight:700}.twsp-settings-section>summary::-webkit-details-marker{display:none}.twsp-settings-section .twsp-grid{margin-top:19px}.twsp-settings-section .twsp-actions{justify-content:flex-start}
      .twsp-advanced{margin:12px 0;padding:18px 21px;border:1px solid #e9e3da;border-radius:16px;background:#fff;color:#48534d}.twsp-advanced summary{cursor:pointer;font-weight:700}
      .twsp-preset-toolbar{padding:18px 20px;border-bottom:1px solid #e9e3da}.twsp-preset-active{color:#7d8781;font-size:12px}.twsp-preset-active strong{color:#a9671c;font-weight:700}.twsp-preset-kind{border:0;border-radius:999px;background:#f9edda;color:#9a641f;font-size:11px}
      .twsp-preset-card{min-height:65px;padding:9px 15px}.twsp-preset-card[data-selected="true"]{border-color:#cead80;background:#fffaf2}.twsp-preset-select{width:32px;height:32px;border-color:#d3c2ac}.twsp-preset-card[data-selected="true"] .twsp-preset-select{border-color:#a9671c;color:#fff;background:#a9671c}.twsp-preset-card-name{color:#303c35;font-size:14px;font-weight:650}.twsp-preset-compat{border-color:#e8d9c5;border-radius:13px;background:#fffbf4;color:#6a6257}.twsp-preset-compat strong{color:#a9671c}
      .twsp-prompt-card{overflow:hidden}.twsp-prompt-card[data-enabled="false"]{opacity:.67}.twsp-prompt-head{min-height:62px;background:transparent}.twsp-prompt-title{color:#303c35;font-size:14px;letter-spacing:0}.twsp-prompt-title:hover{color:#a9671c}.twsp-prompt-role{border:0;border-radius:7px;background:#f6efe4;color:#93612d;font-size:11px}.twsp-prompt-role[data-role="user"],.twsp-prompt-role[data-role="assistant"]{border:0;color:#93612d}.twsp-prompt-size{color:#8d948f;font-size:11px}.twsp-prompt-icon{min-width:34px;min-height:38px;width:34px;height:38px;color:#737e75}.twsp-prompt-icon:hover{color:#a9671c}.twsp-prompt-drag{color:#9ca39e}.twsp-switch{min-width:46px;min-height:44px;width:46px;height:44px}.twsp-switch input{width:42px;height:24px;border-color:#d3d4ce;background:#d3d4ce}.twsp-switch input:before{width:18px;height:18px;margin:2px;background:#fff}.twsp-switch input:checked{border-color:#72a47b;background:#72a47b}.twsp-switch input:checked:before{transform:translateX(18px);background:#fff}
      .twsp-prompt-editor{border-top-color:#ebe5dc;background:#fff}.twsp-prompt-editor .twsp-input{min-height:44px;border-color:#e6e4dd;color:#39413b;background:#faf9f6;font-size:14px}.twsp-prompt-content{min-height:160px}.twsp-prompt-hint,.twsp-prompt-flag{color:#7d8781;font-size:12px}.twsp-prompt-advanced-button{color:#a9671c;font-size:12px}.twsp-prompt-advanced-grid{border-top-color:#ebe5dc}.twsp-prompt-flag input{accent-color:#a9671c}.twsp-add-prompt{border-color:#cda978;color:#a9671c;font-size:13px}.twsp-preset-actions{border-top-color:#e9e3da}.twsp-delete-overlay{background:#1419198c}.twsp-delete-dialog{border:1px solid #e9e3da;border-radius:18px;overflow:hidden;color:#303c35;background:#fff;box-shadow:0 24px 65px #211b1530}.twsp-delete-dialog-header{border-bottom-color:#e9e3da;background:#faf8f3;color:#303c35;font-weight:700}
      @media(max-width:720px){.twsp-head{padding:16px}.twsp-tabs{padding:0 12px 12px;overflow-x:auto;flex-wrap:nowrap}.twsp-panel{padding:21px 16px}.twsp-page-title{font-size:24px}.twsp-prompt-meta{width:auto;grid-template-columns:auto auto auto auto auto}.twsp-prompt-icon{min-width:34px}.twsp-preset-toolbar{align-items:flex-start}.twsp-dialog{border-radius:18px}}
      @media(max-width:520px){.twsp-shell{padding:0}.twsp-page-heading{align-items:flex-start;flex-wrap:wrap}.twsp-result-card{padding:16px}.twsp-outline-meta{gap:8px 14px}.twsp-actions{justify-content:flex-start}.twsp-prompt-fields,.twsp-prompt-fields--position,.twsp-prompt-advanced-grid{grid-template-columns:1fr}}

      /* Warm visual system shared by every panel. */
      .twsp-dialog{
        --twsp-bg:#faf8f4;--twsp-surface:#fff;--twsp-ink:#26312d;--twsp-muted:#5d6962;
        --twsp-faint:#68756d;--twsp-border:#e9e2d8;--twsp-brand:#995d19;--twsp-brand-hover:#824d14;
        --twsp-soft:#faf7f2;--twsp-green:#e8f0e8;--twsp-green-ink:#416148;
        width:min(1080px,calc(100vw - 24px));border-color:var(--twsp-border);background:var(--twsp-bg);color:var(--twsp-ink)
      }
      .twsp-shell{font:16px/1.55 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
      .twsp-head{padding:24px 34px 18px}.twsp-brand{display:flex;align-items:center;gap:15px;min-width:0}
      .twsp-brand-mark{display:grid;place-items:center;flex:none;width:54px;height:54px;border-radius:18px;background:#eedbb8;color:#8d5b21}
      .twsp-brand-mark svg{width:26px;height:26px;fill:currentColor;stroke:none}
      .twsp-title{font-size:23px;line-height:1.25;font-weight:700}.twsp-head-subtitle{margin-top:2px;color:var(--twsp-muted);font-size:13px}
      .twsp-activation{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;min-height:42px;border-color:var(--twsp-border);font-size:13px;white-space:nowrap}
      .twsp-activation[data-enabled="true"]{border-color:#dfe9df;background:var(--twsp-green);color:var(--twsp-green-ink)}
      .twsp-activation[data-enabled="true"]:before{content:"";width:8px;height:8px;border-radius:50%;background:#5d9b68}
      .twsp-close{border:0;background:#efede8;color:#64706a}
      .twsp-tabs{gap:5px;padding:0 34px 17px;border-bottom:1px solid var(--twsp-border)}
      .twsp-tab{display:inline-flex;align-items:center;gap:10px;padding:10px 20px;min-height:46px;color:#64726d;font-size:15px}
      .twsp-inline-icon{display:inline-flex;align-items:center;justify-content:center;flex:none}
      .twsp-inline-icon svg,.twsp-section-chevron svg,.twsp-history-chevron svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
      .twsp-panel{padding:38px 36px 34px}.twsp-page-heading{min-height:88px;margin-bottom:30px}
      .twsp-eyebrow{display:block;margin-bottom:7px;color:var(--twsp-brand);font-size:11px;font-weight:750;letter-spacing:.18em}
      .twsp-page-title{font-size:32px;font-weight:700;line-height:1.2}.twsp-page-description{margin-top:6px;color:var(--twsp-muted);font-size:14px}
      .twsp-version{align-self:center;background:#f3e6d5;color:var(--twsp-brand);font-size:12px}
      .twsp-button,.twsp-close,.twsp-tab,.twsp-preset-menu-action{touch-action:manipulation}
      .twsp-button{padding:10px 16px;border-color:var(--twsp-border);color:#655e53;font-weight:650}
      .twsp-button--primary{padding:11px 20px;border-color:var(--twsp-brand);background:var(--twsp-brand);color:#fff}
      .twsp-button--primary:hover{background:var(--twsp-brand-hover)}
      .twsp-button:disabled{opacity:.48}.twsp-field{gap:7px;color:#6b7871;font-size:13px;font-weight:650}
      .twsp-field .twsp-hint{font-weight:400}.twsp-input{min-height:48px;border-color:#e5e1da;background:var(--twsp-soft);color:var(--twsp-ink);font-size:15px}
      .twsp-input[data-tw-field="key"]::placeholder{color:#68756e;opacity:1;letter-spacing:.12em}
      .twsp-input:focus{border-color:#bd8a4f}.twsp-raw{color:#536058;font-size:14px;line-height:1.7}
      .twsp-hint{color:var(--twsp-muted)}.twsp-error{color:#a43e32}

      .twsp-result-card{padding:28px 30px;margin:18px 0 0;border-radius:26px;box-shadow:0 12px 34px #5845360d}
      .twsp-result-top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:22px}
      .twsp-result-state{display:inline-flex;padding:6px 12px;border-radius:999px;background:#f9ecd7;color:#98601e;font-size:12px;font-weight:750}
      .twsp-result-source{color:var(--twsp-faint);font-size:12px;text-align:right}
      .twsp-result-card .twsp-outline{padding:0;background:transparent}
      .twsp-outline{background:var(--twsp-soft);border-radius:16px}
      .twsp-result-card .twsp-outline-meta{margin:0 0 22px}.twsp-outline-meta-item{gap:8px;color:#64716a;font-size:13px}
      .twsp-outline-meta-item svg{width:16px;height:16px;color:#a9855f}
      .twsp-outline-event-box{padding:20px 23px;border-radius:16px;background:var(--twsp-soft)}
      .twsp-outline-event-label{margin-bottom:8px;color:#925b1f;font-size:13px}
      .twsp-outline-event{font-size:17px;line-height:1.9;font-weight:500}
      .twsp-outline>details{margin-top:22px;padding-top:15px;border-color:var(--twsp-border)}
      .twsp-outline>details summary{min-height:44px;text-align:right;font-size:13px;font-weight:700}
      .twsp-result-card .twsp-outline>details .twsp-raw{padding:12px;border-radius:10px;background:var(--twsp-soft)}
      .twsp-list-heading{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:32px 0 15px}
      .twsp-list-heading h4{margin:0;font-size:20px;font-weight:700}.twsp-list-heading .twsp-hint{font-size:13px}
      .twsp-history{gap:12px}.twsp-history-entry{border-radius:18px;box-shadow:none}
      .twsp-history-entry>summary{display:flex;align-items:center;gap:17px;padding:15px 18px;min-height:75px;font-weight:400}
      .twsp-history-number{display:grid;place-items:center;flex:none;width:42px;height:42px;border-radius:12px;background:#f3f0ea;color:#725c43;font-size:13px}
      .twsp-history-main{display:grid;flex:1;gap:4px;min-width:0}.twsp-history-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:650}
      .twsp-history-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--twsp-faint);font-size:12px}
      .twsp-history-state{padding:6px 10px;border-radius:999px;background:#edf2eb;color:#55715a;font-size:11px;white-space:nowrap}
      .twsp-history-chevron{color:#64716a}.twsp-history-entry[open] .twsp-history-chevron{transform:rotate(180deg)}
      .twsp-history-entry>p{padding:0 19px}.twsp-history-entry>.twsp-outline,.twsp-history-entry>.twsp-raw{margin:12px 19px 20px}

      .twsp-settings-section{padding:0;margin:12px 0;border-radius:20px;box-shadow:none}
      .twsp-settings-section>summary{display:flex;justify-content:space-between;align-items:center;min-height:72px;padding:18px 24px;font-size:16px;cursor:pointer}
      .twsp-settings-section-title{display:inline-flex;align-items:center;gap:12px}.twsp-settings-section-title .twsp-inline-icon{color:#b27a3b}
      .twsp-section-chevron{display:inline-flex;color:#64716a;transition:transform .18s ease}.twsp-settings-section[open] .twsp-section-chevron{transform:rotate(180deg)}
      .twsp-settings-section>.twsp-grid{margin:0;padding:4px 24px 24px}
      .twsp-settings-section .twsp-params-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .twsp-settings-section .twsp-advanced-grid{grid-column:1/-1}
      .twsp-advanced{margin:0 24px 16px;padding:0;border:0;background:transparent}
      .twsp-advanced .twsp-actions,.twsp-settings-section>.twsp-actions{justify-content:flex-start;margin:0;padding:0 24px 22px}
      .twsp-advanced .twsp-actions{padding:0}.twsp-settings-section>.twsp-hint{display:block;margin:10px 24px 14px;font-size:12px}
      .twsp-panel>.twsp-actions{margin-top:28px}.twsp-panel>[data-tw-view="checkStatus"]:empty{display:none}
      .twsp-panel>[data-tw-view="checkStatus"]{margin:14px 0 0}

      .twsp-preset-cards{display:grid;gap:12px;margin:0 0 10px}
      .twsp-preset-card{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:126px;padding:24px 28px;border-color:var(--twsp-border);border-radius:23px;box-shadow:none}
      .twsp-preset-card[data-selected="true"]{border-color:var(--twsp-border);background:var(--twsp-surface)}
      .twsp-preset-card-info{display:grid;gap:4px;flex:1;min-width:0}
      .twsp-preset-card-name{display:block;max-width:100%;min-height:44px;padding:0;overflow:hidden;text-overflow:ellipsis;color:var(--twsp-ink);font-size:18px;font-weight:650;white-space:nowrap}
      .twsp-preset-card-status{color:#526b57;font-size:13px}.twsp-preset-card-controls{display:flex;align-items:center;gap:10px;flex:none}
      .twsp-preset-card-controls>.twsp-button{min-width:104px}.twsp-preset-manage{position:relative}
      .twsp-preset-manage>summary{display:grid;place-items:center;min-width:64px;min-height:44px;padding:8px 12px;border:1px solid var(--twsp-border);border-radius:12px;color:#756e63;font-size:13px;font-weight:650;list-style:none;cursor:pointer}
      .twsp-preset-manage>summary::-webkit-details-marker{display:none}.twsp-preset-manage[open]>summary{background:var(--twsp-soft)}
      .twsp-preset-card-actions{position:absolute;z-index:5;top:calc(100% + 8px);right:0;display:grid;gap:3px;min-width:126px;padding:6px;border:1px solid var(--twsp-border);border-radius:13px;background:var(--twsp-surface);box-shadow:0 12px 30px #211b1520}
      .twsp-preset-manage:not([open]) .twsp-preset-card-actions{display:none}
      .twsp-preset-menu-action{min-height:44px;padding:8px 12px;border:0;border-radius:8px;background:transparent;color:var(--twsp-ink);text-align:left;font:inherit;font-size:13px;cursor:pointer}
      .twsp-preset-menu-action:hover{background:var(--twsp-soft)}.twsp-preset-menu-action.twsp-danger{color:#a43e32}
      .twsp-preset-editname{margin:12px 0 20px}.twsp-preset-compat{border-radius:15px;background:#fffbf4}
      .twsp-prompt-list-heading{margin-top:32px;margin-bottom:14px}.twsp-add-prompt{width:auto;min-height:44px;padding:8px 0;border:0;border-radius:0;color:var(--twsp-brand);background:transparent;font-size:14px;font-weight:700}
      .twsp-add-prompt:hover{background:transparent;color:var(--twsp-brand-hover)}
      .twsp-prompt-list{gap:12px;margin:0}.twsp-prompt-card{border-color:var(--twsp-border);border-radius:17px;background:var(--twsp-surface);box-shadow:none}
      .twsp-prompt-card[data-enabled="false"]{opacity:1;background:#f9f9f7}
      .twsp-prompt-head{display:flex;align-items:center;gap:16px;min-height:82px;padding:14px 18px}
      .twsp-prompt-drag{display:grid;place-items:center;flex:none;width:28px;height:44px;color:#80766b;opacity:1;cursor:grab}
      .twsp-prompt-drag svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:3;stroke-linecap:round}
      .twsp-prompt-heading-text{display:grid;gap:2px;flex:1;min-width:0}
      .twsp-prompt-title{min-height:44px;padding:0;color:var(--twsp-ink);font-size:15px;font-weight:650;letter-spacing:0}
      .twsp-prompt-subtitle{display:flex;align-items:center;gap:9px;color:var(--twsp-faint)}
      .twsp-prompt-role{min-width:0;padding:0;border:0;background:transparent;color:var(--twsp-faint);font:inherit;font-size:12px;letter-spacing:0;text-transform:capitalize}
      .twsp-prompt-role[data-role="user"],.twsp-prompt-role[data-role="assistant"]{color:var(--twsp-faint)}
      .twsp-prompt-size{width:auto;min-width:0;color:var(--twsp-faint);font-size:12px;text-align:left}
      .twsp-prompt-size:before{content:"·";margin-right:9px}.twsp-prompt-meta{display:flex;align-items:center;gap:9px;width:auto;flex:none}
      .twsp-switch{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:56px;width:auto;min-height:44px;height:44px}
      .twsp-switch input{position:absolute;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
      .twsp-switch input:focus-visible+.twsp-prompt-enabled-text{outline:2px solid var(--twsp-brand);outline-offset:2px}
      .twsp-prompt-enabled-text{display:inline-flex;align-items:center;justify-content:center;min-width:56px;padding:6px 10px;border-radius:999px;background:var(--twsp-green);color:var(--twsp-green-ink);font-size:12px;white-space:nowrap}
      .twsp-switch input:not(:checked)+.twsp-prompt-enabled-text{background:#e9e8e4;color:#6b736d}
      .twsp-prompt-expand{width:44px;height:44px;min-height:44px}.twsp-prompt-expand svg{width:17px;height:17px;transition:transform .18s ease}
      .twsp-prompt-card[data-expanded="true"] .twsp-prompt-expand svg{transform:rotate(180deg)}
      .twsp-prompt-editor{gap:18px;padding:22px;border-top-color:var(--twsp-border);background:var(--twsp-surface)}
      .twsp-prompt-fields,.twsp-prompt-fields--position{grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
      .twsp-prompt-editor .twsp-input{min-height:46px;border-color:#e5e1da;background:var(--twsp-soft);color:var(--twsp-ink);font-size:14px}
      .twsp-prompt-content{min-height:175px}.twsp-prompt-advanced-grid{border-color:var(--twsp-border)}
      .twsp-prompt-editor-actions{display:flex;align-items:center;justify-content:space-between;gap:10px}
      .twsp-prompt-advanced-button{min-height:44px;color:var(--twsp-brand);font-size:13px}
      .twsp-button--danger{border-color:#edd1cb;color:#a43e32;background:#fff7f5}
      .twsp-preset-actions{justify-content:flex-end;gap:10px;margin-top:22px;padding-top:0;border:0}
      .twsp-preset-footnote{margin-top:26px;font-size:12px}.twsp-panel>[data-tw-view="presetPreview"]{margin-top:14px;padding:14px;border-radius:12px;background:var(--twsp-surface)}
      .twsp-preset-manage>summary:focus-visible,.twsp-preset-menu-action:focus-visible,
      .twsp-settings-section>summary:focus-visible,.twsp-outline>details summary:focus-visible{outline:2px solid var(--twsp-brand);outline-offset:2px}

      @media(max-width:720px){
        .twsp-head{padding:18px}.twsp-brand-mark{width:46px;height:46px;border-radius:15px}.twsp-title{font-size:19px}
        .twsp-activation{margin-left:auto}.twsp-tabs{padding:0 13px 13px}.twsp-tab{padding:9px 14px}
        .twsp-panel{padding:25px 18px}.twsp-page-title{font-size:28px}.twsp-page-heading{min-height:0;margin-bottom:24px}
        .twsp-preset-card{padding:20px;min-height:110px}.twsp-prompt-head{gap:9px;padding:12px}
        .twsp-prompt-fields,.twsp-prompt-fields--position,.twsp-prompt-advanced-grid{grid-template-columns:1fr}
      }
      @media(max-width:520px){
        .twsp-head{gap:8px}.twsp-head-subtitle{display:none}.twsp-brand{gap:9px}.twsp-brand-mark{width:40px;height:40px}
        .twsp-activation{order:3;margin-left:0;min-height:38px;padding:7px 10px;font-size:12px}.twsp-close{margin-left:auto}
        .twsp-page-heading .twsp-button--primary{width:100%}.twsp-page-heading{align-items:flex-start}
        .twsp-result-card{padding:20px}.twsp-result-top{align-items:flex-start;flex-wrap:wrap}.twsp-outline-event-box{padding:16px}
        .twsp-history-main small{white-space:normal}.twsp-history-state{display:none}
        .twsp-settings-section>summary{padding:16px 18px}
        .twsp-settings-section>.twsp-grid{padding:4px 18px 20px}.twsp-settings-section .twsp-params-grid{grid-template-columns:1fr}
        .twsp-preset-card{align-items:flex-start;flex-wrap:wrap}.twsp-preset-card-controls{width:100%;justify-content:flex-end}
        .twsp-prompt-subtitle{gap:5px;flex-wrap:wrap}.twsp-prompt-meta{gap:2px}.twsp-prompt-drag{width:20px}
        .twsp-prompt-editor{padding:16px}.twsp-preset-actions{justify-content:flex-start}
      }
      .twsp-dialog [hidden]{display:none!important}
      .twsp-dialog [data-tw-view="planningTask"]:empty,.twsp-dialog [data-tw-view="error"]:empty,
      .twsp-dialog [data-tw-view="presetStatus"]:empty,.twsp-dialog [data-tw-view="presetPreview"]:empty{display:none}
    `;
    function element(tag, className = '', content = '') {
      const node = doc.createElement(tag);
      node.className = className;
      node.textContent = content;
      return node;
    }
    function mark(node, kind, value) {
      node.dataset[kind === 'field' ? 'twField' : kind === 'action' ? 'twAction' : 'twView'] = value;
      return node;
    }
    function button(label, action, className = 'twsp-button') {
      const node = mark(element('button', className, label), 'action', action);
      node.type = 'button';
      return node;
    }
    function icon(node, name) {
      if (typeof doc.createElementNS !== 'function') return node;
      const ns = 'http://www.w3.org/2000/svg';
      const svg = doc.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const paths = {
        pencil: ['M3 17.25V21h3.75L19.81 7.94l-3.75-3.75L3 17.25Z', 'm14.06 6.19 3.75 3.75'],
        trash: ['M3 6h18', 'M8 6V4h8v2', 'm5 6 1 14h12l1-14', 'M10 10v6', 'M14 10v6'],
        download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 19h16'],
        clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 7v5l3 2'],
        pin: ['M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z', 'M12 10a2 2 0 1 0 0 .01Z'],
        notebook: ['M7 3h13v18H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z', 'M4 7h4', 'M4 12h4', 'M4 17h4', 'm12-7 2 2-4 4-2 .5.5-2 3-3Z'],
        layers: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 12 9 5 9-5', 'm3 16 9 5 9-5'],
        sliders: ['M4 7h16', 'M4 17h16', 'M9 4v6', 'M15 14v6'],
        link: ['M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2', 'M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2'],
        sparkle: ['m12 2 1.9 7.1L21 11l-7.1 1.9L12 20l-1.9-7.1L3 11l7.1-1.9L12 2Z', 'm19 18 .5 1.5L21 20l-1.5.5L19 22l-.5-1.5L17 20l1.5-.5L19 18Z'],
        stethoscope: ['M6 3H4v6a6 6 0 0 0 12 0V3h-2', 'M10 15v2a4 4 0 0 0 8 0v-2', 'M18 15a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'],
        chevron: ['m6 9 6 6 6-6'],
        grip: ['M9 5h.01', 'M15 5h.01', 'M9 12h.01', 'M15 12h.01', 'M9 19h.01', 'M15 19h.01'],
      }[name] ?? [];
      for (const d of paths) { const path = doc.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
      node.replaceChildren(svg); return node;
    }
    function inlineIcon(name, className = 'twsp-inline-icon') { return icon(element('span', className), name); }
    function outlineParts(body) {
      const raw = String(body ?? '');
      const match = raw.match(/^\s*时间\s*[:：]\s*([\s\S]*?)\n\s*地点\s*[:：]\s*([\s\S]*?)\n\s*事件内容\s*[:：]\s*([\s\S]*)$/);
      return match && match[3].trim() ? { raw, time: match[1].trim(), place: match[2].trim(), event: match[3].trim() } : null;
    }
    function outlineCard(body) {
      const parts = outlineParts(body);
      if (!parts) return element('pre', 'twsp-raw', String(body ?? ''));
      const card = element('div', 'twsp-outline');
      const meta = element('div', 'twsp-outline-meta');
      for (const [name, value, symbol] of [['时间', parts.time, 'clock'], ['地点', parts.place, 'pin']]) {
        const item = element('div', 'twsp-outline-meta-item');
        item.append(icon(element('span'), symbol), element('span', '', value.trim() || '未注明'));
        item.setAttribute('aria-label', `${name}：${value.trim() || '未注明'}`);
        meta.append(item);
      }
      const label = element('span', 'twsp-outline-event-label', '事件内容');
      const event = element('p', 'twsp-outline-event', parts.event);
      const eventBox = element('div', 'twsp-outline-event-box');
      eventBox.append(label, event);
      const original = element('details');
      original.append(element('summary', '', '查看原文'), element('pre', 'twsp-raw', parts.raw));
      card.append(meta, eventBox, original);
      return card;
    }
    function field(label, name, type = 'text') {
      const wrapper = element('label', 'twsp-field');
      wrapper.append(element('span', '', label));
      const input = mark(element('input', 'twsp-input'), 'field', name);
      input.type = type;
      wrapper.append(input);
      return { wrapper, input };
    }
    const shell = element('div', 'twsp-shell');
    const header = element('header', 'twsp-head');
    const title = element('h2', 'twsp-title', '剧情规划器');
    title.id = 'tw-story-planner-title-v1';
    const brand = element('div', 'twsp-brand');
    const brandText = element('div');
    brandText.append(title, element('small', 'twsp-head-subtitle', '让故事的下一步更清晰'));
    brand.append(inlineIcon('sparkle', 'twsp-brand-mark'), brandText);
    const closeButton = button('×', 'close', 'twsp-close');
    closeButton.setAttribute('aria-label', '关闭剧情规划器');
    const toggleEnabledButton = button('开启规划器', 'toggleEnabled', 'twsp-button twsp-activation');
    toggleEnabledButton.setAttribute('aria-label', '开启剧情规划器');
    header.append(brand, toggleEnabledButton, closeButton);
    const tabs = element('div', 'twsp-tabs');
    tabs.setAttribute('role', 'tablist');
    const resultTab = button('规划结果', 'tab-result', 'twsp-tab');
    const settingsTab = button('设置', 'tab-settings', 'twsp-tab');
    const presetsTab = button('预设', 'tab-presets', 'twsp-tab');
    resultTab.setAttribute('role', 'tab');
    settingsTab.setAttribute('role', 'tab');
    presetsTab.setAttribute('role', 'tab');
    for (const [tab, label, symbol] of [[resultTab, '规划结果', 'notebook'], [presetsTab, '预设', 'layers'], [settingsTab, '设置', 'sliders']]) {
      tab.replaceChildren(inlineIcon(symbol), element('span', '', label));
    }
    tabs.append(resultTab, presetsTab, settingsTab);
    const resultPanel = element('section', 'twsp-panel');
    resultPanel.setAttribute('role', 'tabpanel');
    resultPanel.id = 'twsp-result-panel';
    resultTab.setAttribute('aria-controls', resultPanel.id);
    const resultHeading = element('div', 'twsp-page-heading');
    const resultHeadingText = element('div');
    resultHeadingText.append(element('span', 'twsp-eyebrow', 'STORY OUTLINE'), element('h3', 'twsp-page-title', '规划结果'), element('p', 'twsp-page-description', '当前细纲与本聊天的规划记录'));
    const statusLine = element('div', 'twsp-statusline');
    const statusBadge = mark(element('span', 'twsp-badge'), 'view', 'status');
    statusBadge.setAttribute('role', 'status');
    const updatedAt = mark(element('span'), 'view', 'updatedAt');
    const activationHint = mark(element('span', 'twsp-hint'), 'view', 'activationHint');
    statusLine.append(statusBadge, updatedAt, activationHint);
    const outlineBody = mark(element('div', 'twsp-result-card'), 'view', 'outlineBody');
    const historyList = mark(element('div', 'twsp-history'), 'view', 'outlineHistory');
    const historyHeading = element('div', 'twsp-list-heading');
    const historyTitle = element('h4', '', '历史记录');
    const historyCount = element('span', 'twsp-hint');
    historyHeading.append(historyTitle, historyCount);
    const taskStatus = mark(element('p', 'twsp-hint'), 'view', 'planningTask');
    let historyStamp = null;
    let featureStamp = null;
    const resultError = mark(element('p', 'twsp-error'), 'view', 'error');
    resultError.setAttribute('role', 'alert');
    const runButton = button('立即规划', 'run', 'twsp-button twsp-button--primary');
    resultHeading.append(resultHeadingText, runButton);
    const retrySaveButton = button('重试保存细纲', 'retrySave');
    resultPanel.append(resultHeading, taskStatus, statusLine, outlineBody, historyHeading, historyList, resultError, retrySaveButton);
    const settingsPanel = element('section', 'twsp-panel');
    settingsPanel.setAttribute('role', 'tabpanel');
    settingsPanel.id = 'twsp-settings-panel';
    settingsTab.setAttribute('aria-controls', settingsPanel.id);
    const settingsHeading = element('div', 'twsp-page-heading');
    const settingsHeadingText = element('div');
    settingsHeadingText.append(element('span', 'twsp-eyebrow', 'PREFERENCES'), element('h3', 'twsp-page-title', '设置'), element('p', 'twsp-page-description', '连接模型并调整规划方式'));
    settingsHeading.append(settingsHeadingText, element('span', 'twsp-version', options.version ? `v${options.version}` : ''));
    const grid = element('div', 'twsp-grid');
    const apiurl = field('API 地址', 'apiurl', 'url');
    apiurl.wrapper.className += ' twsp-wide';
    const key = field('API 密钥（留空保留已保存密钥）', 'key', 'password');
    key.wrapper.className += ' twsp-wide';
    const model = field('模型名称', 'model');
    const modelRow = element('div', 'twsp-model-row');
    const fetchButton = button('获取模型', 'fetchModels');
    modelRow.append(model.wrapper, fetchButton);
    const modelOptions = mark(element('select', 'twsp-input'), 'field', 'modelOptions');
    modelOptions.hidden = true;
    modelOptions.setAttribute('aria-label', '选择获取到的模型');
    const timeout = field('请求超时（秒）', 'timeoutSeconds', 'number');
    timeout.input.min = '1'; timeout.input.max = '600'; timeout.input.step = '1';
    timeout.wrapper.append(element('small', 'twsp-hint', '本轮、下一轮及补救任务均共用此总时限，包含重试与等待。'));
    const retryCount = field('失败重试次数', 'retryCount', 'number');
    retryCount.input.min = '0'; retryCount.input.max = '10'; retryCount.input.step = '1';
    retryCount.wrapper.append(element('small', 'twsp-hint', '首次请求之外的重试次数；0 表示不自动重试。'));
    const fieldErrors = {};
    for (const [name, control] of [['apiurl', apiurl], ['model', model]]) {
      const errorNode = element('small', 'twsp-error');
      control.wrapper.append(errorNode);
      fieldErrors[name] = errorNode;
    }
    const maxTokens = field('最大 token（回复上限）', 'maxTokens', 'number');
    const temperature = field('温度', 'temperature', 'number');
    maxTokens.input.min = '1'; maxTokens.input.max = '65535'; maxTokens.input.step = '1';
    temperature.input.min = '0'; temperature.input.max = '2'; temperature.input.step = '0.1';
    const parameterRow = element('div', 'twsp-grid twsp-advanced-grid');
    parameterRow.append(temperature.wrapper, maxTokens.wrapper);
    grid.append(apiurl.wrapper, key.wrapper, modelRow, modelOptions);
    const paramsGrid = element('div', 'twsp-grid twsp-params-grid');
    paramsGrid.append(timeout.wrapper, retryCount.wrapper, parameterRow);
    const advanced = element('div', 'twsp-advanced');
    const keyStatus = mark(element('p', 'twsp-hint'), 'view', 'keyStatus');
    const checkStatus = mark(element('p', 'twsp-hint'), 'view', 'checkStatus');
    checkStatus.setAttribute('role', 'status');
    const settingsActions = element('div', 'twsp-actions');
    const advancedActions = element('div', 'twsp-actions');
    const checkButton = button('检查配置', 'check');
    const testButton = button('测试连接', 'test');
    const toolProbeButton = button('测试工具调用', 'toolProbe');
    const clearKeyButton = button('清除密钥', 'clearKey');
    const saveButton = button('保存配置', 'save', 'twsp-button twsp-button--primary');
    advancedActions.append(checkButton, clearKeyButton);
    advanced.append(advancedActions);
    settingsActions.append(saveButton);
    function settingsSection(label, symbol, opened = false) {
      const section = element('details', 'twsp-settings-section');
      section.open = opened;
      const summary = element('summary');
      const heading = element('span', 'twsp-settings-section-title');
      heading.append(inlineIcon(symbol), element('span', '', label));
      summary.append(heading, inlineIcon('chevron', 'twsp-section-chevron'));
      section.append(summary);
      return section;
    }
    const connectionSection = settingsSection('连接配置', 'link', true);
    connectionSection.append(grid);
    const parametersSection = settingsSection('生成参数', 'sparkle');
    parametersSection.append(paramsGrid);
    const diagnosticsSection = settingsSection('连接与诊断', 'stethoscope');
    const diagnosticActions = element('div', 'twsp-actions');
    diagnosticActions.append(testButton, toolProbeButton);
    diagnosticsSection.append(advanced, keyStatus, element('p', 'twsp-hint', '连接信息保存在酒馆扩展设置中；导出前请检查是否包含数据。'), diagnosticActions);
    settingsPanel.append(settingsHeading, connectionSection, parametersSection, diagnosticsSection, checkStatus, settingsActions);
    const presetsPanel = element('section', 'twsp-panel');
    presetsPanel.id = 'twsp-presets-panel'; presetsPanel.setAttribute('role', 'tabpanel');
    presetsTab.setAttribute('aria-controls', presetsPanel.id);
    const presetsHeading = element('div', 'twsp-page-heading');
    const presetsHeadingText = element('div');
    presetsHeadingText.append(element('span', 'twsp-eyebrow', 'WRITING PRESETS'), element('h3', 'twsp-page-title', '预设'), element('p', 'twsp-page-description', '整理规划时使用的提示词'));
    presetsHeading.append(presetsHeadingText);
    const presetSelect = mark(element('select', 'twsp-input'), 'field', 'presetSelect');
    presetSelect.hidden = true;
    const presetName = field('预设名称', 'presetName');
    presetName.wrapper.className += ' twsp-preset-editname';
    presetName.wrapper.hidden = true;
    const presetCards = mark(element('div', 'twsp-preset-cards'), 'view', 'presetCards');
    const presetCompatibility = mark(element('div', 'twsp-preset-compat'), 'view', 'presetCompatibility');
    const presetRows = element('div', 'twsp-prompt-list');
    const presetStatus = mark(element('p', 'twsp-hint'), 'view', 'presetStatus');
    presetStatus.setAttribute('role', 'status');
    const presetPreview = mark(element('pre', 'twsp-raw'), 'view', 'presetPreview');
    const importInput = mark(element('input', 'twsp-input'), 'field', 'importPreset');
    importInput.type = 'file'; importInput.accept = '.json,application/json';
    importInput.multiple = true;
    const importPresetButton = button('导入预设', 'importPresetButton');
    const presetActions = element('div', 'twsp-actions twsp-preset-actions');
    const newPresetButton = button('新建', 'newPreset');
    const addPromptButton = button('新增 Prompt', 'addPrompt');
    const checkPresetButton = button('检查预设', 'checkPreset');
    const previewPresetButton = button('模拟发送预览', 'previewPreset');
    const copyCurrentPromptButton = button('复制提示词正文', 'copyCurrentPrompt');
    const savePresetButton = button('保存预设', 'savePreset', 'twsp-button twsp-button--primary');
    presetActions.append(checkPresetButton, previewPresetButton, copyCurrentPromptButton, savePresetButton);
    newPresetButton.textContent = '＋ 新建预设';
    newPresetButton.className = 'twsp-button twsp-button--primary';
    presetsHeading.append(newPresetButton);
    addPromptButton.textContent = '＋ 新增 Prompt';
    addPromptButton.className += ' twsp-add-prompt';
    const promptSectionHeading = element('div', 'twsp-list-heading twsp-prompt-list-heading');
    promptSectionHeading.append(element('h4', '', '提示词'), addPromptButton);
    const presetSelectLabel = element('label', 'twsp-field');
    presetSelectLabel.className += ' twsp-preset-internal';
    presetSelectLabel.append(element('span', '', '当前预设'), presetSelect);
    presetSelectLabel.hidden = true;
    const importLabel = element('label', 'twsp-preset-import');
    importLabel.append(element('span', '', '导入 Chat Completion 预设 JSON'), importInput);
    presetsPanel.append(presetsHeading, presetCards, presetSelectLabel, importLabel, presetName.wrapper, presetCompatibility, promptSectionHeading, presetRows, presetActions, presetStatus, presetPreview,
      element('p', 'twsp-hint twsp-preset-footnote', '独立预设；温度与最大 token 以设置页为准。'));
    shell.append(header, tabs, resultPanel, settingsPanel, presetsPanel);
    root.append(style, shell);
    doc.body.append(root);
    let activeTab = 'result';
    let presetState = structuredClone(options.getPresetState?.() ?? normalizePlannerPresetState({}));
    let presetDraft = presetState.plannerPresets.find(item => item.id === presetState.activePlannerPresetId) ?? presetState.plannerPresets[0];
    const expandedPromptIds = new Set();
    const expandedAdvancedIds = new Set();
    let draggingPromptId = null;
    let presetDirty = false;
    let previewStamp = null;
    let previewContextHash = null;
    let lastPreviewCheck = 0;
    let refreshTimer = null;
    let testing = false;
    function showTab(name) {
      activeTab = name;
      resultPanel.hidden = name !== 'result';
      settingsPanel.hidden = name !== 'settings';
      presetsPanel.hidden = name !== 'presets';
      resultTab.setAttribute('aria-selected', String(name === 'result'));
      settingsTab.setAttribute('aria-selected', String(name === 'settings'));
      presetsTab.setAttribute('aria-selected', String(name === 'presets'));
      resultTab.setAttribute('tabindex', name === 'result' ? '0' : '-1');
      settingsTab.setAttribute('tabindex', name === 'settings' ? '0' : '-1');
      presetsTab.setAttribute('tabindex', name === 'presets' ? '0' : '-1');
    }
    function markPresetDirty() {
      presetDirty = true;
      if (previewStamp) { presetStatus.textContent = '预览已过期；保存后重新查看发送内容。'; previewStamp = null; }
    }
    function invalidatePreview() {
      if (previewStamp) { previewStamp = null; presetStatus.textContent = '发送预览已过期；请重新查看。'; }
    }
    function selectPresetById(id) {
      if (id === presetDraft.id) return true;
      if (presetDirty) { presetStatus.textContent = '当前草稿未保存，请先保存再切换。'; return false; }
      const next = presetState.plannerPresets.find(item => item.id === id);
      if (!next) return false;
      presetState.activePlannerPresetId = id;
      try { presetState = options.savePresetState(presetState); }
      catch (error) { presetStatus.textContent = `切换失败：${error.message}`; return false; }
      presetDraft = presetState.plannerPresets.find(item => item.id === id) ?? next;
      expandedPromptIds.clear(); expandedAdvancedIds.clear(); presetName.wrapper.hidden = true;
      invalidatePreview(); renderPresetEditor(); render(false); return true;
    }
    function deletePresetById(id) {
      const target = presetState.plannerPresets.find(item => item.id === id);
      if (!target) return;
      if (presetDirty) { presetStatus.textContent = '当前草稿未保存，请先保存再删除。'; return; }
      if (presetState.plannerPresets.length <= 1) { presetStatus.textContent = '至少保留一份预设。'; return; }
      const overlay = mark(element('div', 'twsp-delete-overlay'), 'view', 'deletePresetDialog');
      overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
      const dialog = element('section', 'twsp-delete-dialog');
      const heading = element('header', 'twsp-delete-dialog-header', '确认删除');
      const body = element('div', 'twsp-delete-dialog-body');
      body.append(element('p', '', `确定删除预设“${target.name}”吗？`));
      const actions = element('div', 'twsp-delete-dialog-actions');
      const cancel = button('取消', 'cancelDeletePreset');
      const confirm = button('确认删除', 'confirmDeletePreset', 'twsp-button twsp-button--primary');
      cancel.addEventListener('click', () => overlay.remove());
      confirm.addEventListener('click', () => {
        const next = structuredClone(presetState);
        next.plannerPresets = next.plannerPresets.filter(item => item.id !== id);
        if (next.activePlannerPresetId === id) next.activePlannerPresetId = next.plannerPresets[0].id;
        try { presetState = options.savePresetState(next); }
        catch (error) { presetStatus.textContent = `删除失败：${error.message}`; return; }
        presetDraft = presetState.plannerPresets.find(item => item.id === presetState.activePlannerPresetId);
        expandedPromptIds.clear(); expandedAdvancedIds.clear(); presetName.wrapper.hidden = true;
        invalidatePreview(); renderPresetEditor(); render(false); overlay.remove(); presetStatus.textContent = '预设已删除。';
      });
      actions.append(cancel, confirm); body.append(actions); dialog.append(heading, body); overlay.append(dialog); root.append(overlay);
    }
    function downloadPreset(preset) {
      const content = JSON.stringify(exportPlannerPreset(preset), null, 2);
      const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
      const anchor = doc.createElement('a'); anchor.href = url; anchor.download = `${preset.name || 'planner-preset'}.json`;
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function renderPresetEditor() {
      presetSelect.replaceChildren();
      presetCards.replaceChildren();
      presetCompatibility.replaceChildren();
      const spreset = getSPresetSettings(presetDraft);
      if (spreset.present) {
        presetCompatibility.append(element('p', '', `SPreset · ${spreset.summary}`));
        for (const diagnostic of spreset.diagnostics) presetCompatibility.append(element('p', '', diagnostic));
      }
      let selectedStatus = null;
      const countEnabledPrompts = preset => preset.promptOrder.filter(order => {
        const prompt = preset.prompts.find(value => value.identifier === order.identifier);
        return order.enabled !== false && prompt && prompt.enabled !== false;
      }).length;
      const orderedPresets = [presetDraft, ...presetState.plannerPresets.filter(item => item.id !== presetDraft.id)];
      for (const item of orderedPresets) {
        const option = element('option', '', item.name); option.value = item.id; presetSelect.append(option);
        const card = element('article', 'twsp-preset-card');
        const selected = item.id === presetDraft.id;
        card.dataset.selected = String(selected);
        card.setAttribute('aria-current', String(selected));
        const info = element('div', 'twsp-preset-card-info');
        info.append(element('span', 'twsp-card-caption', selected ? '当前预设' : '其他预设'));
        const name = button(item.name, `presetCardName-${item.id}`, 'twsp-preset-card-name');
        const enabledCount = countEnabledPrompts(item);
        const status = element('small', 'twsp-preset-card-status', `${selected ? '当前使用' : '可切换'} · ${enabledCount} 条提示词已启用`);
        if (selected) selectedStatus = status;
        info.append(name, status);
        const controls = element('div', 'twsp-preset-card-controls');
        if (selected) controls.append(importPresetButton);
        else {
          const choose = button('切换', `selectPreset-${item.id}`);
          choose.setAttribute('aria-label', `选择预设 ${item.name}`);
          choose.addEventListener('click', () => selectPresetById(item.id));
          controls.append(choose);
        }
        const manage = element('details', 'twsp-preset-manage');
        const manageSummary = element('summary', '', '管理');
        manageSummary.setAttribute('aria-label', `管理预设 ${item.name}`);
        const actions = element('div', 'twsp-preset-card-actions');
        const exportCard = button('导出', `exportPreset-${item.id}`, 'twsp-preset-menu-action');
        const editCard = button('重命名', `editPreset-${item.id}`, 'twsp-preset-menu-action');
        const deleteCard = button('删除', `deletePreset-${item.id}`, 'twsp-preset-menu-action twsp-danger');
        name.addEventListener('click', () => selectPresetById(item.id));
        exportCard.addEventListener('click', () => downloadPreset(item));
        editCard.addEventListener('click', () => {
          if (item.id !== presetDraft.id && !selectPresetById(item.id)) return;
          presetName.wrapper.hidden = false; presetName.input.focus?.();
        });
        deleteCard.addEventListener('click', () => deletePresetById(item.id));
        actions.append(exportCard, editCard, deleteCard);
        manage.append(manageSummary, actions);
        controls.append(manage);
        card.append(info, controls); presetCards.append(card);
      }
      presetSelect.value = presetDraft.id;
      presetName.input.value = presetDraft.name;
      presetRows.replaceChildren();
      if (!presetDraft.promptOrder.length) {
        presetRows.append(mark(element('p', 'twsp-hint', '当前预设没有词块。可以导入预设，或点击“新增 Prompt”开始编辑。'), 'view', 'emptyPresetHint'));
      }
      for (const item of presetDraft.promptOrder) {
        const prompt = presetDraft.prompts.find(value => value.identifier === item.identifier);
        if (!prompt) continue;
        const row = mark(element('article', 'twsp-prompt-card'), 'view', 'promptCard-' + prompt.identifier);
        const effectiveEnabled = item.enabled !== false && prompt.enabled !== false;
        row.dataset.enabled = String(effectiveEnabled);
        row.addEventListener('dragover', event => event.preventDefault());
        row.addEventListener('drop', event => {
          event.preventDefault();
          const from = presetDraft.promptOrder.findIndex(value => value.identifier === draggingPromptId);
          const to = presetDraft.promptOrder.indexOf(item);
          draggingPromptId = null;
          if (from < 0 || to < 0 || from === to) return;
          const [moved] = presetDraft.promptOrder.splice(from, 1);
          presetDraft.promptOrder.splice(to, 0, moved);
          markPresetDirty(); renderPresetEditor();
        });
        const head = element('div', 'twsp-prompt-head');
        const drag = mark(inlineIcon('grip', 'twsp-prompt-drag'), 'action', 'drag-' + prompt.identifier);
        drag.draggable = true;
        drag.setAttribute('aria-label', `拖动排序 ${prompt.name ?? prompt.identifier}`);
        drag.addEventListener('dragstart', event => { draggingPromptId = prompt.identifier; event.dataTransfer?.setData('text/plain', prompt.identifier); });
        drag.addEventListener('dragend', () => { draggingPromptId = null; });
        const title = button(prompt.name || prompt.identifier, `title-${prompt.identifier}`, 'twsp-prompt-title');
        const badge = mark(element('span', 'twsp-prompt-role', (prompt.role ?? 'system').toUpperCase()), 'view', 'promptRoleBadge-' + prompt.identifier);
        badge.dataset.role = prompt.role ?? 'system';
        const enabledRow = element('label', 'twsp-switch');
        const enabledInput = mark(element('input'), 'field', 'promptEnabled-' + prompt.identifier);
        enabledInput.type = 'checkbox'; enabledInput.checked = effectiveEnabled;
        enabledInput.setAttribute('aria-label', `启用 ${prompt.name ?? prompt.identifier}`);
        const enabledText = element('span', 'twsp-prompt-enabled-text', effectiveEnabled ? '已启用' : '已停用');
        enabledInput.addEventListener('change', () => {
          item.enabled = enabledInput.checked; prompt.enabled = enabledInput.checked;
          enabledText.textContent = enabledInput.checked ? '已启用' : '已停用';
          if (selectedStatus) selectedStatus.textContent = `当前使用 · ${countEnabledPrompts(presetDraft)} 条提示词已启用`;
          row.dataset.enabled = String(enabledInput.checked); markPresetDirty();
        });
        enabledRow.append(enabledInput, enabledText);
        const size = element('span', 'twsp-prompt-size', `${(prompt.content ?? '').length} 字符`);
        size.setAttribute('title', '正文字符数');
        const edit = icon(button('展开', `edit-${prompt.identifier}`, 'twsp-prompt-icon twsp-prompt-expand'), 'chevron');
        edit.setAttribute('aria-label', `展开编辑 ${prompt.name ?? prompt.identifier}`);
        edit.setAttribute('aria-expanded', String(expandedPromptIds.has(prompt.identifier)));
        row.dataset.expanded = String(expandedPromptIds.has(prompt.identifier));
        const headingText = element('div', 'twsp-prompt-heading-text');
        const subtitle = element('div', 'twsp-prompt-subtitle');
        subtitle.append(badge, size);
        headingText.append(title, subtitle);
        const meta = element('div', 'twsp-prompt-meta');
        meta.append(enabledRow, edit);
        let remove = null;
        if (!prompt.marker) {
          remove = button('删除提示词', `remove-${prompt.identifier}`, 'twsp-button twsp-button--danger');
        }
        head.append(drag, headingText, meta);
        const editor = mark(element('div', 'twsp-prompt-editor'), 'view', 'promptEditor-' + prompt.identifier);
        editor.hidden = !expandedPromptIds.has(prompt.identifier);
        const identityFields = element('div', 'twsp-prompt-fields');
        const promptName = field('名称', 'promptName-' + prompt.identifier);
        promptName.input.value = prompt.name ?? '';
        promptName.input.addEventListener('input', () => {
          prompt.name = promptName.input.value; title.textContent = prompt.name || prompt.identifier; markPresetDirty();
        });
        const roleField = element('label', 'twsp-field');
        roleField.append(element('span', '', '角色'));
        const role = mark(element('select', 'twsp-input'), 'field', 'promptRole-' + prompt.identifier);
        for (const value of ['system', 'user', 'assistant']) { const option = element('option', '', value); option.value = value; role.append(option); }
        role.value = prompt.role ?? 'system';
        role.addEventListener('change', () => { prompt.role = role.value; badge.textContent = role.value.toUpperCase(); badge.dataset.role = role.value; markPresetDirty(); });
        roleField.append(role);
        const trigger = field('触发器', 'promptTrigger-' + prompt.identifier);
        trigger.input.value = Array.isArray(prompt.injection_trigger) ? prompt.injection_trigger.join(', ') : '';
        trigger.input.placeholder = 'All types (default)';
        trigger.wrapper.append(element('small', 'twsp-prompt-hint', '留空表示所有类型'));
        trigger.input.addEventListener('change', () => {
          prompt.injection_trigger = trigger.input.value.split(',').map(value => value.trim()).filter(Boolean);
          markPresetDirty();
        });
        identityFields.append(promptName.wrapper, roleField, trigger.wrapper);
        const positionFields = element('div', 'twsp-prompt-fields twsp-prompt-fields--position');
        const position = element('label', 'twsp-field');
        position.append(element('span', '', '位置'));
        const positionInput = mark(element('select', 'twsp-input'), 'field', 'promptPosition-' + prompt.identifier);
        for (const [value, label] of [['0', '相对'], ['1', '聊天中']]) {
          const option = element('option', '', label); option.value = value; positionInput.append(option);
        }
        positionInput.value = String(prompt.injection_position ?? 0);
        const syncPositionDetails = () => { for (const wrapper of [depth.wrapper, promptOrder.wrapper]) wrapper.hidden = Number(positionInput.value) !== 1; };
        positionInput.addEventListener('change', () => { prompt.injection_position = Number(positionInput.value) === 1 ? 1 : 0; syncPositionDetails(); markPresetDirty(); });
        position.append(positionInput); positionFields.append(position);
        const bodyField = element('label', 'twsp-field');
        bodyField.append(element('span', '', '提示词'));
        const body = mark(element('textarea', 'twsp-input'), 'field', 'promptContent-' + prompt.identifier); body.value = prompt.content ?? ''; body.rows = 4;
        body.className += ' twsp-prompt-content';
        body.readOnly = prompt.marker === true;
        body.addEventListener('input', () => {
          prompt.content = body.value; size.textContent = `${body.value.length} 字符`; markPresetDirty();
        });
        bodyField.append(body);
        const promptOrder = field('排序', 'promptOrder-' + prompt.identifier, 'number');
        promptOrder.input.value = String(prompt.injection_order ?? 100);
        promptOrder.input.addEventListener('change', () => { prompt.injection_order = Number(promptOrder.input.value) || 0; markPresetDirty(); });
        promptOrder.wrapper.className += ' twsp-position-detail';
        promptOrder.wrapper.append(element('small', 'twsp-prompt-hint', '数值越小越靠前'));
        const depth = field('深度', 'depth-' + prompt.identifier, 'number');
        depth.input.value = String(prompt.injection_depth ?? 4);
        depth.wrapper.className += ' twsp-position-detail';
        depth.wrapper.append(element('small', 'twsp-prompt-hint', '0 为最新消息之后，1 为最新消息之前'));
        depth.input.addEventListener('change', () => {
          prompt.injection_depth = Number(depth.input.value) || 0; prompt.injection_position = 1; positionInput.value = '1'; markPresetDirty();
        });
        positionFields.append(depth.wrapper, promptOrder.wrapper);
        syncPositionDetails();
        const advancedButton = button('展开高级属性', `advanced-${prompt.identifier}`, 'twsp-prompt-advanced-button');
        const advancedGrid = mark(element('div', 'twsp-prompt-advanced-grid'), 'view', 'promptAdvanced-' + prompt.identifier);
        advancedGrid.hidden = !expandedAdvancedIds.has(prompt.identifier);
        advancedButton.textContent = advancedGrid.hidden ? '展开高级属性' : '收起高级属性';
        advancedButton.addEventListener('click', () => {
          advancedGrid.hidden = !advancedGrid.hidden;
          advancedButton.textContent = advancedGrid.hidden ? '展开高级属性' : '收起高级属性';
          if (advancedGrid.hidden) expandedAdvancedIds.delete(prompt.identifier); else expandedAdvancedIds.add(prompt.identifier);
        });
        const identifier = field('内部标识符', 'promptIdentifier-' + prompt.identifier);
        identifier.input.value = prompt.identifier; identifier.input.readOnly = true;
        const makeFlag = (label, key, value, readOnly = false) => {
          const wrapper = element('label', 'twsp-prompt-flag');
          const input = mark(element('input'), 'field', key + '-' + prompt.identifier);
          input.type = 'checkbox'; input.checked = value; input.disabled = readOnly;
          if (!readOnly) input.addEventListener('change', () => { prompt[key === 'systemPrompt' ? 'system_prompt' : 'forbid_overrides'] = input.checked; markPresetDirty(); });
          wrapper.append(input, element('span', '', label)); return wrapper;
        };
        advancedGrid.append(identifier.wrapper,
          makeFlag('系统 Prompt', 'systemPrompt', prompt.system_prompt === true),
          makeFlag('禁止覆盖', 'forbidOverrides', prompt.forbid_overrides === true),
          makeFlag('Marker（运行时条目）', 'marker', prompt.marker === true, true));
        if (body.readOnly) editor.append(element('p', 'twsp-prompt-hint', '此 Prompt 内容由运行时生成'));
        const editorActions = element('div', 'twsp-prompt-editor-actions');
        editorActions.append(advancedButton);
        if (remove) editorActions.append(remove);
        editor.append(identityFields, positionFields, bodyField, editorActions, advancedGrid);
        if (remove) remove.addEventListener('click', () => {
          presetDraft.promptOrder = presetDraft.promptOrder.filter(value => value !== item);
          presetDraft.prompts = presetDraft.prompts.filter(value => value !== prompt);
          expandedPromptIds.delete(prompt.identifier); expandedAdvancedIds.delete(prompt.identifier);
          markPresetDirty(); renderPresetEditor();
        });
        const toggleEditor = () => {
          editor.hidden = !editor.hidden;
          if (editor.hidden) expandedPromptIds.delete(prompt.identifier); else expandedPromptIds.add(prompt.identifier);
          edit.setAttribute('aria-expanded', String(!editor.hidden));
          edit.setAttribute('aria-label', `${editor.hidden ? '展开编辑' : '收起编辑'} ${prompt.name ?? prompt.identifier}`);
          row.dataset.expanded = String(!editor.hidden);
        };
        edit.addEventListener('click', toggleEditor); title.addEventListener('click', toggleEditor);
        row.append(head, editor); presetRows.append(row);
      }
    }
    function showValidation(errors) {
      for (const [name, control] of [['apiurl', apiurl], ['model', model]]) {
        fieldErrors[name].textContent = errors[name] || '';
        control.input.setAttribute('aria-invalid', errors[name] ? 'true' : 'false');
      }
    }
    function draft() {
      return { enabled: options.getViewModel().config.enabled, apiurl: apiurl.input.value, key: key.input.value,
        model: model.input.value,
        timeoutSeconds: timeout.input.value, retryCount: retryCount.input.value, maxTokens: maxTokens.input.value,
        temperature: temperature.input.value };
    }
    function render(syncFields = false) {
      const view = options.getViewModel();
      toggleEnabledButton.textContent = view.config.enabled ? '规划器已开启' : '开启规划器';
      toggleEnabledButton.dataset.enabled = String(view.config.enabled);
      toggleEnabledButton.setAttribute('aria-pressed', String(view.config.enabled));
      toggleEnabledButton.setAttribute('aria-label', view.config.enabled ? '关闭剧情规划器' : '开启剧情规划器');
      statusBadge.textContent = view.statusLabel;
      statusBadge.dataset.status = view.status;
      activationHint.textContent = view.activationHint ?? '';
      updatedAt.textContent = view.updatedAt ? `更新：${view.updatedAt}` : '尚无规划记录';
      const history = view.outlineHistory ?? [];
      const available = history.filter(record => record.body);
      const currentRecord = available.findLast(record => ['ready', 'using'].includes(record.status)) ?? available.at(-1) ?? null;
      const shownBody = currentRecord?.body ?? view.outlineBody;
      const labels = { ready: '待使用', using: '本轮使用中', used: '已使用', invalid: '已失效', superseded: '已替换' };
      outlineBody.hidden = !shownBody;
      statusLine.hidden = Boolean(shownBody);
      const nextFeatureStamp = shownBody ? JSON.stringify([currentRecord?.id, currentRecord?.status, currentRecord?.sourceMessageId, currentRecord?.createdAt, view.statusLabel, view.updatedAt, shownBody]) : null;
      if (shownBody && nextFeatureStamp !== featureStamp) {
        const featureTop = element('div', 'twsp-result-top');
        featureTop.append(element('span', 'twsp-result-state', currentRecord ? labels[currentRecord.status] ?? currentRecord.status : view.statusLabel),
          element('span', 'twsp-result-source', currentRecord?.sourceMessageId == null ? (view.updatedAt ? `更新：${view.updatedAt}` : '') : `来源楼层 ${currentRecord.sourceMessageId}${currentRecord.createdAt ? ` · ${currentRecord.createdAt}` : ''}`));
        outlineBody.replaceChildren(featureTop, outlineCard(shownBody));
      } else if (!shownBody && featureStamp !== null) outlineBody.replaceChildren();
      featureStamp = nextFeatureStamp;
      const olderHistory = history.filter(record => record !== currentRecord);
      historyHeading.hidden = olderHistory.length === 0;
      historyCount.textContent = `${olderHistory.length} 条记录`;
      const nextStamp = JSON.stringify(history);
      if (nextStamp !== historyStamp) {
        const expanded = new Set(Array.from(historyList.children).filter(item => item.open).map(item => item.dataset.recordId));
        const entries = olderHistory.map(record => {
          const item = element('details', 'twsp-history-entry');
          item.dataset.recordId = record.id;
          item.open = expanded.has(record.id);
          const source = record.sourceMessageId == null ? '来源楼层未知' : `来源 #${record.sourceMessageId}`;
          const used = record.usedMessageId == null ? '使用楼层待确认' : `用于 #${record.usedMessageId}`;
          const parts = outlineParts(record.body);
          const summary = element('summary', 'twsp-history-summary');
          const main = element('span', 'twsp-history-main');
          main.append(element('strong', '', parts ? [parts.place, parts.time].filter(Boolean).join(' · ') || `细纲 ${record.sequence}` : `细纲 ${record.sequence}`),
            element('small', '', `${parts ? `事件内容：${parts.event.slice(0, 45)}${parts.event.length > 45 ? '…' : ''} · ` : ''}${source} → ${used}`));
          summary.append(element('span', 'twsp-history-number', String(record.sequence ?? '').padStart(2, '0')), main,
            element('span', 'twsp-history-state', labels[record.status] ?? record.status), inlineIcon('chevron', 'twsp-history-chevron'));
          item.append(summary,
            element('p', 'twsp-hint', `${record.purpose === 'initial' ? '初始规划' : record.purpose === 'legacy' ? '旧版本记录' : '下一轮规划'} · ${record.createdAt ?? ''}${record.invalidReason ? ` · ${record.invalidReason}` : ''}`),
            outlineCard(record.body));
          return item;
        });
        historyList.replaceChildren(...entries);
        historyStamp = nextStamp;
      }
      const task = view.lastTask;
      taskStatus.textContent = task ? `${task.purpose === 'next' ? '下一轮' : '本轮'}任务 · 来源 #${task.sourceMessageId} · 尝试 ${task.attempt}/${task.maxAttempts}${task.lastError ? ` · ${task.lastError}` : ''}` : '';
      resultError.textContent = [view.persistenceError ? `保存提示：${view.persistenceError}` : '',
        view.lastError ? `最近错误：${view.lastError}` : ''].filter(Boolean).join('；');
      retrySaveButton.hidden = !view.persistenceError;
      retrySaveButton.disabled = !view.persistenceError;
      runButton.disabled = Object.keys(view.configErrors).length > 0 || ['running', 'retrying'].includes(view.status) || view.presetReady === false;
      keyStatus.textContent = view.config.key ? '已保存密钥；圆点仅作遮罩提示，留空保存会继续使用该密钥。' : '尚未填写密钥；无密钥接口可留空。';
      key.input.placeholder = view.config.key ? '••••••••••••' : '请输入 API 密钥';
      if (activeTab === 'presets' && previewStamp && previewContextHash && Date.now() - lastPreviewCheck > 5000) {
        lastPreviewCheck = Date.now(); const stamp = previewStamp;
        Promise.resolve(options.checkPreviewFresh?.(previewContextHash)).then(current => { if (stamp === previewStamp && current === false) invalidatePreview(); }).catch(() => invalidatePreview());
      }
      if (syncFields) {
        apiurl.input.value = view.config.apiurl;
        key.input.value = '';
        model.input.value = view.config.model;
        timeout.input.value = String(view.config.timeoutSeconds);
        retryCount.input.value = String(view.config.retryCount ?? DEFAULT_CONFIG.retryCount);
        maxTokens.input.value = String(view.config.maxTokens);
        temperature.input.value = String(view.config.temperature);
      }
    }
    function stopRefresh() {
      if (refreshTimer !== null) { (options.clearInterval ?? clearInterval)(refreshTimer); refreshTimer = null; }
    }
    function close() {
      if (presetDirty && doc.defaultView?.confirm?.('预设草稿未保存。确定放弃修改并关闭吗？') !== true) {
        presetStatus.textContent = '预设草稿未保存；请保存后关闭。'; showTab('presets'); return;
      }
      stopRefresh();
      if (typeof root.close === 'function' && root.open) root.close();
      else { root.open = false; root.removeAttribute?.('open'); }
    }
    function open() {
      render(true);
      renderPresetEditor();
      showTab('result');
      if (typeof root.showModal === 'function' && !root.open) root.showModal();
      else { root.open = true; root.setAttribute('open', ''); }
      stopRefresh();
      refreshTimer = (options.setInterval ?? setInterval)(() => render(false), 700);
      closeButton.focus?.();
    }
    function destroy() { stopRefresh(); if (root.open && typeof root.close === 'function') root.close(); root.remove(); }
    resultTab.addEventListener('click', () => showTab('result'));
    settingsTab.addEventListener('click', () => showTab('settings'));
    presetsTab.addEventListener('click', () => showTab('presets'));
    presetName.input.addEventListener('input', () => {
      presetDraft.name = presetName.input.value;
      const visibleName = presetCards.querySelector(`[data-tw-action="presetCardName-${presetDraft.id}"]`);
      if (visibleName) visibleName.textContent = presetDraft.name;
      markPresetDirty();
    });
    presetSelect.addEventListener('change', () => { if (!selectPresetById(presetSelect.value)) presetSelect.value = presetDraft.id; });
    importPresetButton.addEventListener('click', () => importInput.click?.());
    newPresetButton.addEventListener('click', () => {
      if (presetDirty) { presetStatus.textContent = '当前草稿未保存，请先保存。'; return; }
      presetDraft = structuredClone(createDefaultPlannerPreset());
      presetDraft.id = `preset-${fnv1a(`${Date.now()}-${Math.random()}`)}`;
      presetDraft.name = '新剧情预设'; presetState.plannerPresets.push(presetDraft);
      presetState.activePlannerPresetId = presetDraft.id; markPresetDirty(); renderPresetEditor();
    });
    addPromptButton.addEventListener('click', () => {
      const identifier = `custom-${fnv1a(`${Date.now()}-${Math.random()}`)}`;
      presetDraft.prompts.push({ identifier, name: '新提示词', role: 'system', content: '', enabled: true,
        injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [],
        marker: false, system_prompt: false, forbid_overrides: false });
      presetDraft.promptOrder.push({ identifier, enabled: true }); markPresetDirty(); renderPresetEditor();
    });
    importInput.addEventListener('change', async () => {
      if (presetDirty) { presetStatus.textContent = '当前草稿未保存，请先保存再导入。'; return; }
      const files = Array.from(importInput.files ?? []);
      const importedPresets = []; const errors = [];
      for (const file of files) {
        try {
          const imported = importPlannerPreset(await file.text(), file.name);
          importedPresets.push(imported);
        } catch (error) { errors.push(`${file.name}：${error.message}`); }
      }
      importInput.value = '';
      if (importedPresets.length) {
        try {
          presetState = options.savePresetState({
            ...presetState,
            plannerPresets: [...presetState.plannerPresets, ...importedPresets],
            activePlannerPresetId: importedPresets[0].id,
          });
          presetDraft = presetState.plannerPresets.find(item => item.id === presetState.activePlannerPresetId);
          expandedPromptIds.clear(); expandedAdvancedIds.clear(); presetName.wrapper.hidden = true;
          invalidatePreview(); renderPresetEditor(); render(false);
        } catch (error) {
          presetStatus.textContent = `导入保存失败：${error.message}`; return;
        }
      }
      presetStatus.textContent = importedPresets.length
        ? `成功导入 ${importedPresets.length} 个预设。${errors.length ? `失败 ${errors.length} 个：${errors.join('；')}` : ''}`
        : errors.length ? `导入失败：${errors.join('；')}` : '';
    });
    savePresetButton.addEventListener('click', () => {
      try {
        presetState = options.savePresetState({ ...presetState, activePlannerPresetId: presetDraft.id });
        presetDraft = presetState.plannerPresets.find(item => item.id === presetState.activePlannerPresetId);
        presetDirty = false; previewStamp = null; presetPreview.textContent = '';
        presetStatus.textContent = '预设已保存，旧发送预览已过期。'; renderPresetEditor(); render(false);
      } catch (error) { presetStatus.textContent = `保存失败：${error.message}`; }
    });
    checkPresetButton.addEventListener('click', async () => {
      try { presetStatus.textContent = (await options.checkPreset(presetDraft)).join('；') || '预设检查通过。'; }
      catch (error) { presetStatus.textContent = `检查失败：${error.message}`; }
    });
    previewPresetButton.addEventListener('click', async () => {
      const stamp = `${Date.now()}-${Math.random()}`; previewStamp = stamp;
      presetStatus.textContent = '正在读取当前数据…';
      try {
        const result = await options.previewPreset(presetDraft);
        if (previewStamp !== stamp) return;
        previewContextHash = result.contextHash ?? null; lastPreviewCheck = Date.now();
        presetPreview.textContent = result.messages.length ? JSON.stringify(result.request, null, 2) : '';
        presetStatus.textContent = `${result.diagnostics.join('；') || '已组装当前提示词。'}；这是规划 API 的提示词与工具载荷，已省略 API 配置，未调用 API。`;
      } catch (error) { presetStatus.textContent = `预览失败：${error.message}`; }
    });
    copyCurrentPromptButton.addEventListener('click', async () => {
      presetStatus.textContent = '正在组装当前提示词…';
      try {
        const result = await options.previewPreset(presetDraft);
        if (!result.messages.length) {
          presetStatus.textContent = '当前预设没有可复制的提示词。';
          return;
        }
        const value = result.request.ordered_prompts.map(message => message.content).join('\n\n');
        const clipboard = doc.defaultView?.navigator?.clipboard;
        let copied = false;
        if (typeof clipboard?.writeText === 'function') {
          try { await clipboard.writeText(value); copied = true; }
          catch { /* The host may deny Clipboard API in an embedded panel. */ }
        }
        if (!copied && typeof doc.execCommand === 'function') {
          const fallback = doc.createElement('textarea');
          fallback.value = value;
          fallback.setAttribute('readonly', '');
          fallback.style.position = 'fixed';
          fallback.style.opacity = '0';
          doc.body.append(fallback);
          try {
            fallback.select();
            if (!doc.execCommand('copy')) throw new Error('复制命令未成功');
          } finally { fallback.remove(); }
          copied = true;
        }
        if (!copied) throw new Error('当前宿主无法写入剪贴板');
        presetStatus.textContent = `已复制提示词正文（实际换行，不含工具声明）；未请求 API。${result.diagnostics.length ? `检查提示：${result.diagnostics.join('；')}` : ''}`;
      } catch (error) {
        presetStatus.textContent = `复制失败：${error?.message ?? '剪贴板不可用'}`;
      }
    });
    modelOptions.addEventListener('change', () => { if (modelOptions.value) model.input.value = modelOptions.value; });
    const tabOrder = [['result', resultTab], ['presets', presetsTab], ['settings', settingsTab]];
    for (const [, tab] of tabOrder) tab.addEventListener('keydown', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const index = tabOrder.findIndex(([name]) => name === activeTab);
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabOrder.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabOrder.length) % tabOrder.length;
        showTab(tabOrder[nextIndex][0]);
        tabOrder[nextIndex][1].focus?.();
      }
    });
    closeButton.addEventListener('click', close);
    root.addEventListener('close', stopRefresh);
    root.addEventListener('cancel', event => { if (presetDirty) { event.preventDefault(); presetStatus.textContent = '预设草稿未保存；请保存后关闭。'; showTab('presets'); } });
    checkButton.addEventListener('click', () => {
      const errors = validateConfig(normalizeConfig(draft()));
      showValidation(errors);
      checkStatus.textContent = Object.keys(errors).length ? Object.values(errors).join('；') : '配置格式检查通过；服务是否支持该地址仍需真实请求确认。';
    });
    testButton.addEventListener('click', async () => {
      if (testing) return;
      const errors = validateConfig(normalizeConfig(draft()));
      showValidation(errors);
      if (Object.keys(errors).length) { checkStatus.textContent = Object.values(errors).join('；'); return; }
      testing = true;
      testButton.disabled = true;
      toolProbeButton.disabled = true;
      checkStatus.textContent = '正在测试 API 连接…';
      try { checkStatus.textContent = await options.testConnection(draft()); }
      catch { checkStatus.textContent = '连接测试失败。请检查地址、模型和密钥；具体请求错误不会显示，以免泄露密钥。'; }
      finally { testing = false; testButton.disabled = false; toolProbeButton.disabled = false; }
    });
    toolProbeButton.addEventListener('click', async () => {
      if (testing) return;
      const errors = validateConfig(normalizeConfig(draft()));
      showValidation(errors);
      if (Object.keys(errors).length) { checkStatus.textContent = Object.values(errors).join('；'); return; }
      if (typeof options.testToolCall !== 'function') {
        checkStatus.textContent = '当前版本没有工具调用探针；请更新剧情规划器扩展。';
        return;
      }
      testing = true;
      testButton.disabled = true;
      toolProbeButton.disabled = true;
      checkStatus.textContent = '正在比较三种工具选择格式，最多调用 API 三次…';
      try { checkStatus.textContent = await options.testToolCall(draft()); }
      catch { checkStatus.textContent = '工具调用探针失败；请查看控制台中的 [剧情规划器][诊断] 日志。'; }
      finally { testing = false; testButton.disabled = false; toolProbeButton.disabled = false; }
    });
    fetchButton.addEventListener('click', async () => {
      if (fetchButton.disabled) return;
      fetchButton.disabled = true;
      modelOptions.hidden = true;
      checkStatus.textContent = '正在获取模型…';
      const requested = draft();
      try {
        const result = await options.fetchModels(requested);
        if (requested.apiurl !== apiurl.input.value || requested.key !== key.input.value) {
          checkStatus.textContent = '连接信息已改变，旧模型列表作废。';
        } else if (result.ok) {
          modelOptions.textContent = '';
          const placeholder = element('option', '', `已获取 ${result.models.length} 个模型，点击选择`);
          placeholder.value = '';
          modelOptions.append(placeholder);
          for (const name of result.models) {
            const option = element('option', '', name);
            option.value = name;
            modelOptions.append(option);
          }
          modelOptions.value = '';
          modelOptions.hidden = false;
          checkStatus.textContent = `已获取 ${result.models.length} 个模型；也可继续手填模型名。`;
        } else checkStatus.textContent = result.error;
      } catch { checkStatus.textContent = '获取模型失败；请手填模型名。'; }
      finally { fetchButton.disabled = false; }
    });
    let configSaveRevision = 0;
    async function confirmConfigSave(incomplete = false) {
      const revision = ++configSaveRevision;
      checkStatus.textContent = '配置已更新，正在等待宿主保存结果。';
      try {
        const result = await options.persistConfig?.();
        if (revision !== configSaveRevision) return;
        const suffix = incomplete ? '连接字段尚不完整；请检查配置。' : '';
        checkStatus.textContent = `${result?.confirmed === true
          ? '设置保存已确认。' : '设置已提交，尚无落盘确认；请稍后核对。'}${suffix}`;
      } catch {
        if (revision === configSaveRevision) checkStatus.textContent = '设置保存失败；配置仍在当前会话中，请再次保存。';
      }
    }
    saveButton.addEventListener('click', async () => {
      const saved = options.saveConfig(draft());
      const errors = validateConfig(saved);
      showValidation(errors);
      key.input.value = '';
      render(false);
      await confirmConfigSave(Object.keys(errors).length > 0);
    });
    clearKeyButton.addEventListener('click', async () => {
      options.saveConfig(draft(), true);
      key.input.value = '';
      render(false);
      await confirmConfigSave();
    });
    toggleEnabledButton.addEventListener('click', async () => {
      const nextEnabled = !options.getViewModel().config.enabled;
      options.saveConfig({ enabled: nextEnabled });
      render(false);
      await confirmConfigSave();
    });
    retrySaveButton.addEventListener('click', async () => {
      retrySaveButton.disabled = true;
      try { await options.retryPersist?.(); }
      finally { render(false); }
    });
    runButton.addEventListener('click', () => { options.runNow(); render(false); });
    showTab('result');
    return { root, open, close, destroy, render, invalidatePreview };
  }

  function assertRuntimeCapabilities(globals) {
    const requiredFunctions = [
      'eventOn', 'generateRaw', 'getChatMessages', 'getLastMessageId', 'getVariables',
      'stopGenerationById', 'updateVariablesWith',
    ];
    const missing = requiredFunctions.filter((name) => typeof globals[name] !== 'function');
    for (const event of ['MESSAGE_RECEIVED', 'CHAT_CHANGED']) {
      if (typeof globals.tavern_events?.[event] !== 'string') missing.push(`tavern_events.${event}`);
    }
    if (missing.length) throw new Error(`剧情规划器缺少酒馆能力：${missing.join(', ')}`);
  }

  // One task owns one frozen chat prefix. Player input appended after that prefix
  // does not change a next-round plan; edits to the prefix do.
  function createPlanningLifecycle(options) {
    const { readMessages, readState, writeState, getConfig, getSignature, run,
      classifyFailure, extractOutline, hash, stop, notify, log, persistState } = options;
    let epoch = 0;
    let destroyed = false;
    let task = null;
    let claim = null;
    let recoveryChecked = false;
    let persistenceQueue = Promise.resolve();
    const uid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    const stamp = () => new Date().toISOString();
    const prefixHash = messages => hash(JSON.stringify(messages));

    function state() {
      const old = readState() ?? {};
      let value = old;
      if (old.schemaVersion !== 3 || !Array.isArray(old.outlineHistory) || !old.chatId) {
        const legacy = extractOutline(old.activeOutline ?? '');
        value = { ...old, schemaVersion: 3, chatId: old.chatId || uid(), outlineHistory: legacy.ok ? [{
          id: uid(), sequence: 1, purpose: 'legacy', status: 'invalid', body: legacy.body,
          fullTag: legacy.fullTag, sourceMessageId: old.outlineSourceMessageId ?? null,
          usedMessageId: null, createdAt: old.updatedAt ?? stamp(), invalidReason: '旧版本记录无法验证聊天进度',
        }] : [] };
        writeState(value);
      }
      if (!recoveryChecked) {
        recoveryChecked = true;
        const taskWasActive = ['running', 'retrying'].includes(value.status)
          || ['running', 'retrying'].includes(value.lastTask?.status);
        if (taskWasActive) {
          value = { ...value, status: 'interrupted', lastError: '上次规划在应用重启前未完成。',
            lastTask: value.lastTask ? { ...value.lastTask, status: 'interrupted', lastError: '应用重启时任务仍在运行。', updatedAt: stamp() } : null };
          writeState(value);
        }
      }
      return value;
    }
    function update(patch) {
      const old = state();
      writeState({ ...old, ...patch, schemaVersion: 3, stateVersion: (old.stateVersion ?? 0) + 1, updatedAt: stamp() });
    }
    function persistCritical(expectedEpoch = epoch, expectedChatId = state().chatId) {
      if (typeof persistState !== 'function') return Promise.resolve(true);
      const save = async () => {
        if (destroyed || epoch !== expectedEpoch || state().chatId !== expectedChatId) return false;
        try {
          if (state().persistenceError) update({ persistenceError: null });
          await persistState();
          if (destroyed || epoch !== expectedEpoch || state().chatId !== expectedChatId) return false;
          return true;
        } catch {
          if (!destroyed && epoch === expectedEpoch && state().chatId === expectedChatId) {
            try { update({ persistenceError: '聊天保存失败。细纲仍在本次会话中可用，请重试保存。' }); }
            catch { /* Preserve the planner result even if in-memory status cannot be updated. */ }
            try { notify?.('剧情规划已完成，但聊天保存失败；本次会话中的结果仍可用。'); }
            catch { /* Notification failure must not reclassify a saved planner result. */ }
          }
          return false;
        }
      };
      // Start the host save synchronously. The v2.3.0 metadata API enqueues
      // saves in call order for the chat active at invocation time.
      const pending = save();
      persistenceQueue = Promise.allSettled([persistenceQueue, pending]).then(() => {});
      return pending;
    }
    function identity() { return `${state().chatId}:${epoch}`; }
    function getCurrentTurn(type = 'normal') {
      const anchor = target(type);
      const latestUser = getStoryMessages(readMessages()).findLast(item => item.role === 'user');
      return { kind: anchor ? anchor.purpose === 'initial' ? 'initial' : 'normal' : 'skip',
        chatIdentity: identity(), type, userMessageId: latestUser?.messageId ?? null };
    }
    function target(type = 'normal') {
      let messages = readMessages();
      let storyMessages = getStoryMessages(messages);
      let replacementFloor = null;
      if (['regenerate', 'swipe', 'continue'].includes(type)) {
        const last = storyMessages.at(-1);
        if (last?.role === 'assistant' && last.messageId > 0) {
          replacementFloor = last.messageId;
          messages = messages.filter(message => message.messageId !== replacementFloor);
          storyMessages = getStoryMessages(messages);
        }
      }
      if (!messages.length || (storyMessages.length === 1 && storyMessages[0].messageId === 0)) return null;
      const previousAssistant = storyMessages.findLast(item => item.role === 'assistant' && item.messageId > 0);
      const latestUser = storyMessages.findLast(item => item.role === 'user');
      const sourceMessageId = previousAssistant?.messageId ?? latestUser?.messageId ?? storyMessages.at(-1)?.messageId ?? -1;
      const sourceMessages = messages.filter(item => item.messageId <= sourceMessageId);
      const anchor = storyMessages.filter(item => item.messageId <= sourceMessageId);
      const signature = getSignature();
      const sourceHash = prefixHash(sourceMessages);
      const chatId = state().chatId;
      return { chatId, sourceMessageId, sourceHash, signature,
        key: `${chatId}:${sourceMessageId}:${sourceHash}:${signature}`,
        purpose: previousAssistant ? 'next' : 'initial', messages: anchor,
        invocationMessages: messages, replacementFloor };
    }
    function matches(anchor, checkSignature = true) {
      if (destroyed || anchor.chatId !== state().chatId || (checkSignature && anchor.signature !== getSignature())) return false;
      return prefixHash(readMessages().filter(item => item.messageId <= anchor.sourceMessageId)) === anchor.sourceHash;
    }
    function valid(record, expected) {
      return record && expected && record.key === expected.key && matches(record)
        && ['ready', 'used', 'using'].includes(record.status) && extractOutline(record.fullTag).ok;
    }
    function select(expected) {
      return state().outlineHistory.findLast(record => valid(record, expected)) ?? null;
    }
    function revalidate() {
      const old = state();
      let changed = false;
      const messages = readMessages();
      const history = old.outlineHistory.map(record => {
        if (['invalid', 'superseded'].includes(record.status)) return record;
        const usedChanged = record.usedMessageId != null
          && prefixHash(messages.filter(item => item.messageId <= record.usedMessageId)) !== record.usedHash;
        if (!matches(record, record.status !== 'used') || usedChanged) {
          changed = true;
          return { ...record, status: 'invalid', invalidReason: '聊天记录或规划配置已变化' };
        }
        return record;
      });
      if (changed) update({ outlineHistory: history });
    }
    function cancellable(job, operation, delay = null) {
      if (job.cancelled || job.epoch !== epoch || !matches(job.anchor)) return Promise.reject(new Error('规划已取消：聊天或配置已变化'));
      const remaining = job.deadline - Date.now();
      if (remaining <= 0) return Promise.reject(new Error('请求超时'));
      let timer;
      let waitTimer;
      let rejectPending;
      return new Promise((resolve, reject) => {
        rejectPending = reject;
        job.rejectPending = reject;
        timer = setTimeout(() => { stop(job.generationId); reject(new Error('请求超时')); }, remaining);
        const work = delay === null ? Promise.resolve().then(() => {
          if (job.cancelled || job.epoch !== epoch || !matches(job.anchor)) throw new Error('规划已取消：聊天或配置已变化');
          return operation();
        })
          : new Promise(done => { waitTimer = setTimeout(done, Math.min(delay, remaining)); });
        work.then(resolve, reject);
      }).finally(() => {
        clearTimeout(timer); clearTimeout(waitTimer);
        if (job.rejectPending === rejectPending) job.rejectPending = null;
      });
    }
    function retryable(error) {
      const code = classifyFailure(error).code;
      return ['NETWORK', 'INVALID_RESPONSE', 'EMPTY_RESPONSE', 'OUTLINE_MISSING', 'OUTLINE_EMPTY',
        'TOOL_CALL_MISSING', 'TOOL_ARGS_INVALID', 'TOOL_CONTENT_EMPTY', 'HTTP_408', 'HTTP_429'].includes(code)
        || /^HTTP_5\d\d$/.test(code);
    }
    function taskInfo(job, status, error = null) {
      return { id: job.id, key: job.anchor.key, purpose: job.phase, sourceMessageId: job.anchor.sourceMessageId,
        attempt: job.attempt, maxAttempts: job.config.retryCount + 1, status,
        lastError: error ? classifyFailure(error).message : null, updatedAt: stamp() };
    }
    function start(anchor, phase) {
      if (task && task.anchor.key === anchor.key && ['running', 'retrying'].includes(task.status)) return task.promise;
      if (task && ['running', 'retrying'].includes(task.status)) cancelTask();
      const config = structuredClone(getConfig());
      const job = { id: uid(), anchor, phase, config, epoch, status: 'running', attempt: 0,
        cancelled: false, deadline: Date.now() + config.timeoutSeconds * 1000 };
      job.isCurrent = () => !job.cancelled && job.epoch === epoch && matches(anchor) && Date.now() < job.deadline;
      task = job;
      job.promise = (async () => {
        try {
          let result;
          let outline;
          for (let attempt = 1; attempt <= config.retryCount + 1; attempt += 1) {
            job.attempt = attempt; job.status = attempt === 1 ? 'running' : 'retrying';
            job.generationId = `tw-planner-${job.id}-${attempt}`;
            update({ status: job.status, lastError: null, lastTask: taskInfo(job, job.status) });
            log.info?.('[剧情规划器][任务]', taskInfo(job, job.status));
            try {
              result = await cancellable(job, () => run(job, anchor));
              outline = extractOutline(result.rawText);
              if (!outline.ok) throw new Error(outline.error);
              break;
            } catch (error) {
              if (job.cancelled || job.epoch !== epoch || !matches(anchor)) throw new Error('规划已取消：聊天或配置已变化');
              if (Date.now() >= job.deadline || error.message === '请求超时') throw new Error('请求超时');
              if (attempt > config.retryCount || !retryable(error)) throw error;
              job.status = 'retrying';
              update({ status: 'retrying', lastTask: taskInfo(job, 'retrying', error) });
              log.info?.('[剧情规划器][重试]', taskInfo(job, 'retrying', error));
              await cancellable(job, null, options.retryDelayMs ?? Math.min(500 * attempt, 2000));
            }
          }
          if (job.cancelled || job.epoch !== epoch || !matches(anchor)) throw new Error('规划已取消：聊天或配置已变化');
          const old = state();
          const history = old.outlineHistory.map(record => record.key === anchor.key && record.status === 'ready'
            ? { ...record, status: 'superseded' } : record);
          const record = { id: uid(), sequence: Math.max(0, ...history.map(item => item.sequence || 0)) + 1,
            key: anchor.key, chatId: anchor.chatId, signature: anchor.signature, sourceHash: anchor.sourceHash,
            sourceMessageId: anchor.sourceMessageId, purpose: anchor.purpose, generatedPhase: phase,
            fullTag: outline.fullTag, body: outline.body, status: 'ready', usedMessageId: null, createdAt: stamp() };
          history.push(record);
          job.status = 'ready';
          update({ outlineHistory: history, activeOutline: record.fullTag, outlineSourceMessageId: record.sourceMessageId,
            outlineRevision: record.sequence, rawText: result.rawText, status: 'ready', lastError: null,
            initialStatus: anchor.purpose === 'initial' ? 'ready' : old.initialStatus,
            lastTask: taskInfo(job, 'ready') });
          await persistCritical(job.epoch, anchor.chatId);
          if (job.epoch !== epoch || !matches(anchor)) throw new Error('规划已取消：聊天或配置已变化');
          return record;
        } catch (error) {
          job.status = 'failed';
          if (!job.cancelled && job.epoch === epoch && matches(anchor)) {
            const failure = classifyFailure(error).message;
            update({ status: 'failed', lastError: `${phase === 'next' ? '下一轮' : '本轮'}：${failure}`, lastTask: taskInfo(job, 'failed', error) });
            if (phase === 'next') notify(`下一轮细纲生成失败：${failure} 将在下次发送前补救。`);
          }
          throw error;
        }
      })();
      return job.promise;
    }
    function cancelTask() {
      if (!task || !['running', 'retrying'].includes(task.status)) return;
      task.cancelled = true;
      stop(task.generationId);
      task.rejectPending?.(new Error('规划已取消：聊天或配置已变化'));
      task.promise.catch(() => {});
    }
    function invalidate() {
      cancelTask(); epoch += 1; task = null; claim = null;
      recoveryChecked = false;
      revalidate();
    }
    async function ensureCurrent(type = 'normal') {
      if (destroyed || !getConfig().enabled) throw new Error('自动规划未启用');
      revalidate();
      const anchor = target(type);
      if (!anchor) return null;
      const existing = select(anchor);
      if (existing) return existing;
      if (task?.anchor.key === anchor.key && ['running', 'retrying'].includes(task.status)) {
        task.phase = 'current';
        return task.promise;
      }
      return start(anchor, 'current');
    }
    function markUsing(id, type = 'normal') {
      const anchor = target(type);
      const record = state().outlineHistory.find(item => item.id === id);
      if (!valid(record, anchor)) return false;
      claim = { id, chatId: state().chatId, messages: anchor.invocationMessages,
        invocationHash: prefixHash(anchor.invocationMessages), replacementFloor: anchor.replacementFloor };
      update({ outlineHistory: state().outlineHistory.map(item => item.id === id ? { ...item, status: 'using' } : item) });
      return true;
    }
    function onMessage() {
      const messages = readMessages();
      const latest = messages.at(-1);
      const finalNarrative = isFinalNarrativeAssistant(messages);
      if (claim && claim.chatId === state().chatId && finalNarrative) {
        const prefix = messages.filter(item => item.messageId <= (claim.messages.at(-1)?.messageId ?? -1));
        if (prefixHash(prefix) === claim.invocationHash
          && (claim.replacementFloor === null ? latest.messageId > (claim.messages.at(-1)?.messageId ?? -1) : latest.messageId >= claim.replacementFloor)) {
          update({ outlineHistory: state().outlineHistory.map(item => item.id === claim.id
            ? { ...item, status: 'used', usedMessageId: latest.messageId, usedHash: prefixHash(messages), usedAt: stamp() } : item) });
          void persistCritical(epoch, claim.chatId);
          claim = null;
        }
      }
      revalidate();
      if (!getConfig().enabled || !finalNarrative || latest.messageId === 0) return;
      const anchor = target();
      if (!anchor || select(anchor)) return;
      if (state().lastTask?.key === anchor.key || task?.anchor.key === anchor.key) return;
      start(anchor, 'next').catch(() => {});
    }
    // Recover stale in-flight status as soon as a runtime is created, before UI
    // reads or the next generation asks for an outline.
    state();
    return { ensureCurrent, markUsing, onMessage, invalidate, identity, target, getCurrentTurn,
      getActive(type = 'normal') { revalidate(); return select(target(type)); },
      manual() { const anchor = target(); if (!anchor) return false; start(anchor, 'current').catch(() => {}); return true; },
      getStatus: () => ({ epoch, destroyed, running: ['running', 'retrying'].includes(task?.status), pending: false,
        generationId: task?.generationId ?? null, phase: task?.phase, attempt: task?.attempt,
        persistenceError: state().persistenceError ?? null }),
      flushPersistence: () => persistenceQueue,
      retryPersistence: () => persistCritical(epoch, state().chatId),
      getState: state,
      clearClaim() { claim = null; },
      stopCurrent() { claim = null; if (task?.phase === 'current') cancelTask(); },
      destroy() { cancelTask(); destroyed = true; epoch += 1; claim = null; },
    };
  }

  function createTavernRuntime(globals, requestedConfig = {}) {
    assertRuntimeCapabilities(globals);
    let config = normalizeConfig({ ...DEFAULT_CONFIG, ...requestedConfig });
    let presetState = normalizePlannerPresetState(globals.getVariables({ type: 'script' }));
    const log = globals.console ?? console;
    const disposers = [];
    let lastSentPrompt = null;
    let lastPreparedRequest = null;

    function prepareRequest(preset, context) {
      const key = JSON.stringify({ preset, context });
      if (lastPreparedRequest?.key === key) return structuredClone(lastPreparedRequest.value);
      const value = buildPlannerRequest(preset, context);
      lastPreparedRequest = { key, value: structuredClone(value) };
      return value;
    }

    function runWithTimeout(operation, seconds, onTimeout = () => {}) {
      let timer;
      return Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { onTimeout(); } catch { /* timeout still rejects */ }
            reject(new Error('请求超时'));
          }, seconds * 1000);
        }),
      ]).finally(() => clearTimeout(timer));
    }

    function currentPlanningState() {
      const variables = globals.getVariables({ type: 'chat' });
      return isRecord(variables?.[STATE_KEY]) ? variables[STATE_KEY] : null;
    }

    function readSnapshot() {
      const lastMessageId = globals.getLastMessageId();
      if (!Number.isInteger(lastMessageId) || lastMessageId < 0) return buildSnapshot([], currentPlanningState());
      const firstMessageId = Math.max(0, lastMessageId - config.historyLimit + 1);
      const messages = globals.getChatMessages(`${firstMessageId}-${lastMessageId}`, {
        hide_state: 'unhidden',
        include_swipes: false,
      });
      return buildSnapshot(messages, currentPlanningState());
    }

    async function runJob(job, snapshot) {
      if (Object.keys(validateConfig(config)).length) throw new Error('API 设置不完整');
      const preset = activePreset();
      const generationType = job.reason === 'initial' ? 'initial' : 'normal';
      if (!hasEffectivePlannerPrompt(preset, generationType)) throw new Error('预设没有可发送的 Prompt，请先导入预设或新增并填写词块');
      const context = job.context ??= await readPlannerContext(globals, snapshot, generationType);
      if (!job.isCurrent()) throw new Error('规划已取消：聊天或配置已变化');
      const final = job.prepared ??= prepareRequest(preset, context);
      if (final.diagnostics.some(issue => issue.includes('宏 {{last_maintext}} 未找到'))) {
        throw new Error('最新助手回复缺少 <maintext>/<content> 正文');
      }
      if (!final.messages.length || final.diagnostics.some(issue => issue.includes('已阻止本次转换'))) throw new Error('预设无法生成有效消息');
      if (getTriggeredPlannerPrompts(preset, generationType).some(({ prompt }) => prompt.marker && ['worldInfoBefore', 'worldInfoAfter'].includes(prompt.identifier))) {
        if (context.diagnostics.some(issue => issue.includes('缺少') && issue.includes('世界书'))) throw new Error('世界书接口缺失，请先检查预设页诊断');
        if (context.diagnostics.some(issue => issue.includes('世界书读取失败') || issue.includes('世界书格式错误'))) throw new Error('世界书读取失败，请先检查预设页诊断');
      }
      if (getTriggeredPlannerPrompts(preset, generationType).some(({ prompt }) => prompt.marker && prompt.identifier === 'charDescription') && context.diagnostics.some(issue => issue.includes('缺少 getCharacter'))) throw new Error('角色资料接口缺失，请先检查预设页诊断');
      if (getTriggeredPlannerPrompts(preset, generationType).some(({ prompt }) => prompt.marker && prompt.identifier === 'personaDescription') && !context.personaDescription) throw new Error('当前 Persona 无法读取');
      const promptSummary = summarizePromptMessages(final.request.ordered_prompts);
      log.info?.('[剧情规划器][诊断][提示词组装]', {
        stage: 'planner_final_messages',
        generationType,
        ...promptSummary,
      });
      log.info?.(`[剧情规划器][API] 开始调用${generationType === 'initial' ? '初始规划请求' : '后续规划请求'}`);
      lastSentPrompt = { blocks: final.blocks, messages: final.request.ordered_prompts,
        diagnostics: final.diagnostics, request: structuredClone(final.request) };
      const raw = await globals.generateRaw({
        generation_id: job.generationId, should_stream: false, should_silence: true,
        max_chat_history: 0, custom_api: buildCustomApi(job.config ?? config), ...final.request,
      }).finally(() => { lastPreparedRequest = null; });
      const parsed = parsePlannerResult(raw, final.request.tools?.[0]?.function.name, classifySPresetCompatibility(preset));
      if (!parsed.ok) throw new Error(parsed.error);
      const outline = extractOutline(parsed.value.rawText);
      if (!outline.ok) throw new Error(outline.error);
      return parsed.value;
    }

    function readAllMessages() {
      const last = globals.getLastMessageId();
      if (!Number.isInteger(last) || last < 0) return [];
      return buildSnapshot(globals.getChatMessages(`0-${last}`, { hide_state: 'unhidden', include_swipes: false })).messages;
    }
    const lifecycle = createPlanningLifecycle({
      readMessages: readAllMessages, readState: currentPlanningState,
      writeState: value => globals.updateVariablesWith(variables => ({ ...variables, [STATE_KEY]: value }), { type: 'chat' }),
      persistState: globals.platform === 'tauritavern' && typeof globals.persistVariables === 'function'
        ? () => globals.persistVariables({ type: 'chat' }) : undefined,
      getConfig: () => config,
      getSignature: () => fnv1a(JSON.stringify({ config, preset: activePreset() })),
      run: (job, anchor) => {
        const messages = buildPlannerHistoryMessages(anchor.messages, job.config.historyLimit)
          .map(item => ({ message_id: item.messageId, role: item.role, message: item.content }));
        job.reason = anchor.purpose === 'initial' ? 'initial' : 'normal';
        return runJob(job, buildSnapshot(messages));
      },
      classifyFailure: classifyPlannerFailure, extractOutline, hash: fnv1a,
      stop: id => { if (id) globals.stopGenerationById(id); },
      notify: message => globals.notifyError?.(message), log,
    });
    const scheduler = {
      getStatus: lifecycle.getStatus,
      schedule: () => lifecycle.manual(),
      changeChat: () => lifecycle.invalidate(),
      destroy: () => lifecycle.destroy(),
    };
    const gate = {
      version: 2,
      isEnabled: () => config.enabled,
      describeFailure: error => classifyPlannerFailure(error).message,
      getChatIdentity: lifecycle.identity,
      getCurrentTurn: lifecycle.getCurrentTurn,
      getActiveOutline({ chatIdentity, type = 'normal', recordId } = {}) {
        if (chatIdentity !== lifecycle.identity()) return null;
        const record = lifecycle.getActive(type);
        return record && (!recordId || record.id === recordId) ? record : null;
      },
      ensureCurrentOutline({ chatIdentity, type = 'normal' } = {}) {
        if (chatIdentity !== lifecycle.identity()) return Promise.reject(new Error('聊天已切换'));
        return lifecycle.ensureCurrent(type);
      },
      ensureInitialOutline(options) { return gate.ensureCurrentOutline(options); },
      markUsing: lifecycle.markUsing,
      clearClaim: lifecycle.clearClaim,
      stopCurrent: lifecycle.stopCurrent,
    };
    function subscribe(eventName, listener) {
      if (typeof eventName !== 'string') return;
      const subscription = globals.eventOn(eventName, listener);
      if (typeof subscription?.stop === 'function') disposers.push(() => subscription.stop());
    }

    let mainGenerationActive = false;
    let mainGenerationStopped = false;
    subscribe(globals.tavern_events.GENERATION_STARTED, (type, _options, dryRun) => {
      if (dryRun || ['quiet', 'impersonate'].includes(type)) return;
      mainGenerationActive = true; mainGenerationStopped = false;
    });
    subscribe(globals.tavern_events.GENERATION_ENDED, () => {
      mainGenerationActive = false;
      // A microtask allows the final message/event to settle; stopped generations
      // must not prefetch an outline from a partial reply.
      queueMicrotask(() => { if (!destroyed && !mainGenerationActive && !mainGenerationStopped) lifecycle.onMessage(); });
    });
    subscribe(globals.tavern_events.GENERATION_STOPPED, () => {
      mainGenerationActive = false; mainGenerationStopped = true;
      lifecycle.stopCurrent();
    });
    for (const eventKey of ['MESSAGE_RECEIVED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED']) {
      subscribe(globals.tavern_events[eventKey], () => {
        lastPreparedRequest = null;
        panel?.invalidatePreview();
        if (eventKey === 'MESSAGE_RECEIVED' || eventKey === 'MESSAGE_SWIPED') {
          if (!mainGenerationActive && !mainGenerationStopped) lifecycle.onMessage();
        }
        else lifecycle.invalidate();
      });
    }
    subscribe(globals.tavern_events.CHAT_CHANGED, () => {
      mainGenerationActive = false; mainGenerationStopped = false;
      lifecycle.invalidate(); lastSentPrompt = null; lastPreparedRequest = null; panel?.invalidatePreview();
    });

    const onPageHide = () => runtime.destroy();
    if (typeof globals.addEventListener === 'function') {
      globals.addEventListener('pagehide', onPageHide, { once: true });
      disposers.push(() => globals.removeEventListener?.('pagehide', onPageHide));
    }

    let destroyed = false;
    let panel = null;

    function getPanelDocument() {
      try {
        return globals.parent?.document ?? globals.document ?? null;
      } catch {
        return null;
      }
    }

    function getPanelViewModel() {
      const presetReady = hasEffectivePlannerPrompt(activePreset());
      return { ...buildPanelViewModel(config, currentPlanningState(), scheduler.getStatus(), presetReady), presetReady };
    }

    let testGenerationId = null;
    let configRevision = 0;
    function savePanelConfig(draft, clearKey = false) {
      scheduler.changeChat();
      lastSentPrompt = null;
      lastPreparedRequest = null;
      if (testGenerationId) globals.stopGenerationById(testGenerationId);
      configRevision += 1;
      config = persistPlannerConfig(globals, draft, config, clearKey);
      lifecycle.invalidate();
      log.info?.(`[剧情规划器][状态] ${config.enabled ? '已开启' : '已关闭'}`);
      return config;
    }

    function runNow() {
      if (destroyed || Object.keys(validateConfig(config)).length || !hasEffectivePlannerPrompt(activePreset())) return false;
      scheduler.schedule('manual');
      return true;
    }

    async function testConnection(draft) {
      const candidate = normalizeConfig({ ...config, ...draft, key: draft.key?.trim() || config.key });
      if (Object.keys(validateConfig(candidate)).length) return '配置不完整，请先检查配置。';
      const revision = configRevision;
      const generationId = `tw-planner-test-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
      testGenerationId = generationId;
      try {
        const response = await runWithTimeout(() => globals.generateRaw({
          generation_id: generationId,
          should_stream: false,
          should_silence: true,
          max_chat_history: 0,
          custom_api: buildCustomApi(candidate),
          ordered_prompts: [
            { role: 'system', content: '这是连接测试。请简短回复连接成功。' },
            { role: 'user', content: '连接测试' },
          ],
        }), candidate.timeoutSeconds, () => globals.stopGenerationById(generationId));
        if (destroyed || revision !== configRevision) return '设置已变更，旧测试结果作废。';
        const responseText = typeof response === 'string' ? response : response?.choices?.[0]?.message?.content;
        return typeof responseText === 'string' && responseText.trim() ? 'API 连接测试成功，已收到非空回复；本次没有写入聊天变量。' : 'API 已响应，但回复为空。';
      } catch (error) {
        if (destroyed || revision !== configRevision) return '设置已变更，旧测试结果作废。';
        return `API 连接测试失败：${classifyPlannerFailure(error).message}`;
      } finally {
        if (testGenerationId === generationId) testGenerationId = null;
      }
    }

    async function testToolCall(draft) {
      const candidate = normalizeConfig({ ...config, ...draft, key: draft.key?.trim() || config.key });
      if (Object.keys(validateConfig(candidate)).length) return '配置不完整，请先检查配置。';
      const tool = getSPresetSettings(activePreset()).gameContentTool;
      if (!tool) return '当前活动预设没有启用且有效的 game_content 工具绑定；请检查预设页 SPreset 诊断。';
      const revision = configRevision;
      const probeModes = [
        { name: 'named', choice: { type: 'function', function: { name: 'game_content' } } },
        { name: 'required', choice: 'required' },
        { name: 'auto', choice: 'auto' },
      ];
      const results = [];
      log.info?.('[剧情规划器][诊断][探针]', { state: 'started', tool: 'game_content', promptMessageCount: 2, modes: probeModes.map(mode => mode.name) });
      try {
        for (const mode of probeModes) {
          const generationId = `tw-planner-tool-probe-${mode.name}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
          testGenerationId = generationId;
          try {
            const response = await runWithTimeout(() => globals.generateRaw({
              generation_id: generationId,
              should_stream: false,
              should_silence: true,
              max_chat_history: 0,
              custom_api: buildCustomApi(candidate),
              ordered_prompts: [
                { role: 'system', content: '请只调用 game_content 工具一次，把 <outline>探针成功</outline> 放入 content 参数；不要直接回复文本。' },
                { role: 'user', content: '执行工具调用探针。' },
              ],
              tools: [tool],
              tool_choice: mode.choice,
            }), candidate.timeoutSeconds, () => globals.stopGenerationById(generationId));
            if (destroyed || revision !== configRevision) return '设置已变更，旧工具调用探针结果作废。';
            const message = response?.choices?.[0]?.message;
            const standard = Array.isArray(message?.tool_calls) && message.tool_calls.some(call => call?.function?.name === 'game_content');
            const legacy = message?.function_call?.name === 'game_content';
            results.push({ mode: mode.name, result: standard ? 'tool_calls' : legacy ? 'function_call' : 'text' });
            log.info?.('[剧情规划器][诊断][探针]', {
              state: standard ? 'passed' : legacy ? 'legacy_function_call' : 'no_tool_call',
              mode: mode.name,
              hasContent: typeof message?.content === 'string' && message.content.trim().length > 0,
              hasOutlineTag: typeof message?.content === 'string' && /<outline/i.test(message.content) && /<\/outline/i.test(message.content),
              finishReason: typeof response?.choices?.[0]?.finish_reason === 'string' ? response.choices[0].finish_reason : null,
            });
            if (standard || legacy) break;
          } catch (error) {
            if (destroyed || revision !== configRevision) return '设置已变更，旧工具调用探针结果作废。';
            const failure = classifyPlannerFailure(error);
            results.push({ mode: mode.name, result: failure.code });
            log.info?.('[剧情规划器][诊断][探针]', { state: 'mode_failed', mode: mode.name, reason: failure.code });
          } finally {
            if (testGenerationId === generationId) testGenerationId = null;
          }
        }
        const successful = results.find(result => result.result === 'tool_calls' || result.result === 'function_call');
        log.info?.('[剧情规划器][诊断][探针汇总]', { results });
        if (!successful) return '三种工具选择格式都未收到 game_content 调用。问题位于独立 API 路径或服务商转发；请发送控制台中的探针汇总。';
        if (successful.result === 'function_call') return `${successful.mode} 模式返回旧式 function_call；当前解析器需要增加该格式兼容。`;
        if (successful.mode === 'named') return '指定 game_content 的格式可用；独立链路正常，下一步检查完整规划请求的其他差异。';
        return `${successful.mode} 模式成功，指定 game_content 的格式被忽略。已定位为 tool_choice 兼容差异。`;
      } catch (error) {
        if (destroyed || revision !== configRevision) return '设置已变更，旧工具调用探针结果作废。';
        log.info?.('[剧情规划器][诊断][探针]', { state: 'failed', reason: classifyPlannerFailure(error).code });
        return `工具调用探针失败：${classifyPlannerFailure(error).message}`;
      } finally {
        if (testGenerationId) globals.stopGenerationById(testGenerationId);
        testGenerationId = null;
      }
    }

    async function fetchModels(draft) {
      if (typeof globals.getModelList !== 'function') return { ok: false, error: '当前酒馆未提供模型列表接口，请手动填写模型名。' };
      const candidate = normalizeConfig({ ...config, ...draft, key: draft.key?.trim() || config.key });
      if (validateConfig({ ...candidate, model: 'model-list-probe' }).apiurl) return { ok: false, error: '请先填写有效的 API 地址。' };
      const revision = configRevision;
      try {
        const received = await runWithTimeout(
          () => globals.getModelList({ apiurl: candidate.apiurl, key: candidate.key }),
          candidate.timeoutSeconds,
        );
        if (destroyed || revision !== configRevision) return { ok: false, error: '设置已变更，旧模型列表作废。' };
        if (!Array.isArray(received)) return { ok: false, error: '模型列表返回格式不正确。' };
        const models = received.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()).slice(0, 200);
        return models.length ? { ok: true, models } : { ok: false, error: '没有获取到模型，请检查地址和密钥，或手填模型名。' };
      } catch (error) {
        return { ok: false, error: error?.message === '请求超时' ? '获取模型超时；列表请求无法通过当前接口取消。' : '获取模型失败，请检查地址和密钥，或手填模型名。' };
      }
    }

    function activePreset() {
      return presetState.plannerPresets.find(item => item.id === presetState.activePlannerPresetId) ?? presetState.plannerPresets[0];
    }
    function savePresetState(draftState) {
      for (const preset of draftState.plannerPresets) {
        const errors = validatePlannerPreset(preset);
        if (errors.length) throw new Error(errors.join('；'));
      }
      if (!draftState.plannerPresets.some(item => item.id === draftState.activePlannerPresetId)) throw new Error('活动预设不存在');
      scheduler.changeChat(); lastSentPrompt = null; lastPreparedRequest = null; configRevision += 1;
      const next = structuredClone({ plannerPresets: draftState.plannerPresets, activePlannerPresetId: draftState.activePlannerPresetId });
      globals.updateVariablesWith(variables => ({ ...variables, ...next }), { type: 'script' });
      presetState = next;
      lifecycle.invalidate();
      return structuredClone(next);
    }
    async function previewPreset(preset) {
      if (!hasEffectivePlannerPrompt(preset)) return { blocks: [], messages: [], request: { ordered_prompts: [] }, diagnostics: ['预设没有可发送的 Prompt，请先导入预设或新增并填写词块'], contextHash: null };
      const snapshot = readSnapshot();
      const context = await readPlannerContext(globals, snapshot);
      return { ...prepareRequest(preset, context), contextHash: fnv1a(JSON.stringify(context)) };
    }
    async function checkPreviewFresh(hash) {
      const context = await readPlannerContext(globals, readSnapshot());
      return fnv1a(JSON.stringify(context)) === hash;
    }
    async function checkPreset(preset) {
      const issues = validatePlannerPreset(preset);
      if (!hasEffectivePlannerPrompt(preset)) issues.push('当前 normal 触发类型下没有启用的 Prompt');
      issues.push(...getSPresetSettings(preset).diagnostics.filter(issue => !issues.includes(issue)));
      const result = await previewPreset(preset);
      if (!result.messages.length) issues.push('没有可发送的消息');
      issues.push(...result.diagnostics);
      return [...new Set(issues)];
    }

    function openPanel() {
      if (destroyed) return false;
      if (!panel) {
        const document = getPanelDocument();
        if (!document) {
          log.warn?.('[剧情规划器][panel] 无法访问宿主文档');
          return false;
        }
        panel = createPlannerPanel({
          document,
          version: globals.version,
          getViewModel: getPanelViewModel,
          getPresetState: () => structuredClone(presetState),
          savePresetState, checkPreset, previewPreset, checkPreviewFresh,
          saveConfig: savePanelConfig,
          persistConfig: () => typeof globals.persistVariables === 'function'
            ? globals.persistVariables({ type: 'script' }) : Promise.resolve({ type: 'script', confirmed: false }),
          retryPersist: lifecycle.retryPersistence,
          testConnection,
          testToolCall,
          fetchModels,
          runNow,
          setInterval: globals.setInterval?.bind(globals),
          clearInterval: globals.clearInterval?.bind(globals),
        });
      }
      panel.open();
      return true;
    }

    const runtime = {
      destroy() {
        if (destroyed) return;
        destroyed = true;
        lastSentPrompt = null;
        lastPreparedRequest = null;
        scheduler.destroy();
        if (testGenerationId) globals.stopGenerationById(testGenerationId);
        panel?.destroy();
        panel = null;
        while (disposers.length) {
          try { disposers.pop()?.(); } catch (error) { log.warn?.('[剧情规划器][cleanup]', error); }
        }
      },
      getStatus: scheduler.getStatus,
      getPanelViewModel,
      openPanel,
      gate,
      runNow,
      saveConfig: savePanelConfig,
      testConnection,
      testToolCall,
      getPresetState: () => structuredClone(presetState),
      getLastSentPrompt: () => lastSentPrompt ? structuredClone(lastSentPrompt) : null,
      savePresetState, checkPreset, previewPreset,
      fetchModels,
      schedule(reason) {
        if (config.enabled) scheduler.schedule(reason);
      },
    };
    if (typeof globals.getButtonEvent === 'function') disposers.push(bindPlannerButton(globals, openPanel));
    else log.warn?.('[剧情规划器][panel] 扩展菜单按钮未就绪，后台规划仍可使用');
    log.info?.('[剧情规划器][ready]', {
      extensionId: EXTENSION_ID,
      enabled: config.enabled,
      tavern: globals.getTavernVersion?.() ?? null,
    });
    log.info?.(`[剧情规划器][状态] ${config.enabled ? '已开启' : '已关闭'}`);
    return runtime;
  }

  return {
    BUTTON_NAME,
    createDefaultPlannerPreset,
    importPlannerPreset,
    exportPlannerPreset,
    getOrderedPlannerPrompts,
    normalizePlannerPresetState,
    validatePlannerPreset,
    readPlannerContext,
    compilePlannerMessages,
    applyPlannerKemini,
    buildFinalPlannerPrompt,
    buildPlannerRequest,
    classifySPresetCompatibility,
    applySupportedSPresetSendTransform,
    applySupportedSPresetResponseTransform,
    DEFAULT_LIMITS,
    DEFAULT_CONFIG,
    STATE_KEY,
    bindPlannerButton,
    buildPanelViewModel,
    buildSnapshot,
    buildPlannerHistoryMessages,
    classifyPlanningTurn,
    extractOutline,
    createPlannerPanel,
    createPlannerScheduler,
    createTavernRuntime,
    createPlanningLifecycle,
    fnv1a,
    hashSnapshot,
    isSnapshotCurrent,
    parsePlannerResult,
    classifyPlannerFailure,
    persistPlannerConfig,
  };
});
