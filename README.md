# dsh-buddy-widget · DSH 陪伴助手挂件

一只住在 DSH Web 界面右下角的小猫娘🐱：实时告诉你**模型是不是正在回复（计时）**、**上一轮花了多少钱**、**今天聊了几轮 / 烧了多少 token / 估算花了多少**，配好 API Key 还能顺带显示**余额**。自带默认图标、纯 CSS 界面，标准 DSH bundle 插件，`dsh plugin` 一条命令安装，随界面自动启用。

架构学习自 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（标准 DSH bundle 插件三层链路：`package.json → dsh.bundle.patch → cordis.patch.yml`；宿主注册 webServer 路由 + `tapIndex` 注入页面脚本；前端代码独立为 `lib/widget.js`，宿主按请求读盘 → 改 UI 只需 F5 热更）。

## 功能

| 块 | 说明 |
|---|---|
| 🐱 会话状态宠物 | 摸鱼 → 回复中（状态胶囊「回复中 Ns」）；数据源：`assistant/chunk` 心跳 + 超时判定 |
| 🖼️ 图标可替换（两套） | ⋯ 菜单「图标」与「回复图标」各可上传本地图片（**PNG/JPG/GIF/WebP**，GIF 会动，≤4MB）：平时显示普通图标，检测到回复中自动切换为回复图标；均**内置打包默认图**（`assets/pet-default.gif`、`assets/pet-busy-default.gif`），「恢复默认」回到内置默认并持久化（`$DSH_HOME/.dshb-pet`、`.dshb-pet-busy`） |
| 💬 每轮对话消耗 | 监听 `session/event`，取 `assistant/message` 的真实 `usage`（含缓存命中/推理 token），`turn/end` 结算出本轮 **金额 · tokens · 用时** 泡泡（6s 自动收起）；主会话与子代理按 sessionId 分桶不串账 |
| 📊 今日统计 | 轮次 / 消息数 / token 细分 / 估算金额，实时落盘 `$DSH_HOME/.dshb-daily.json`（跨天自动归档保留 30 天）；点击图标打开统计泡泡 |
| 💰 余额（可选） | 配置 `DEEPSEEK_API_KEY` 后拉取 `api.deepseek.com/user/balance`（25s 缓存 + 瞬时故障沿用最近值）；未配置则静默隐藏余额行，不影响其他功能 |
| 🖱️ 交互 | 拖拽 + 上/下/左/右四分之一吸附（left/top 像素模型）、左吸附整体镜像 + 文字反向、三点菜单（大小 0.6–2.5 / 显示余额 / 回右下角）、配置与位置均持久化 |

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
| `/dsh-buddy/balance.json` | GET | `{ok,totalBalance,currency,…}` 或 `{ok:false,code,error}`，任何情况返回 200 JSON |
| `/dsh-buddy/config.json` | GET/PUT | `{scale, showBalance}` 持久化（`$DSH_HOME/.dshb-config.json`）；GET 附 `hasKey` / `hasPet` 供前端提示 |
| `/dsh-buddy/pet` | GET/PUT/DELETE | 自定义图标原始字节（按文件头嗅探 mime，支持 png/gif/jpeg/webp/avif，≤4MB）；PUT 上传、DELETE 恢复默认；持久化到 `$DSH_HOME/.dshb-pet` |
| `tapIndex` | — | 幂等注入 `<script defer src="/dsh-buddy/widget.js">` |

## 定价说明（估算）

按每百万 token：空闲/高峰双价（工作日北京 9–12、14–18 为高峰，2026-08-23 起周末全天谷价）；`deepseek-v4-pro` 为 flash/chat/reasoner 的 3 倍价。调价改 `lib/index.js` 顶部 `PEAK_HOURS` / `BASE_PRICE` / `PRO_PRICE` / `WEEKEND_VALLEY_FROM_SEC`。

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
└── widget.js   # 页面端 IIFE（改动 F5 即生效；index.js 内嵌 WIDGET_JS 仅为兜底快照）
```

## 许可

本项目基于 **MIT License** 开源，详见 [LICENSE](LICENSE)。
