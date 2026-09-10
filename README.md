# dsh-buddy-widget · DSH 陪伴助手挂件

一只住在 DSH Web 界面右下角的小猫娘🐱：实时告诉你**模型是不是正在回复（计时）**、**上一轮花了多少钱**、**今天聊了几轮 / 烧了多少 token / 估算花了多少**，配好 API Key 还能顺带显示**余额**。自带默认图标、纯 CSS 界面，标准 DSH bundle 插件，`dsh plugin` 一条命令安装，随界面自动启用。

架构学习自 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（标准 DSH bundle 插件三层链路：`package.json → dsh.bundle.patch → cordis.patch.yml`；宿主注册 webServer 路由 + `tapIndex` 注入页面脚本；前端代码独立为 `lib/widget.js`，宿主按请求读盘 → 改 UI 只需 F5 热更）。

## 功能

| 块 | 说明 |
|---|---|
| 🐱 会话状态宠物 | 摸鱼 → 回复中（状态胶囊「回复中 Ns」）；数据源：`assistant/chunk` 心跳 + 超时判定 |
| 🖼️ 图标可替换（三套） | ⋯ 菜单「图标」「回复图标」「完成图标」各自可上传本地图片（**PNG/JPG/GIF/WebP**，GIF 会动，≤4MB）：平时显示普通图标；回复中自动切回复图标；**每轮回复结束后自动播放完成庆祝 GIF 约 3 遍**（时长按 GIF 帧延时自动估算）。均**内置打包默认图**（`assets/pet-default.gif`、`pet-busy-default.gif`、`pet-done-default.gif`），「恢复默认」回到内置默认并持久化（`$DSH_HOME/.dshb-pet`、`.dshb-pet-busy`、`.dshb-pet-done`） |
| 💬 每轮对话消耗 | 监听 `session/event`，取 `assistant/message` 的真实 `usage`（含缓存命中/推理 token），`turn/end` 结算出本轮 **金额 · tokens · 用时** 泡泡（6s 自动收起）；主会话与子代理按 sessionId 分桶不串账 |
| 📊 今日统计 | 轮次 / 消息数 / token 细分 / 估算金额，实时落盘 `$DSH_HOME/.dshb-daily.json`（跨天自动归档保留 30 天）；点击图标打开统计泡泡 |
| 💰 余额（可选） | 配置 `DEEPSEEK_API_KEY` 后拉取 `api.deepseek.com/user/balance`（25s 缓存 + 瞬时故障沿用最近值）；未配置则静默隐藏余额行，不影响其他功能 |
| 🔀 今日已用双口径 | ⋯ 菜单「用量」可自由切换：**记账（余额差）** 用余额下降额累计今日消费，只需 `DEEPSEEK_API_KEY`；**实时·令牌** 取开放平台 `usage/by_api_key/cost` 的已结算金额（与平台「用量信息」页同源同数），需额外配置 `DEEPSEEK_PLATFORM_TOKEN`（[配置步骤](#配置-deepseek_platform_token实时令牌模式使用说明)）。令牌取数失败时自动回落记账并在菜单底部提示原因；切换即时生效并持久化到 `$DSH_HOME/.dshb-config.json` 的 `usageMode` |
| 🖱️ 交互 | 拖拽 + 上/下/左/右四分之一吸附（left/top 像素模型）、左吸附整体镜像 + 文字反向、三点菜单（大小 0.6–2.5 / 字号 / 气泡 / 用量口径 / 显示余额 / 位置 / 三套图标）、配置与位置均持久化 |

## 安装（本地 link 开发安装）

在**本目录**（`package.json` 所在处）执行：

```powershell
dsh plugin --profile web add link:<本目录绝对路径>
```

- 若报 pnpm 阻止构建脚本（allowBuilds），在 `%USERPROFILE%\.dsh\profiles\web\pnpm-workspace.yaml` 的 `allowBuilds` 下放行对应包 key 后重试。
- 安装后**重启 `dsh web`**，再 F5 刷新浏览器，右下角出现猫娘挂件。
- 验证：

```powershell
dsh --profile web --dump-config | Select-String -Pattern "buddy"
curl http://127.0.0.1:3080/dsh-buddy/widget.js    # 200 JS
curl http://127.0.0.1:3080/dsh-buddy/state.json    # 200 JSON（activity/today/week/last）
curl http://127.0.0.1:3080/dsh-buddy/balance.json  # 200 JSON（无 key 时 ok:false code:NO_KEY）
```

## 卸载

```powershell
dsh plugin --profile web remove dsh-buddy-widget
```

## 路由一览（宿主，Node 进程侧）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/dsh-buddy/widget.js` | GET | 页面端源码（IIFE，`no-store`） |
| `/dsh-buddy/state.json` | GET | `{activity, last{seq,turn,amount,tokens,ms}, today{turns,msgs,tokens,cost}, week[7]}`（前端每秒轮询，seq 递增判定“新的一轮”） |
| `/dsh-buddy/balance.json` | GET | `{ok,totalBalance,currency,todayUsage,todayUsageTokens,usageMode,usageSource,…}` 或 `{ok:false,code,error}`，任何情况返回 200 JSON |
| `/dsh-buddy/config.json` | GET/PUT | `{scale, showBalance, usageMode, fontScale, bubbleScale}` 持久化（`$DSH_HOME/.dshb-config.json`）；GET 附 `hasKey` / `hasPlatformToken` / `hasPet` 供前端提示 |
| `/dsh-buddy/pet` | GET/PUT/DELETE | 自定义图标原始字节（按文件头嗅探 mime，支持 png/gif/jpeg/webp/avif，≤4MB）；PUT 上传、DELETE 恢复默认；持久化到 `$DSH_HOME/.dshb-pet` |
| `/dsh-buddy/platform-token` | PUT/DELETE | 写入 / 移除凭据 `DEEPSEEK_PLATFORM_TOKEN`（菜单「平台令牌」用，`ctx.credentials.set/unset`）；**只写不读**，响应从不回显值；带跨源 `Origin` 时 403 |
| `tapIndex` | — | 幂等注入 `<script defer src="/dsh-buddy/widget.js">` |

## 定价说明（估算）

按每百万 token：空闲/高峰双价（工作日北京 9–12、14–18 为高峰，2026-08-23 起周末全天谷价）；`deepseek-v4-pro` 为 flash/chat/reasoner 的 3 倍价。调价改 `lib/index.js` 顶部 `PEAK_HOURS` / `BASE_PRICE` / `PRO_PRICE` / `WEEKEND_VALLEY_FROM_SEC`。

> 价表只用于**记账模式的兜底**与「实时·令牌」模式在平台 cost 接口不可用时的回退估算。令牌模式优先取 `usage/by_api_key/cost`（平台已结算金额），无需本地价表。

## 配置 `DEEPSEEK_PLATFORM_TOKEN`（实时·令牌模式使用说明）

### 0. 先分清两把「钥匙」

挂件会用到两个凭据，**别混用**：

| 凭据 | 从哪来 | 长什么样 | 用途 | 是否必需 |
|---|---|---|---|---|
| `DEEPSEEK_API_KEY` | `platform.deepseek.com/api_keys` 创建 | `sk-` 开头的 32 位 | 查余额 `/user/balance`、调模型 | 推荐（不配则余额行和记账模式不可用） |
| `DEEPSEEK_PLATFORM_TOKEN` | 开放平台**登录态**，见下方提取步骤 | 通常 64 位字母数字，无前缀 | 查「今日用量」`/api/v0/usage/by_api_key/*` | 「实时·令牌」模式才需要 |

> 把 `sk-` 的 API Key 填进 `DEEPSEEK_PLATFORM_TOKEN` 会 401；反过来也不行。

### 1. 提取 token（两种方式任选）

**方式一：控制台一行（最快）**

1. 浏览器登录并停留在 `https://platform.deepseek.com`（必须停在这个站点，因为 `localStorage` 按站点隔离）。
2. 按 `F12` → 切到 **Console** 标签。
3. 粘贴执行：

```js
copy(JSON.parse(localStorage.userToken).value)
```

4. 剪贴板里就是 token 本体（`copy()` 是 DevTools 的剪贴板函数，无需权限）。
   如果 `copy` 不可用，改用 `console.log(JSON.parse(localStorage.userToken).value)`，然后手动选中复制那一串。

**方式二：手动从存储面板取**

1. `F12` → **Application**（应用）标签 → 左侧 **Storage → Local Storage → `https://platform.deepseek.com`**。
2. 找到键 `userToken`，它的值形如：

```json
{"value":"<64位字母数字token>","__version":"0"}
```

3. 复制 `value` 字段里那一串（**不要连引号和大括号**；当然整段 JSON 直接粘也可以，插件会自动取出 `value`）。

> 该 token 等同登录凭证，会随**登出/改密/会话过期**失效。请勿贴到聊天、issue 或截图里。

### 2. 写入凭据（三种方式任选，推荐 A）

**A. 挂件菜单内粘贴（推荐，不用碰文件）**

1. 确认已重启过 `dsh web` 并 F5 刷新页面（新增的写入路由由宿主注册，改动 `lib/index.js` 后必须重启一次）。
2. 点上挂件右上角的 **⋯** 按钮打开菜单。
3. 找到 **「平台令牌」** 行 → 点 **「设置…」**，该行下方展开一个密码输入框。
4. 粘贴 token（回车与点「保存」等价；`Esc` 或「取消」收起）。
5. 看到 **「已保存到 DSH 凭据，立即生效」** 即成功——宿主通过 `ctx.credentials.set()` 写入 DSH 凭据存储，**无需重启**，并立刻重拉一次用量。
   - 若显示 **「保存失败：…」**，括号里是宿主原始错误，常见原因见第 6 节。
6. 想反悔随时点同一行的 **「清除」**（`ctx.credentials.unset()`，幂等，没有也不会报错）。

**B. 手工写凭据文件**

编辑 `$DSH_HOME/.credentials.yaml`（Windows 默认 `C:\Users\<你>\.dsh\.credentials.yaml`），在 `refs:` 下加一行：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-…
  DEEPSEEK_PLATFORM_TOKEN: "把64位token粘到这里"
```

- 引号可省（token 是纯字母数字），但加双引号最保险。
- 该文件带版本号与 `refs`/`records` 两个分节，**只放凭据**：未知顶层键、类型错误、空值都会导致启动失败，别往里塞别的东西。
- 文件**热重载**：保存后运行中的 `dsh web` 会自己接收变更，**不用重启**，F5 刷新页面即可看到。
- 值里带特殊字符就一定要加引号，否则 YAML 解析会失败。

**C. 环境变量 / `.env`（可选，给 CI 或临时会话用）**

```powershell
$env:DEEPSEEK_PLATFORM_TOKEN = "64位token"; dsh web
```

或写进 `$DSH_HOME/.env`（需**重启**才读到）。

> 优先级：启动环境 > 凭据文件 > 项目 `.env` > 主目录 `.env`。启动环境层**只读**：此时菜单里「保存/清除」会被拒绝并显示错误（这是 DSH 的设计，不是插件 bug）；想改用菜单写入，先清掉该环境变量再启动。

### 3. 切换口径

⋯ 菜单 →「用量」下拉 → **实时·令牌**（默认是「记账(余额差)」）：

- 立即生效，并写入 `$DSH_HOME/.dshb-config.json` 的 `usageMode`，刷新后保持。
- 切换后挂件会立刻重新拉一次用量；气泡第一行标题会变成 **今日已用(令牌)**。
- 用「记账(余额差)」时为 **今日已用(记账)**。

### 4. 确认生效

1. 点挂件主体打开统计气泡，标题应为 **今日已用(令牌)**，下面是金额、tokens、轮数与余额（tokens 数取平台口径；平台 cost 接口只回金额不带 token 时，回退本地按事件累计的 tokens/缓存/推理）。
2. 对照 `https://platform.deepseek.com/usage` 页面上「消费金额」的当日数字，两者应一致（当日数据平台自身有 5 分钟级结算延迟，挂件数字会跟着它一起慢慢上浮，属正常）。
3. 命令行核对：

```powershell
curl.exe -s http://127.0.0.1:3080/dsh-buddy/balance.json
```

关注这几个字段：

| 字段 | 含义 |
|---|---|
| `usageMode` | 成功时的口径：`token`；若回落则为 `ledger` |
| `usageSource` | `cost` = 平台已结算金额（首选）；`estimate` = 平台 cost 不可用，按 token 分桶 + 官方价表估算 |
| `todayUsage` | 今日已用金额（元） |
| `todayUsageTokens` | 今日 tokens（`cost` 路径为 0，前端回退本地累计） |
| `usageNote` | 回落原因（如 `no platform token`、`HTTP 401`） |

### 5. 日常行为

- **取数失败自动回落**：token 缺失/失效/接口异常时，挂件自动按「记账」口径显示，并在菜单底部提示原因，不会显示错数字或空白。
- **两种口径的区别**：令牌模式 = 平台已结算金额（与开放平台页面同源，含平台侧的峰谷价与结算延迟）；记账模式 = 余额实际下降额（即时，但 DSH 关闭期间的消耗会漏记）。
- **单轮金额仍是估算**：泡泡里的「上一轮回复」金额按官方 CNY 价表（每百万 token，空闲/高峰双价）换算，可能因峰谷判定与结算对齐有偏差；「今日已用」才是权威值。

### 6. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 菜单底部提示「未配置 DEEPSEEK_PLATFORM_TOKEN，将自动回落记账」 | 还没写入，或写入的 ref 名拼错（必须是 `DEEPSEEK_PLATFORM_TOKEN`） |
| 提示里带 `HTTP 401` / `HTTP 403` | 填成了 API Key（`sk-`）或 token 已过期 → 重新执行第 1 节提取，再保存 |
| 提示 `no usage` | 平台当日确实还没有计费记录（刚充值/刚开通），稍后再看 |
| 保存失败并提示只读（DSH 原文如 `… is read-only …`、含 `launch environment` 字样） | 启动时带了 `DEEPSEEK_PLATFORM_TOKEN` 环境变量，该层优先且只读；清掉后重启 `dsh web`，或改用方式 B 直接改文件 |
| 保存失败提示跨源 403（`cross-origin rejected`） | 从非本机页面发起的写入被拒绝（安全设计）；请在 `127.0.0.1:3080` 的挂件菜单里操作 |
| 数字比平台页面低一点 | 平台当日结算滞后（页面注明“数据可能有 5 分钟延迟”），等几分钟即会追平 |
| 想彻底不用令牌模式 | 菜单「用量」切回「记账(余额差)」，再点「清除」移除凭据 |

### 7. 移除凭据

- 推荐：⋯ 菜单 →「平台令牌」→ **「清除」**。
- 或手工删掉 `$DSH_HOME/.credentials.yaml` 中 `DEEPSEEK_PLATFORM_TOKEN:` 那一行（文件热重载，立即生效）。

## 开发

```powershell
node --check lib/index.js                 # 宿主语法
node smoke.mjs                            # 离线冒烟（mock ctx，不动真机）
```

### 热更新（不用重启 dsh web 的场景）

页面端源码独立在 `lib/widget.js`（宿主每次请求读盘 + `no-store`）：
**改 UI/样式/文案 → 保存后直接 F5 浏览器即可**，无需重启 dsh web。
宿主逻辑（`apply()` / 路由 / 事件监听等 `lib/index.js` 改动）因 ESM 模块缓存仍需重启一次生效。

### 结构

```text
lib/
├── index.js    # 宿主：apply/routes/事件/持久化（改动需重启 dsh web 生效）
└── widget.js   # 页面端 IIFE（唯一事实源，宿主每次请求读盘；改动 F5 即生效）
```

## DSH STORE 收录（manifest 声明）

- **DSH 兼容**：`>=0.1.1-rc.1 <0.2.0`，**Profile**：`web`（见 `package.json → dsh.compatibility`）
- **Node.js**：`>=20`（`engines.node`）
- **运行时依赖**：无（仅 Node 内置模块与宿主 `webServer` / `credentials` / `session` 扩展面）
- **权限/外部服务/失败边界 + 一次性 Profile 证据**：详见 [docs/STORE.md](docs/STORE.md)

## 许可

本项目基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。
