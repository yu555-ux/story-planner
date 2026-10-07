# 发布约定

- 剧情规划器的版本更新只发布到 `main`。开发分支可以用于准备改动，但不能作为发布完成的依据。
- 发布前在 `main` 更新版本号并完成必要验证；推送后检查 GitHub 远端 `main` 的 `manifest.json` 和目标文件，确认用户可从默认分支获得新版本。
- SillyTavern 的 Git 安装地址为 `https://github.com/yu555-ux/story-planner`，Branch or tag name 留空。不要要求用户填写分支名。
- 不强制推送；若远端 `main` 已变化，先整合变更并重新验证。
