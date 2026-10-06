# 剧情规划器 SillyTavern 扩展 0.1.9

仓库默认分支 `main` 的根目录直接包含可安装扩展的 manifest、入口和模块。扩展依赖 SillyTavern 原生扩展上下文，不需要 Tavern Helper / JS-Slash-Runner。完整功能与诊断说明见 [README](README.md)。

## 安装

1. 在 SillyTavern 的“扩展 → 安装扩展”中，Git URL 填 `https://github.com/yu555-ux/story-planner`。
2. Branch or tag name 留空，即安装默认分支 `main`。
3. 点击“Install just for me”或“Install for all users”，安装并启用“剧情规划器”，然后刷新页面。
4. 点击聊天输入框旁的魔法棒，在菜单中选择“剧情规划器”。在“设置”页填写独立规划 API 的 OpenAI 兼容基址、密钥和模型，再导入规划预设。
5. 点击面板右上角的开关按钮。按钮会立即保存开关状态；结果页状态区和浏览器控制台日志会显示是否开启，以及未调用 API 的配置原因。
6. 新聊天已有角色开场白（0 楼）时，发送第一条玩家消息（1 楼）。插件会先生成细纲，成功后才允许酒馆生成首次回复（2 楼）。

从本仓库 `main` 安装的用户，可在扩展管理器直接更新并刷新页面。若旧安装指向其他仓库或分支，Git 更新不会自动切换来源；请先导出规划预设、备份 API 配置，再用上述地址重新安装。更新并刷新后，可在浏览器控制台的 `[剧情规划器][ready]` 日志中确认 `version: "0.1.9"`。已保存密钥会在密码框中以圆点遮罩显示，可直接替换；清空后保存会移除密钥。

也可以手动安装：将仓库检出到 `data/<用户>/extensions/tw-story-planner-v1/`，或 `public/scripts/extensions/third-party/tw-story-planner-v1/`，然后重启 SillyTavern。Git URL 安装器接收仓库和分支，不接收 GitHub 的仓库子目录链接。

## 迁移已有数据

- 预设：在旧版本导出 JSON，再通过新扩展的预设页导入。
- API 密钥：在新扩展设置中重新输入。新扩展不会读取 Tavern Helper 的脚本变量。
- 聊天细纲：打开聊天时，如果旧版聊天元数据仍含 `__tw_story_planner_v1`，新扩展会把状态复制到自己的聊天元数据命名空间；不会删除旧字段。

## 当前范围

- 当前只规划细纲，并把完整 `<outline>…</outline>` 追加到本次 Chat Completion 提示词末尾。
- “规划结果”页按顺序保存本聊天的细纲历史，显示来源楼层、实际使用楼层和待使用/已使用/失效/替换状态；正文只显示 `<outline>` 内部内容。失败任务单独显示状态，不覆盖成功历史。
- 大纲、节点、精确提示词插入位置，以及 Text Completion 拦截尚未实现。
- 独立规划请求使用 SillyTavern 的 Chat Completion 同源后端，将配置的基址映射为 `reverse_proxy`，并把独立密钥作为 `proxy_password` 发送到酒馆后端。基址应类似 `https://provider.example/v1`；`/chat/completions` 后缀会自动去掉，因为后端会补上该路径。
- 模型列表通过酒馆原生 `/api/backends/chat-completions/status` 请求；若服务商不提供兼容列表，可手动填写模型名称。
- “测试连接”只检查 API 是否能返回非空普通回复，不验证正式规划的 `game_content` 工具调用。正式规划和探针都读取原始响应副本，不调用酒馆主预设包装的 `response.json()`，保留工具调用字段；没有工具调用时仍会提示失败。
- 失败通知区分 HTTP 状态码、网络或超时、工具调用缺失、空回复、`<outline>` 标签缺失及标签内容为空。无法可靠取得 HTTP 状态码时会明确说明，不显示接口返回的原始错误正文。
- 测试工具调用时，打开浏览器开发者工具的 Console，筛选 `[剧情规划器][诊断]`。`[响应]` 应显示 `responseSource: "cloned_http_body"`、`wrappedJsonInvoked: false`，原始工具调用结构见 `raw`。日志不会输出密钥、提示词、回复正文或工具参数。
- 设置页的“测试工具调用”按钮会用当前配置和预设工具定义发送最短探针，依次比较指定工具、必须调用和自动选择三种格式，最多调用 API 三次且不会写入聊天。探针会区分 `tool_choice` 格式兼容、完整规划提示词和独立请求路径问题。

## 验收边界

行为测试检查原生消息适配、扩展设置和聊天状态保存、API 请求适配、工具响应解析、首次拦截和提示词注入。TauriTavern 的适配基线是 v2.3.0 Stable，目标平台为 Windows 和 Android。扩展会在缺少必需事件时阻止首发生成，避免未规划直接放行。
