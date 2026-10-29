# Codex Web Relay

[English](README.md) | [简体中文](README.zh-CN.md)

Codex Web Relay（`codex-web-relay`）让你直接用手机浏览器查看电脑上运行的 Codex CLI，发送终端输入，并预览 Git 改动，**无需安装手机 App**。项目提供一个共享 Web 终端、适合手机的输入栏、代码差异预览，以及可选的 Cloudflare Tunnel 连接。

**默认只允许本机访问，启动不需要域名或 Cloudflare 账号。** 本项目由社区独立开发，并非 OpenAI 官方产品。

## 操作演示

![Codex Web Relay 网页操作：输入任务、确认示例修改、查看 Git 差异](docs/assets/codex-web-relay-demo.gif)

13 秒循环演示：发送终端输入 → 阅读确认提示 → 确认示例修改 → 查看 Git Diff。

画面来自 Relay 的真实网页，使用隔离的示例命令行程序和 Git 工作区录制。终端回复为演示脚本内容；未连接真实 Codex 账号，也未展示访问凭据或配对二维码。

## 功能与边界

- 使用 node-pty、WebSocket 和 xterm.js，在通过鉴权的浏览器中查看、操作本地终端。
- 输入栏在收到服务端写入终端的确认前保留草稿；不确定是否送达时，重试沿用消息 ID，减少重复输入。
- 快捷按钮等待服务端回执，等待期间阻止连续点击；断线、失败和送达不确定会明确提示，不自动重发快捷键。
- 预览暂存区、工作区和未跟踪文件，包括新建目录中的文件与中文文件名。
- 本地配对页只为已启用的局域网入口或已连接的公网隧道生成二维码。
- 浏览器脚本和样式从本机提供，无需第三方 CDN。
- 可选临时公网地址、自有域名或 Cloudflare 后台管理的隧道 Token。

**Send y + Enter** / **Send n + Enter** 实际发送的是 `y` / `n` 加回车，作用于终端当前运行的程序。它们是终端快捷键，**没有绑定具体的 Codex 审批请求**。点击前请先读清终端提示。

终端里的编号菜单是绘制出来的文字，不是网页按钮，直接点文字不一定会选中。请使用 **↑ Up** / **↓ Down** 选择，再点击 **Enter** 确认当前高亮项；**Tab** 用于发送制表键。只有程序确实接受 `y` / `n` 时才使用对应的快捷按钮。

## 环境要求

- Node.js 22 或 24、npm，以及能在 `PATH` 中找到的 Git。
- 电脑上单独安装、登录 Codex CLI。先确认 `codex --version` 正常，并能在本机运行会话，参考 [Codex CLI 官方说明](https://developers.openai.com/codex/cli)。
- 支持 ConPTY 的 Windows、macOS 或 Linux。原生依赖 `node-pty` 可能需要系统编译工具。
- 使用公网隧道时，需要 cloudflared 能连接 Cloudflare；使用自定义域名时，域名必须属于你可授权的 Cloudflare 账号。

## 快速开始：先在电脑上使用

```bash
git clone https://github.com/lmjxff/codex-web-relay.git
cd codex-web-relay
npm ci
```

复制配置文件：

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bash
# macOS / Linux
cp .env.example .env
```

在本地 `.env` 中设置 `CODEX_CWD`，指向你要操作的项目绝对路径，例如 `C:/work/my-project` 或 `/home/me/my-project`。不设置时，默认使用启动 Relay 时所在的目录。

```bash
npm start
```

首次启动时，空的 `RELAY_AUTH_TOKEN` 会被替换为随机生成的 256 位访问凭据，保存到本地 `.env`。浏览器会打开 [本机配对页面](http://localhost:3210/qr)，点击页面上的电脑端控制台链接即可进入，也可以在登录页手动输入凭据。控制台不会打印凭据。

默认 `HOST=127.0.0.1`、`ENABLE_TUNNEL=false`，仅允许这台电脑连接，不生成局域网或公网二维码。使用期间保持进程运行，在电脑终端按 Ctrl+C 停止 Relay。

需要运行编译产物时，先执行 `npm run build`，再执行 `npm run serve`。`npm run dev` 用于源码热重载。以上流程从 Git 仓库运行，不依赖已发布的 npm 包。

## 用手机连接

### 首次登录

1. 保持电脑上的 Relay 运行，在该电脑打开 `http://localhost:3210/qr`；修改过端口时，请使用配置后的端口。
2. 在电脑上可直接点击配对页中的桌面终端入口。手机先按下文启用局域网或公网模式，再扫描对应二维码。默认仅本机模式不会提供局域网或公网二维码，这是正常行为。
3. 需要手动输入凭据时，打开 **Relay 启动目录**中的 `.env`，使用 `RELAY_AUTH_TOKEN` 的值。凭据保存在本地，**不会打印在终端日志里**，不要粘贴到 Issue 或截图中。旧 `RELAY_PIN` 只在未设置主要凭据时兜底。
4. 网页完全打不开时，先检查地址、端口、进程和网络；网页能打开但登录失败时，核对正在运行的实例所使用的凭据。返回 `429` 表示五分钟失败限流窗口尚未结束。

选择一种方式，修改**本地 `.env`** 后重启。你自己的域名只需放在本地配置中，无需写进公开的示例文件或 README。

### 同一个可信 Wi-Fi

```dotenv
HOST=0.0.0.0
ENABLE_TUNNEL=false
```

在电脑打开 `http://localhost:3210/qr`，扫描局域网二维码。为可信专用网络放行电脑防火墙中的对应端口。手机、电脑需要互通，访客 Wi-Fi 或客户端隔离可能阻止连接。局域网 HTTP 不加密，只在可信网络中使用。

电脑有多个网卡时，程序自动选择的 IP 可能不正确。可在手机手动打开 `http://你的局域网IP:3210/`，再输入访问凭据。

### 临时公网地址：无需域名

```dotenv
HOST=127.0.0.1
ENABLE_TUNNEL=true
CF_HOSTNAME=
CF_TUNNEL_TOKEN=
```

保留程序生成的长访问凭据。只有同时获得 `*.trycloudflare.com` 地址、收到隧道连接注册成功消息后，Relay 才会提供公网二维码。刷新本地 `/qr` 页面后扫码。临时地址可能每次启动都变化。

cloudflared 可能在安装依赖时或第一次使用隧道时下载。隧道启动失败时，本机入口仍可使用。公网可达性取决于网络和 Cloudflare，不保证任何网络都能连通。参考 [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。

### 自有域名：证书授权方式

先授权你拥有的 Cloudflare 域名：

```bash
npm run cf:login
```

再配置：

```dotenv
HOST=127.0.0.1
ENABLE_TUNNEL=true
CF_HOSTNAME=codex.example.com
CF_TUNNEL_NAME=codex-relay
CF_TUNNEL_TOKEN=
CF_OVERWRITE_DNS=false
```

将 `codex.example.com` 替换为**你自己的主机名**，不带 `https://`、端口或路径。授权证书通常保存在 `~/.cloudflared/cert.pem`。Relay 会创建或复用命名隧道，并创建对应 DNS 路由；这种方式会修改你的 Cloudflare 隧道和 DNS 配置。

默认不覆盖已有 DNS 记录。遇到冲突时，先自行处理记录；确实需要替换时，才设置 `CF_OVERWRITE_DNS=true`。授权或 DNS 失败会让公网入口保持不可用，不会悄悄换成另一个临时域名。

如果命名隧道和 DNS 路由已经配置好，可设置 `CF_MANAGE_DNS=false` 复用。此时 Relay 只检查已有隧道并启动连接器，不创建隧道、不修改 DNS；找不到隧道时直接失败，不尝试创建。连接前先确认该主机名已指向此隧道。复用模式下 `CF_OVERWRITE_DNS` 不生效。

### Cloudflare 后台管理：Token 方式

在 Cloudflare 后台配置隧道的公开主机名，并将服务地址设为 `http://127.0.0.1:3210`；如修改了 `PORT`，相应调整服务端口。隧道 Token **只写入本地 `.env`**：

```dotenv
HOST=127.0.0.1
ENABLE_TUNNEL=true
CF_HOSTNAME=codex.example.com
CF_TUNNEL_TOKEN=<你在后台获取的隧道Token>
```

此方式必须填写后台配置的主机名，Relay 不会自动创建后台路由。程序通过子进程环境变量 `TUNNEL_TOKEN` 传递凭据，不将其放进命令行参数。Cloudflare 隧道 Token 与 Relay 浏览器访问凭据是两种不同的秘密。

## 日常使用与限制

网页在前台时，每 15 秒检查一次连接，连接建立或心跳响应的等待时间为 10 秒。回到前台或网络恢复时，会先核对连接，再启用终端输入，并读取当前共享画面。重连依次等待 2、4、8、16 秒，最多 30 秒；心跳成功后恢复初始等待时间。离线或后台时等待恢复，浏览器休眠可能延迟计时。草稿保留供手动检查、重试，不会自动重发命令或快捷键；网页重连也不会重启电脑上的终端。

服务端另每 30 秒检查浏览器连接，下一轮仍未响应的客户端会被移除，同时释放其占用的共享终端尺寸。升级后需重启服务端并刷新所有浏览器，让两端都启用恢复机制。

登录前后都可切换中文/英文界面；终端字号支持 12/13/15/17 px，设置保存在当前浏览器。切换时保留当前连接和输入草稿，不会重启终端，也不会翻译程序原始输出。点击工作目录名称可展开完整路径。

**重启**会先显示确认弹窗，因为它会中断所有浏览器共用的会话；**取消**会保留当前会话。升级后，请在当前任务结束时重启 Relay 服务端，再刷新所有已连接的浏览器，让两端同时加载新的快捷键协议。

1. **Send** 在断线或等待确认时保留输入。确认只代表已写入 PTY，不代表 Codex 已执行或完成任务。送达状态不确定时先查看终端，再决定重试。消息去重依赖有容量上限的内存缓存，最长约五分钟，不能保证服务重启后只执行一次。
2. **Git Diff** 支持新建目录和按文件筛选。超过 256 KiB 的未跟踪文件会列为省略项，二进制文件不展示文本内容。Git 总输出超过 10 MiB 时可能返回错误。完整审查仍应使用本机 Git。

   切换文件时会取消过时的预览请求，较晚返回的旧响应不会覆盖当前选择。自动刷新保留未变化的预览，同一文件内容更新时保留横向和纵向滚动位置；选择另一文件时从顶部开始。所选文件离开改动列表后，筛选会回到全部改动。
3. **Restart** 会终止共享终端并新建一个。所有浏览器控制的是同一个会话。
4. 所有浏览器按已连接设备中最小的可用行列数显示。手机连接时，电脑上的终端可能变窄，这是为了让光标移动和菜单重绘一致。重连和尺寸变化时从服务端恢复已解析的当前屏幕，最多保留 1,000 行滚动历史。这是有容量上限的内存视图，不是完整、持久化的任务历史。
5. **Lock** 仅清除当前浏览器保存的凭据，不会撤销其他浏览器的访问，也不会轮换服务端凭据。
6. 正常结束、已报告的异常退出、未提供退出状态的连接关闭会分别显示。退出码缺失不能证明 Codex 崩溃。浏览器重连不会自动替换已结束的会话，需要主动点击 **Restart** 或 **Run codex**；重启会同步重置所有浏览器的终端画面。

## 配置项

程序读取**启动目录**下的 `.env`，已有进程环境变量优先。完整示例见 [`.env.example`](.env.example)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；`0.0.0.0` 开放局域网。仅通过隧道连接时使用回环地址。 |
| `PORT` | `3210` | HTTP/WebSocket 端口，范围 1–65535。 |
| `RELAY_AUTH_TOKEN` | 本地自动生成 | 共享访问凭据；公网模式至少 24 字符。单行，最多 256 字符，推荐自动生成值。 |
| `RELAY_PIN` | 未设置 | 主凭据为空时的旧版兼容值。不推荐短 PIN，短 PIN 不能开启公网隧道。 |
| `CODEX_CWD` | 启动目录 | 项目绝对路径，建议指向 Git 工作区。 |
| `CODEX_CMD` | `codex` | 可信的本地 Shell 命令，以电脑当前用户权限运行。 |
| `AUTO_START_CODEX` | `true` | 新建 Shell 后自动输入命令；设为 `false` 时仅启动 Shell。 |
| `AUTO_OPEN_QR` | `true` | 启动及隧道设置结束后打开本地配对页。 |
| `ENABLE_TUNNEL` | `false` | 显式启用 cloudflared。 |
| `CF_HOSTNAME` | 空 | 自有主机名；没有隧道 Token 时，留空使用临时地址。 |
| `CF_TUNNEL_NAME` | `codex-relay` | 证书模式使用的隧道名称。 |
| `CF_TUNNEL_TOKEN` | 空 | 后台管理的隧道凭据，需同时配置主机名。 |
| `CF_OVERWRITE_DNS` | `false` | 是否允许证书模式覆盖已有 DNS。 |
| `CF_MANAGE_DNS` | `true` | 证书模式下设为 `false`，只复用已有隧道和 DNS 路由，不创建或修改。 |

### 从 0.2.0 升级

已有工作区升级时，先完成当前任务，在运行 Relay 的终端按 Ctrl+C 停止服务，保留本地 `.env`，然后执行：

```bash
git pull --ff-only
npm ci
npm start
```

重启后刷新**所有**已连接的浏览器，让前后端使用相同的屏幕同步协议。0.2.2 新增了恢复共享屏幕所需的运行依赖。

- 删除本地 `.env` 中原作者域名。使用临时隧道时留空；使用自定义域名时填自己控制的域名。
- 新默认值仅允许本机访问。已有 `.env` 中显式设置的 `HOST`、`ENABLE_TUNNEL` 仍然生效；复制默认配置也不会覆盖进程环境变量。
- 更换旧短 PIN：停止 Relay，清空 `RELAY_AUTH_TOKEN`，同时从 `.env` 和进程环境中移除 `RELAY_PIN`，然后重启，程序会生成长凭据。轮换并重启后，旧链接和浏览器登录失效。
- 公网模式要求至少 24 字符的 Relay 凭据。不要公开 `/qr` 截图、包含凭据的 URL 或 `.env`。

## 访问权限与安全边界

**通过鉴权的浏览器可以操作真实 Shell，权限等同于运行 Relay 的电脑账号。** Relay 不创建沙箱，也不把终端限制在 Git/Codex 命令范围内。建议使用普通权限账号，只开放计划操作的工作区。Codex 自身的执行策略不能保护外围 Shell。

凭据不会自动过期，二维码和配对链接包含凭据，浏览器将其保存在 localStorage 中。程序从地址栏移除查询参数，并不意味着浏览器历史、代理日志或已复制的链接也被擦除。使用可信设备，公网使用 HTTPS。发生泄露时，更换凭据并重启 Relay，关闭已有连接。

只有回环连接、本地主机 Host 且没有转发头时，本地 `/qr` 才允许免登录访问，其他请求需要鉴权。HTTP API 和 WebSocket 握手均校验凭据；五分钟窗口内失败八次后，该地址在剩余窗口内被封禁。直连客户端不能用转发头选择限流地址；仅在启用隧道且连接来自回环地址时才信任 Cloudflare 客户端 IP。不要让不可信本地代理进入这个信任边界。限流只是强随机凭据之外的辅助措施。

正常退出会尝试关闭客户端、终端和托管隧道。系统崩溃或强制结束进程不在清理保证范围内，恢复时应检查是否残留 cloudflared 进程。详见 [SECURITY.md](SECURITY.md)。

## API 概览

脚本优先通过 `Authorization: Bearer <Relay访问凭据>` 或 `x-relay-token: <Relay访问凭据>` 传递凭据，避免查询参数。远程请求使用 HTTPS，反馈问题时删除真实凭据。

| 接口 | 用途 |
| --- | --- |
| `POST /api/auth/verify` | 带限流的登录验证，JSON：`{ "token": "<Relay访问凭据>" }`。 |
| `GET /api/health` | 鉴权后查询终端、工作区及隧道状态。 |
| `GET /api/qr` | 鉴权后获取包含凭据的配对数据；不可用的公网/局域网 URL 为 `null`。 |
| `GET /api/git/status` | 鉴权后查询分支与逐文件状态。 |
| `GET /api/git/diff?file=<编码后的路径>` | 鉴权后获取 HTML/原始 Diff、`hasChanges`、`omittedFiles`；可选文件筛选。 |
| `POST /api/action` | 鉴权后发送 `action`：`approve`、`reject`、`enter`、`esc`、`ctrl_c`、`start_codex`、`up`、`down`、`tab`。 |
| `/ws` | 已鉴权终端流；浏览器使用查询 Token，脚本可用请求头；拒绝其他浏览器来源。 |

WebSocket 输出包括 `status`、`history`、`output`、`session-reset`。历史/重置消息携带统一的 `cols` / `rows`，客户端应与终端输出按顺序处理。结束状态包含 `kind`（`normal` / `error` / `unknown`），以及可为 `null` 的 `exitCode` / `signal`。发送 `{ "type": "input", "id": "<唯一消息ID>", "data": "..." }` 可收到对应 ID 的 `input-ack` / `input-error`。输入最多 16 Ki 字符，单帧最多 128 KiB；仍兼容无 ID 的终端按键。其他消息为 `resize`、`action`、`restart`、`ping`。

## 常见问题

启动 Relay 前，先在存放所用 `.env` 的目录执行本地诊断：

```bash
npm run doctor -- --lang=zh-CN
npm run doctor -- --lang=zh-CN --json
# 使用编译产物或已安装的 CLI 时：
node dist/cli.js --doctor --lang=zh-CN
# codex-web-relay --doctor --lang=zh-CN
```

Doctor 检查 Node、Git/CODEX_CMD 程序是否存在、工作目录与 Git 工作区访问、node-pty 模块加载、HOST/PORT 可用性及访问凭据/隧道配置格式。它读取 `.env`，环境变量优先；短暂绑定配置的本机端口并立即关闭。文本和 JSON 报告均隐藏凭据、域名和完整路径，不修改 `.env`、不执行 CODEX_CMD、不创建终端、不下载 cloudflared、不开隧道、不连接 Cloudflare。端口占用也可能只是 Relay 已运行。存在错误时退出码为 `1`，仅有提示时为 `0`。诊断通过不代表已验证 Codex 登录、原生终端创建、DNS 或公网连通性。分享报告前仍请检查内容。

连接检查发送 `{ "type": "ping", "id": "<检查ID>" }`，服务端在 `pong` 中回传 ID。`{ "type": "sync" }` 返回当前 `status` 和已解析的 `history`，不会新建终端或发送输入。

快捷消息可携带 ID：`{ "type": "action", "id": "<唯一消息ID>", "action": "enter" }`，服务端返回 `action-ack` 或 `action-error`。回执只表示按键已写入 PTY，不代表程序已完成任务或批准请求。同一按键的重复 ID 会在有上限的内存缓存中抑制五分钟，重启会清空。回执丢失会提示送达不确定，请先查看终端再决定是否重按。升级服务端和网页后，请刷新所有浏览器。

| 现象 | 检查方法 |
| --- | --- |
| 在终端找不到访问凭据 | 程序不会打印凭据。使用本机 `/qr` 配对页，或查看启动目录 `.env` 中的 `RELAY_AUTH_TOKEN`，避免读到另一份项目的配置。 |
| 配对页没有手机二维码 | 默认仅本机访问。先启用局域网或可用的公网隧道；公网二维码缺失也可能表示隧道尚未连通。 |
| 快捷按钮提示送达不确定 | 先查看终端再决定是否重按。回执丢失不代表按键未执行，程序不会自动重发。 |
| 原生依赖安装失败 | 使用 Node 22/24。源码编译需要 Python 和 C++ 工具；Windows 安装 Visual Studio Build Tools，macOS 安装 Command Line Tools，Linux 安装 make/G++。参考 [node-pty 依赖说明](https://github.com/microsoft/node-pty#dependencies)。 |
| macOS 提示 `posix_spawnp failed` | Relay 启动时会修复 node-pty 已知辅助文件缺少执行权限的问题（[上游缺陷](https://github.com/microsoft/node-pty/issues/919)）。依赖应由当前用户安装并可写；仍失败时检查 Shell 和工作区路径。 |
| 终端提示找不到 `codex` | 检查当前用户 PATH、CLI 安装与登录、`CODEX_CMD`，先在本机执行确认。 |
| Git 状态失败 | 检查 Git、文件权限，以及 `CODEX_CWD` 是否为 Git 工作区。 |
| 手机无法连接局域网 | 检查 `HOST`、实际 IP、防火墙、同一网络和 Wi-Fi 客户端隔离。 |
| 没有公网二维码 | 检查隧道开关、长访问凭据、cloudflared 连通性和域名授权/DNS 路由，完成启动后刷新 `/qr`。 |
| 登录返回 429 | 等待五分钟失败窗口结束，并在本机核对凭据。 |
| 重启打断任务 | 这是一个共享的内存终端，不是持久化任务调度器。 |
| 另一端还显示确认菜单 | 更新后重启 Relay，刷新所有浏览器加载新客户端，确认使用统一尺寸。终端菜单文字不是可点击的网页按钮，请用 Enter 确认高亮项。仍有残留时，请附系统、浏览器信息及脱敏截图反馈。 |

## 开发与验证

```bash
npm ci --ignore-scripts
npm rebuild node-pty
npm test
npm pack --dry-run
```

测试覆盖 Git 样例仓库、鉴权限流、HTTP/WebSocket、草稿确认与重连、终端生命周期、无害原生命令，以及模拟隧道/DNS 生命周期。测试不创建真实 DNS、不打开公网隧道、不登录 Codex。CI 目标为 Windows/macOS/Linux 与 Node 22/24，请以实际工作流结果为准。真实手机浏览器、Codex 交互提示和公网连通性需要额外端到端验证。

[参与贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG.md) · [MIT 许可](LICENSE)
