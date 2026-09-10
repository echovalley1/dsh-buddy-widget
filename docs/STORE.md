# DSH STORE 兼容与证据声明（dsh-buddy-widget）

> 面向 DSH STORE fixed-Commit 自动检查与人工复核。本文档声明 Node.js / DSH 兼容范围、
> 依赖与权限、外部服务与失败边界，以及一次性 Profile 的安装 / 启动 / 卸载证据。
> 仓库默认分支 `main` 上的 `package.json`（`manifestPath`）为唯一事实源。

## 1. 兼容性声明

- **Node.js**：`>=20`（`package.json.engines.node`；开发与验证环境 Node v24.20.0）。
- **DSH**：`>=0.1.1-rc.1 <0.2.0`（`package.json.dsh.compatibility.dsh`）。
- **DSH Profile**：`web`（`package.json.dsh.compatibility.profiles`；标准 DSH Bundle，
  仅宿主侧，无 client/frontend 包，`dsh.client.platform` 不设置）。
- 验证过的宿主：DSH `0.1.2-rc.1`（`dsh --version`），Profile `web`
  （`dsh-buddy-widget` 已出现在该 Profile 的 `dsh.profile.bundles`）。
- 运行期只消费 DSH 公共宿主扩展面：`webServer`（`register({kind:'exact',…})`、`tapIndex`）、
  `credentials.resolve(...)`、`ctx.on('session/event' | 'session/disposed', …)`、`ctx.effect`。

## 2. 依赖声明

- **运行时 npm 依赖：无**（`dependencies` / `optionalDependencies` 为空）。
- 运行文件（`lib/index.js`、`lib/widget.js`）只使用 Node 内置模块：
  `node:fs`、`node:os`、`node:path`、`node:url`，以及宿主环境提供的全局 `fetch` / `AbortSignal`。
- 安装生命周期脚本：无（无 `preinstall` / `install` / `postinstall` / `prepare`）。
- 仓库无子模块、无符号链接、无原生/可执行构件；打包文件由 `package.json.files` 显式限定。

## 3. 权限矩阵

| 域 | 使用 | 范围 / 边界 |
|---|---|---|
| files | 读：插件包内 `assets/*`（打包默认图标） | 只读自身包内资源 |
| files | 写：图标上传持久化与配置/账本 | 仅写 `$DSH_HOME/.dshb-config.json`、`.dshb-daily.json`、`.dshb-pet*`（含 `profiles/web/` 回退路径）；写入上限 4MB/图标；账本保留 30 天 |
| network | 余额查询（可选） | `https://api.deepseek.com/user/balance`，`GET`，20s 超时、失败重试 1 次、25s 内存缓存、瞬时故障沿用最近值 |
| network | 用量查询（可选） | `https://platform.deepseek.com/api/v0/usage/by_api_key/cost`（平台已结算金额，首选）与 `.../amount`（token 分桶，回退估算），仅当配置 `DEEPSEEK_PLATFORM_TOKEN` 时使用，15s 超时 |
| credentials | `DEEPSEEK_API_KEY`（可选但推荐） | 仅 `resolve()` 后作为 Bearer 请求余额接口，不落盘、不输出 |
| credentials | `DEEPSEEK_PLATFORM_TOKEN`（可选） | 读：仅用于平台用量查询，缺失或失效时自动回落记账模式并在菜单提示；写：仅由用户在本机菜单内主动粘贴触发 `ctx.credentials.set()`，**只写不读**，任何响应/日志都不回显值，跨源请求 403 |
| commands | 无 | 不执行子进程/终端命令 |
| lifecycle | 无 | 无 install/prepare/postinstall 脚本 |

**写入边界（`/dsh-buddy/platform-token`）**：只接受 PUT/POST/DELETE（GET 等返回 405）；请求体
仅取 `token` 字段，先归一化（去 `Bearer ` 前缀、整段 `localStorage.userToken` JSON 取 `value`），
空值与 >4096 字符拒绝；仅当请求带 `Origin` 且与 `Host` 不同源时返回 403；被拒请求不触碰凭据存储；
写入/移除后仅让余额缓存失效，不做任何值回显。

**失败边界**：所有 HTTP 路由永远返回 200 + JSON（或静态资源字节），绝不悬挂；余额无 Key /
4xx / 结构异常时返回结构化错误并在前端静默降级；网络瞬时故障沿用过期的最近余额并标注
`stale`；上传文件按文件头嗅探类型（拒绝伪造 Content-Type），非图片/超限返回 4xx；
会话聚合按 (sessionId, turn) 分桶、会话销毁即清理，避免内存泄漏与串账。

## 4. 一次性 Profile 安装 / 启动 / 卸载证据

### 4.1 已在本机验证的记录（真实执行，Profile `web`，DSH 0.1.2-rc.1）

- 安装：`dsh plugin --profile web add link:<无空格路径>`（pnpm v12.3.4）
  → 输出含 `dependencies: + dsh-buddy-widget link:...`、`Done in 16s`；
  `dsh.profile.bundles` 已追加 `dsh-buddy-widget`。
- 启动（宿主已加载插件后）：
  - `GET /dsh-buddy/widget.js` → HTTP 200 `application/javascript`；
  - `GET /dsh-buddy/state.json` → HTTP 200 JSON（activity/today/week/last）；
  - `GET /dsh-buddy/balance.json` → HTTP 200 JSON（未配置 Key 时 `ok:false code:NO_KEY`）；
  - `GET /dsh-buddy/pet?slot=idle|busy|done` → HTTP 200 图像字节（无自定义时回退打包默认）。
  - 页面注入：index.html 含 `<script defer src="/dsh-buddy/widget.js">`（tapIndex，幂等）。
- 冒烟测试：`node smoke.mjs`（mock ctx，不触网/不落真实 Profile）全部断言通过
  （状态机、成本换算、config 回路、三槽位图标回路、默认图标兜底、落盘）。

### 4.2 一次性 Profile 独立复验脚本（供复核方在任何机器执行）

不污染真实 Profile：另建一次性 home + profile，装包 → 启动 → 打点 → 卸载。

```bash
# Linux / macOS 示例（Windows 把 ~/.dshx 换成 %TEMP%\dshx-%RANDOM% 即可）
export DSH_HOME=~/.dshx
dsh plugin --profile web add link:$PWD            # 安装（在仓库根目录执行）
dsh web &                                          # 启动宿主（一次性 Profile）
curl -fsS http://127.0.0.1:3080/dsh-buddy/widget.js | head -c 120   # 期望 JS
curl -fsS http://127.0.0.1:3080/dsh-buddy/state.json                 # 期望 {"ok":true,...}
curl -fsS http://127.0.0.1:3080/dsh-buddy/balance.json               # 期望 ok:false code:NO_KEY（无凭据时）
dsh plugin --profile web remove dsh-buddy-widget   # 卸载
unset DSH_HOME; rm -rf ~/.dshx                    # 清理一次性 home
```

> 说明：`4.2` 为提供给复核方/CI 的一次性 Profile 复验路径。作者侧已完成 `4.1` 的
> 安装/启动验证，并保留主 Profile 运行态供功能验收；主 Profile 上执行 `remove`
> 会停用当前挂件，因此卸载动作建议在一次性 Profile（4.2）中执行以保持环境稳定。
> 复核方亦可直接执行 4.2 获得独立 install/start/uninstall 证据。

## 5. 已知边界（非隐藏项）

- 本插件按其用途需要 `files`（本地状态持久化）、`network`（可选余额/用量）与
  `credentials`（API Key）能力，自动门禁仍可能将目录标记为 guarded/blocked；
  本声明用于向复核者完整说明能力与边界，并不宣称获得自动批准。
- 「今日已用」记账模式依赖余额观测差值，DSH 关闭期间的消耗会漏记；精确值需令牌模式或会话 usage。
- 完成庆祝 GIF 播放时长按帧延时估算（约 3 遍），非逐帧精确控制。
