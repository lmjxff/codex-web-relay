# Changelog

## Unreleased

- Stabilize Git previews across slow/out-of-order requests, file switches, language changes and locking. Coalesce pending requests, cancel obsolete previews, and avoid rebuilding unchanged previews/file chips while preserving same-file scroll positions.
- 中文：修复旧 Git 请求覆盖新选择的问题，合并慢请求并取消过时预览；内容不变时保留页面节点，同一文件更新时保持滚动位置。
- Add browser-local Chinese/English and terminal font preferences, expandable workspace paths, a quieter mobile control layout and an explicit shared-session restart confirmation.
- 中文：新增中英文切换、终端字号记忆、工作目录展开和重启确认，整理手机操作区布局。
- Correct first-sign-in guidance to use the local pairing page or the launch directory's `.env`, and add bilingual credential/connectivity troubleshooting.
- 中文：修正首次登录引导，补充凭据查找、二维码缺失及连接排错说明。
- Acknowledge terminal shortcuts, suppress duplicate action IDs, block repeated clicks while waiting, and display connection/failure/uncertain-delivery states without automatic key retries.
- 中文：快捷按钮新增回执、防连点及断线/失败/超时提示，避免静默失败或自动重复发送按键。
- Add mobile Up/Down/Tab shortcuts and label y/n buttons by the keys they send. Numbered menus can be navigated with arrows and confirmed separately with Enter.

中文：新增手机方向键和 Tab，明确 y/n 按钮的实际含义；编号菜单先选择，再回车确认。

## 0.2.3 — 2026-10-23

- Add certificate-mode `CF_MANAGE_DNS=false` to reuse an existing named tunnel and DNS route. This mode performs only the existing-tunnel check and connector startup, with no tunnel creation or DNS write, including on failure.
- Document reuse mode in both languages and cover its success/failure paths with mocked regression tests.

中文：新增复用已有 Cloudflare 隧道/域名路由的选项，连接测试无需再次创建隧道或写入 DNS。

## 0.2.2 — 2026-10-23

- Keep every browser on one shared terminal grid sized for the smallest connected viewport. Restore a parsed server-side screen on reconnect/resize, with 1,000 lines of bounded scrollback, instead of replaying an arbitrary ANSI byte tail.
- Order browser writes, resets and resizes, and reset every connected screen when the shared session restarts. Retain drafts when the terminal has ended.
- Retire an old PTY before terminating it, including synchronous Windows exit notifications. Show normal exits, reported failures and unavailable exit statuses separately; never render `code=undefined`. A browser reconnect no longer silently starts a replacement for an ended session.
- Add two-client geometry, ANSI approval redraw, alternate-screen, pending-write, synchronous-exit and unavailable-exit-status regressions. Update both READMEs with terminal menu interaction and restart instructions.

中文：修复手机与电脑尺寸不一致引起的终端重绘问题；重连恢复服务端当前屏幕；正常结束、异常退出及未知退出状态分别提示；主动重启不再混入旧进程退出消息。真实手机基础输入/输出同步已由用户反馈通过，本次确认菜单残留问题仍需更新后真机复核。

## 0.2.1 — 2026-10-23

- Default to loopback with public tunnels disabled; remove the author's domain from defaults and examples. Generate a long local credential, require 24+ characters for public mode, and avoid printing credentials or passing tunnel tokens in argv.
- Advertise public QR codes only after tunnel registration; handle early exit, timeout and later tunnel exit. Preserve DNS records unless overwrite is explicitly enabled.
- Ignore direct-client forwarded IP headers, validate the local QR bypass and WebSocket origins, bound frames/input, and serve browser assets locally.
- Protect replacement PTYs from stale exit/data callbacks. Retain unsent prompts, acknowledge writes, deduplicate recent prompt IDs and replace history on reconnect.
- Repair missing macOS spawn-helper execute bits in node-pty 1.1.0 before starting a terminal; verify an actual PTY command on all CI platforms.
- Parse NUL-delimited Git status, show new-directory/Unicode paths, resolve repository roots and report omitted previews instead of a false clean state.
- Add English/Chinese setup, migration, configuration and security documentation, regression tests and a Windows/macOS/Linux CI matrix on Node 22/24.

中文：默认仅本机访问，移除作者域名；加强凭据、鉴权、隧道及终端生命周期；修复中文/新目录 Diff、断线丢输入与重连重复显示；补充中英文使用说明和跨平台自动化测试。真实手机、Codex 交互与公网连接仍需独立验证。
