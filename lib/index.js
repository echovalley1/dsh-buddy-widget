// ============================================================================
// dsh-buddy-widget —— DSH 陪伴助手挂件（宿主侧 + 独立页面端文件）
//
// 仿照 dsh-whale-widget 的「标准 DSH bundle 插件」架构：
//   * package.json 声明 dsh.bundle.patch → ./cordis.patch.yml
//   * 本文件具名导出 { name, inject:['webServer','credentials'], apply }
//   * 宿主（Node 进程）注册 webServer 路由 + 监听 session/event；
//     页面端源码独立存于 lib/widget.js（宿主每次请求读盘、no-store 经
//     /dsh-buddy/widget.js 吐出），再用 webServer.tapIndex() 幂等注入 index.html。
//
// 功能（一个挂件包含三块）：
//   1) 会话状态宠物：摸鱼 / 回复中(计时)（assistant/chunk、turn/end 事件）
//   2) 每轮 + 今日统计：真实 usage 聚合成 token / 估算金额，落盘 .dshb-daily.json
//   3) 余额显示：配置 DEEPSEEK_API_KEY 时拉取余额；未配置静默隐藏余额行
//
// 尺寸模型：--dshb-u = base/100，UI 上所有几何/字号按 u 的倍数书写，
// 挂件随 base clamp(120px … 560px) × scale(0.6–2.5) 整体缩放。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// ---- 状态文件候选路径（首个可写即用；node_modules 可能只读/更新被清） ----
const CONFIG_CANDIDATES = [
  path.join(DSH_HOME, '.dshb-config.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshb-config.json'),
]
const DAILY_CANDIDATES = [
  path.join(DSH_HOME, '.dshb-daily.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshb-daily.json'),
]
// 记账账本（小鲸鱼记账模式）：余额差值累计
const USAGE_CANDIDATES = [
  path.join(DSH_HOME, '.dshb-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshb-usage.json'),
]
// 平台用量接口（实时·令牌模式；需 DEEPSEEK_PLATFORM_TOKEN）
//   cost   —— 平台已结算金额（权威口径，与开放平台「消费金额」一致；无 token 分桶）
//   amount —— token 分桶（按官方峰谷价表估算金额；cost 不可用时回退）
const PLATFORM_COST_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost'
const PLATFORM_USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'
// 平台登录态 token 在 DSH 凭据中的引用名（菜单内可写入）
const PLATFORM_REF = 'DEEPSEEK_PLATFORM_TOKEN'

// ---- 自定义宠物图标（三套槽位：idle 普通 / busy 回复 / done 完成庆祝；原始字节无扩展名） ----
const PET_SLOT_CANDIDATES = {
  idle: [
    path.join(DSH_HOME, '.dshb-pet'),
    path.join(DSH_HOME, 'profiles', 'web', '.dshb-pet'),
  ],
  busy: [
    path.join(DSH_HOME, '.dshb-pet-busy'),
    path.join(DSH_HOME, 'profiles', 'web', '.dshb-pet-busy'),
  ],
  done: [
    path.join(DSH_HOME, '.dshb-pet-done'),
    path.join(DSH_HOME, 'profiles', 'web', '.dshb-pet-done'),
  ],
}
const PET_SLOT_META = {
  idle: { mimeKey: 'petMime', tsKey: 'petTs', defaultName: ['pet-default.gif', 'pet-default.png', 'pet-default.jpg', 'pet-default.webp'] },
  busy: { mimeKey: 'petBusyMime', tsKey: 'petBusyTs', defaultName: ['pet-busy-default.gif', 'pet-busy-default.png', 'pet-busy-default.jpg', 'pet-busy-default.webp'] },
  done: { mimeKey: 'petDoneMime', tsKey: 'petDoneTs', defaultName: ['pet-done-default.gif', 'pet-done-default.png', 'pet-done-default.jpg', 'pet-done-default.webp'] },
}
const PET_MAX_BYTES = 4 * 1024 * 1024 // 上限 4MB，防撑爆

// 按文件头嗅探真实图片类型（不接受用户声明的类型）
function sniffPetMime(b) {
  if (!b || b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11])
    if (brand.indexOf('avif') !== -1 || brand.indexOf('avis') !== -1) return 'image/avif'
  }
  return null
}
// 从 URL 的 ?slot= 解析槽位：idle / busy / done，缺省 idle
function petSlotFromUrl(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)slot=([^&]+)/.exec(q)
    if (!m) return 'idle'
    const v = decodeURIComponent(m[1])
    return v === 'busy' || v === 'done' ? v : 'idle'
  } catch (err) { return 'idle' }
}
function petRead(slot) {
  const list = PET_SLOT_CANDIDATES[slot] || PET_SLOT_CANDIDATES.idle
  for (const p of list) {
    try {
      const b = fs.readFileSync(p)
      if (b && b.length > 0) return b
    } catch (err) {}
  }
  return null
}
function petDelete(slot) {
  const list = PET_SLOT_CANDIDATES[slot] || PET_SLOT_CANDIDATES.idle
  for (const p of list) {
    try { fs.unlinkSync(p) } catch (err) {}
  }
}
// 打包默认图标（assets/，英文文件名；无自定义上传时作为兜底“默认”展示）
function petDefaultRead(slot) {
  const meta = PET_SLOT_META[slot]
  if (!meta) return null
  for (const name of meta.defaultName) {
    try {
      const p = path.join(PACKAGE_ROOT, 'assets', name)
      const b = fs.readFileSync(p)
      if (b && b.length > 0) return b
    } catch (err) {}
  }
  return null
}
// GIF 一周期毫秒（扫描 Graphic Control Extension 的帧延时求和；单位 1/100s）
function gifCycleMs(buf) {
  if (!buf || buf.length < 16) return 0
  let ms = 0
  for (let i = 0; i < buf.length - 8; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) {
      const delay = buf[i + 4] | (buf[i + 5] << 8)
      ms += (delay === 0 ? 1 : delay) * 10
    }
  }
  return ms
}

// 页面端源码：每次请求从 lib/widget.js 读盘（no-store）→ 改 UI 只需 F5，无需重启宿主。
// lib/widget.js 是唯一事实源；文件缺失时返回 null，由路由显式回 500（不再提供过时快照）。
function loadWidgetSource() {
  try {
    const p = path.join(PACKAGE_ROOT, 'lib', 'widget.js')
    const s = fs.readFileSync(p, 'utf8')
    if (s && s.length > 0) return s
  } catch (err) {}
  return null
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

// ---- 余额接口与缓存 ----
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25000

// ---- DeepSeek CNY 定价（每百万 token；[空闲价, 高峰价]） ----
// 高峰：工作日北京时间 9-12 与 14-18 时；2026-08-23(北京) 起周末全天按谷价。
// 仅为“估算”，DeepSeek 调价时改这里。
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // = 北京 2026-08-23 00:00

function priceFor(model) {
  const m = String(model || '').toLowerCase()
  return m.indexOf('deepseek-v4-pro') !== -1 ? PRO_PRICE : BASE_PRICE
}

// timeSec 时刻是否处于高峰（北京时间 = UTC+8）
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // 0=周日 6=周六
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

// 按模型与时刻换算一次用量金额（元）：tokens 单位为“个”，按每百万 token 计价。
// 官方 CNY 价表（2026-09-10 核对 api-docs.deepseek.com/zh-cn/quick_start/pricing，与下方常量一致）：
//   缓存命中输入 0.05/0.10、缓存未命中输入 1.5/3.0、输出 4.5/9.0（flash/vision；pro 分别为 3 倍）
//   峰谷：高峰=周一至周五 01:00-04:00 与 06:00-10:00 UTC（= 北京 09-12、14-18），其余空闲；空闲价为高峰半价
// 注意：DSH 的 outputTokens = completion_tokens，其中**已包含 reasoningTokens**，故此处只按 output 计，
// 不再叠加推理 token（否则重复计费）。
function estCost(model, tokens, timeSec) {
  const pr = priceFor(model)
  const off = isPeakTime(timeSec) ? 1 : 0
  return (tokens.cache / 1e6) * pr.hit[off]
    + (tokens.input / 1e6) * pr.miss[off]
    + (tokens.output / 1e6) * pr.out[off]
}

// ============================================================================
// 宿主插件主体
// ============================================================================
const name = 'dsh-buddy-widget'
const inject = ['webServer', 'credentials']

function apply(ctx) {
  // 每轮聚合：sessionId -> { turn, cost, tokens, startedAt, lastTs }
  const turnAggs = new Map()
  // 活动心跳：sessionId -> { since, last }（chunk/message 事件刷新）
  const busySessions = new Map()
  const BUSY_IDLE_MS = 8000 // 超过此时长无事件 → 视为已结束回复
  const BURST_GAP_MS = 6000 // 事件间隔超过此时长 → 新一轮“回复中”计时
  let lastTurn = null
  let lastTurnSeq = 0

  let balanceCache = null
  let balanceInFlight = null
  const disposers = []

  function pad2(n) { return String(n).padStart(2, '0') }
  function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) }
  function todayKey() { return dateKey(new Date()) }
  function readDaily() {
    for (const p of DAILY_CANDIDATES) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed
      } catch (err) {}
    }
    return { date: todayKey(), turns: 0, msgs: 0, tokens: { input: 0, cache: 0, output: 0, reason: 0 }, cost: 0, history: {} }
  }
  function writeDaily(day) {
    const body = JSON.stringify(day)
    for (const p of DAILY_CANDIDATES) {
      try { fs.writeFileSync(p, body, 'utf8'); return true } catch (err) {}
    }
    return false
  }
  // tokens 口径：非缓存计入（新输入 + 输出；输出已含推理）；缓存命中单列，不计入 tokens
  function sumTokens(t) {
    t = t || {}
    return (Number(t.input) || 0) + (Number(t.output) || 0)
  }
  function sumCacheTokens(t) {
    t = t || {}
    return Number(t.cache) || 0
  }
  function ensureToday() {
    let day = readDaily()
    const t = todayKey()
    if (day.date !== t) {
      if (day.date && typeof day.cost === 'number') {
        day.history = day.history || {}
        day.history[day.date] = {
          turns: day.turns || 0, cost: day.cost,
          tokens: sumTokens(day.tokens), cacheTokens: sumCacheTokens(day.tokens),
        }
      }
      day.date = t
      day.turns = 0
      day.msgs = 0
      day.tokens = { input: 0, cache: 0, output: 0, reason: 0 }
      day.cost = 0
      const keys = Object.keys(day.history || {}).sort()
      while (keys.length > 30) delete day.history[keys.shift()]
      writeDaily(day)
    }
    return day
  }
  function weekSummary() {
    const day = ensureToday()
    const cur = new Date()
    const list = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - i)
      const key = dateKey(d)
      if (key === day.date) {
        list.push({
          date: key, turns: day.turns || 0, cost: day.cost || 0,
          tokens: sumTokens(day.tokens), cacheTokens: sumCacheTokens(day.tokens),
        })
      } else {
        const h = (day.history || {})[key]
        list.push(h ? {
          date: key, turns: h.turns || 0, cost: h.cost || 0,
          tokens: h.tokens || 0, cacheTokens: h.cacheTokens || 0,
        } : { date: key, turns: 0, cost: 0, tokens: 0, cacheTokens: 0 })
      }
    }
    return list
  }
  function addUsage(model, usage) {
    const day = ensureToday()
    const u = usage || {}
    const input = Number(u.inputTokens) || 0
    const cache = Number(u.cacheReadTokens) || 0
    const output = Number(u.outputTokens) || 0
    const reason = Number(u.reasoningTokens) || 0
    day.msgs = (day.msgs || 0) + 1
    day.tokens = day.tokens || {}
    day.tokens.input = (day.tokens.input || 0) + input
    day.tokens.cache = (day.tokens.cache || 0) + cache
    day.tokens.output = (day.tokens.output || 0) + output
    day.tokens.reason = (day.tokens.reason || 0) + reason
    day.cost = (day.cost || 0) + estCost(model, { cache, input, output }, Math.floor(Date.now() / 1000))
    writeDaily(day)
  }
  function finalizeTurn(sessionId) {
    const agg = turnAggs.get(sessionId)
    if (agg && agg.cost > 0) {
      const day = ensureToday()
      day.turns = (day.turns || 0) + 1
      writeDaily(day)
      lastTurn = {
        turn: agg.turn, amount: agg.cost,
        tokens: agg.tokens, cacheTokens: agg.cacheTokens || 0, // tokens=非缓存（新输入+输出+推理）；缓存单列
        ms: agg.lastTs - agg.startedAt, ts: agg.lastTs,
      }
      lastTurnSeq++
    }
    turnAggs.delete(sessionId)
    busySessions.delete(sessionId)
  }

  // ---- 会话事件监听（session/event 全局通道） ----
  function handleEvent(sessionId, event) {
    try {
      const type = event && event.type
      const d = event && event.data
      if (!d || typeof d !== 'object') return
      const now = Date.now()
      if (type === 'turn/end') {
        finalizeTurn(sessionId)
        return
      }
      if (type === 'assistant/chunk') {
        const prev = busySessions.get(sessionId)
        if (!prev) {
          busySessions.set(sessionId, { since: now, last: now })
        } else {
          if (now - prev.last > BURST_GAP_MS) prev.since = now
          prev.last = now
        }
        return
      }
      if (type !== 'assistant/message') return
      const turn = Number(d.turn)
      const usage = d.usage
      if (!usage || typeof usage !== 'object') return
      const model = d.message && d.message.source ? d.message.source.model : ''
      let agg = turnAggs.get(sessionId)
      if (!agg || agg.turn !== turn) {
        if (agg) finalizeTurn(sessionId)
        agg = { turn, cost: 0, tokens: 0, cacheTokens: 0, startedAt: now, lastTs: now }
        turnAggs.set(sessionId, agg)
      }
      const input = Number(usage.inputTokens) || 0
      const cache = Number(usage.cacheReadTokens) || 0
      const output = Number(usage.outputTokens) || 0
      const reason = Number(usage.reasoningTokens) || 0
      // tokens 只累计非缓存部分（新输入+输出+推理），缓存命中单列统计，避免同一段上下文被反复计入而虚高
      agg.tokens += input + output // output 已含推理 token，不再叠加
      agg.cacheTokens += cache
      agg.cost += estCost(model, { cache, input, output }, Math.floor(now / 1000))
      agg.lastTs = now
      const prev = busySessions.get(sessionId)
      if (!prev) busySessions.set(sessionId, { since: agg.startedAt, last: now })
      else if (now - prev.last > BURST_GAP_MS) { prev.since = now; prev.last = now }
      else prev.last = now
      addUsage(model, usage)
    } catch (err) {}
  }
  disposers.push(ctx.on('session/event', (session, event) => {
    const sid = session && session.id ? session.id : 'default'
    handleEvent(sid, event)
  }))
  disposers.push(ctx.on('session/disposed', (session) => {
    if (session && session.id) {
      turnAggs.delete(session.id)
      busySessions.delete(session.id)
    }
  }))
  const activityTimer = setInterval(() => {
    const now = Date.now()
    for (const [sid, b] of busySessions) {
      if (now - b.last > BUSY_IDLE_MS) busySessions.delete(sid)
    }
  }, 3000)
  disposers.push(() => clearInterval(activityTimer))

  // ---- 余额（可选：无 DEEPSEEK_API_KEY 时静默 NO_KEY） ----
  function pickBalanceInfo(infos) {
    if (!Array.isArray(infos) || infos.length === 0) return null
    const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
    return (
      infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
      infos.find((x) => num(x) > 0) ||
      infos.find((x) => x && x.currency === 'CNY') ||
      infos[0]
    )
  }
  // ---- 记账账本（小鲸鱼记账：余额差值累计，跨天归档） ----
  function readLedger() {
    for (const p of USAGE_CANDIDATES) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') return parsed
      } catch (err) {}
    }
    return { date: todayKey(), lastBalance: null, lastCurrency: '', todayUsage: 0, history: {} }
  }
  function writeLedger(led) {
    const body = JSON.stringify(led)
    for (const p of USAGE_CANDIDATES) {
      try { fs.writeFileSync(p, body, 'utf8'); return true } catch (err) {}
    }
    return false
  }
  // 币种感知：观测币种与上次不同时只重置基准（数值跳变来自币种切换，而非真实消费）
  function recordLedgerUsage(balance, currency) {
    const t = todayKey()
    const led = readLedger()
    const cur = String(currency || '')
    const num = Number(balance)
    if (!isFinite(num)) return led
    const currencyChanged = typeof led.lastCurrency === 'string' && led.lastCurrency !== '' && cur !== '' && led.lastCurrency !== cur
    if (led.date !== t) {
      if (led.date && typeof led.todayUsage === 'number') {
        led.history = led.history || {}
        led.history[led.date] = led.todayUsage
      }
      led.date = t
      led.lastBalance = num
      led.lastCurrency = cur
      led.todayUsage = 0
    } else if (currencyChanged) {
      led.lastBalance = num
      led.lastCurrency = cur
    } else {
      const prev = typeof led.lastBalance === 'number' ? led.lastBalance : num
      if (num < prev) led.todayUsage = (Number(led.todayUsage) || 0) + (prev - num)
      led.lastBalance = num
      led.lastCurrency = cur
    }
    const keys = Object.keys(led.history || {}).sort()
    while (keys.length > 30) delete led.history[keys.shift()]
    writeLedger(led)
    return led
  }

  // ---- 平台用量（实时·令牌模式） ----
  // 凭证容错：既接受裸 token，也接受整段粘贴的 localStorage.userToken
  // （其形态为 {"value":"<64 位 token>","__version":"0"}）
  function normalizePlatformToken(raw) {
    const text = String(raw == null ? '' : raw).trim().replace(/^Bearer\s+/i, '')
    if (text.charAt(0) === '{') {
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed.value === 'string') return parsed.value.trim()
      } catch (err) {}
    }
    return text
  }
  function platformUsageQuery() {
    const now = new Date()
    const tz = -now.getTimezoneOffset() * 60
    const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
    return '?start=' + start + '&end=' + (start + 86400) + '&tz=' + tz
  }
  async function fetchPlatformUsage() {
    let cred
    try { cred = await ctx.credentials.resolve(PLATFORM_REF) } catch (err) { return { error: 'credential resolve failed' } }
    if (!cred) return { error: 'no platform token' }
    const token = normalizePlatformToken(cred.value)
    if (!token) return { error: 'empty platform token' }
    const headers = { Authorization: 'Bearer ' + token }
    const query = platformUsageQuery()
    const unwrap = (data) => {
      if (data && data.data && data.data.biz_data) return data.data.biz_data
      if (data && data.data && typeof data.data === 'object') return data.data
      return data
    }
    // 1) 权威口径：平台已结算金额（含实际峰谷价，无需本地价表）
    try {
      const res = await fetch(PLATFORM_COST_URL + query, { headers, signal: AbortSignal.timeout(15000) })
      if (res.ok) {
        const body = unwrap(await res.json())
        const groups = body && Array.isArray(body.data) ? body.data : []
        let amount = 0
        let currency = ''
        let found = false
        for (const group of groups) {
          if (!group || !Array.isArray(group.series)) continue
          for (const s of group.series) {
            const buckets = s && Array.isArray(s.buckets) ? s.buckets : []
            for (const b of buckets) {
              const cost = Number(b && b.cost)
              if (!isFinite(cost) || cost === 0) continue
              found = true
              amount += cost
              if (!currency && typeof group.currency === 'string') currency = group.currency
            }
          }
        }
        if (found) return { amount, currency, source: 'cost' }
      }
    } catch (err) {}
    // 2) 回退：token 分桶 × 官方峰谷价表估算（顺带给出平台 token 总数）
    try {
      const res = await fetch(PLATFORM_USAGE_URL + query, { headers, signal: AbortSignal.timeout(15000) })
      if (!res.ok) return { error: 'HTTP ' + res.status }
      const body = unwrap(await res.json())
      const series = body && Array.isArray(body.series) ? body.series : null
      if (!series || series.length === 0) return { error: 'no usage' }
      let amount = 0
      let tokens = 0
      let found = false
      for (const s of series) {
        if (!s || typeof s !== 'object') continue
        const buckets = Array.isArray(s.buckets) ? s.buckets : []
        for (const b of buckets) {
          const u = b && b.usage
          if (!u || typeof u !== 'object') continue
          const hit = Number(u.PROMPT_CACHE_HIT_TOKEN) || 0
          const miss = Number(u.PROMPT_CACHE_MISS_TOKEN) || 0
          const out = Number(u.RESPONSE_TOKEN) || 0
          if (hit + miss + out === 0) continue
          found = true
          tokens += hit + miss + out
          amount += estCost(s.model, { cache: hit, input: miss, output: out }, Number(b.time) || Math.floor(Date.now() / 1000))
        }
      }
      return found ? { amount, tokens, source: 'estimate' } : { error: 'no usage' }
    } catch (err) {
      return { error: String((err && err.message) || err) }
    }
  }

  // 余额 + 今日已用（按所选模式）：记账=余额差；令牌=平台用量（失败自动回落记账）
  async function buildBalancePayload() {
    const base = await fetchBalance()
    if (!base.ok) return base
    let led = { todayUsage: 0 }
    try { led = recordLedgerUsage(Number(base.totalBalance), base.currency) } catch (err) {}
    const cfg = readConfig()
    const mode = cfg.usageMode === 'token' ? 'token' : 'ledger'
    const payload = { ...base, isPeak: isPeakTime(Math.floor(Date.now() / 1000)), usageMode: mode }
    if (mode === 'token') {
      const u = await fetchPlatformUsage()
      if (u && isFinite(Number(u.amount))) {
        payload.todayUsage = Number(u.amount)
        payload.todayUsageTokens = Number(u.tokens) || 0
        payload.usageSource = u.source === 'cost' ? 'cost' : 'estimate'
        return payload
      }
      payload.usageNote = (u && u.error) ? String(u.error).slice(0, 120) : 'no usage'
      payload.usageMode = 'ledger'
      payload.todayUsage = Number(led.todayUsage) || 0
      return payload
    }
    payload.todayUsage = Number(led.todayUsage) || 0
    return payload
  }

  async function fetchBalance() {
    let cred
    try { cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY') } catch (err) {
      return { ok: false, code: 'NO_KEY', error: 'credentials resolve failed' }
    }
    if (!cred) return { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' }
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      let res
      try {
        res = await fetch(BALANCE_URL, {
          headers: { Authorization: 'Bearer ' + cred.value },
          signal: AbortSignal.timeout(20000),
        })
      } catch (err) {
        lastErr = err
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      if (!res.ok) {
        lastErr = new Error('HTTP ' + res.status)
        if (res.status < 500) break
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500))
        continue
      }
      let data
      try { data = await res.json() } catch (err) {
        return { ok: false, code: 'PARSE', error: '余额接口返回非法 JSON' }
      }
      const info = pickBalanceInfo(data && data.balance_infos)
      if (!info || info.total_balance === undefined) {
        return { ok: false, code: 'SHAPE', error: '余额接口结构异常' }
      }
      return {
        ok: true,
        totalBalance: Number(info.total_balance),
        currency: String(info.currency || 'CNY'),
        updatedAt: new Date().toISOString(),
      }
    }
    const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
    return {
      ok: false,
      code: 'HTTP',
      transient,
      error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
    }
  }
  function getBalance() {
    const now = Date.now()
    if (balanceCache && now - balanceCache.at < BALANCE_TTL_MS) return Promise.resolve(balanceCache.payload)
    if (balanceInFlight) return balanceInFlight
    balanceInFlight = buildBalancePayload()
      .then((payload) => {
        if (payload.ok) {
          balanceCache = { at: now, payload }
          return payload
        }
        if (payload.transient && balanceCache) {
          return { ...balanceCache.payload, stale: true, error: payload.error }
        }
        // NO_KEY 属正常“未配置”状态，不刷日志；其余确定性错误记一条
        if (!payload.transient && payload.code !== 'NO_KEY') console.error('[dsh-buddy]', payload.code, payload.error)
        return payload
      })
      .catch((err) => ({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) }))
      .finally(() => { balanceInFlight = null })
    return balanceInFlight
  }

  // ---- 当前活动视图 ----
  function activityView() {
    const now = Date.now()
    let best = null
    for (const [sid, b] of busySessions) {
      if (now - b.last > BUSY_IDLE_MS) { busySessions.delete(sid); continue }
      if (!best || b.last > best.last) best = { sid, ...b }
    }
    if (!best) return { status: 'idle', since: null }
    return { status: 'busy', since: best.since, session: best.sid }
  }

  // ---- 配置读写（scale/showBalance + 自定义图标元数据 petMime/petTs） ----
  function readConfig() {
    for (const p of CONFIG_CANDIDATES) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (parsed && typeof parsed.scale === 'number') {
          return {
            scale: parsed.scale,
            showBalance: parsed.showBalance !== false,
            usageMode: parsed.usageMode === 'token' ? 'token' : 'ledger',
            fontScale: typeof parsed.fontScale === 'number' && parsed.fontScale >= 0.49 && parsed.fontScale <= 2.01 ? parsed.fontScale : 1,
            bubbleScale: typeof parsed.bubbleScale === 'number' && parsed.bubbleScale >= 0.49 && parsed.bubbleScale <= 2.01 ? parsed.bubbleScale : 1,
            petMime: typeof parsed.petMime === 'string' ? parsed.petMime : null,
            petTs: typeof parsed.petTs === 'number' ? parsed.petTs : null,
            petBusyMime: typeof parsed.petBusyMime === 'string' ? parsed.petBusyMime : null,
            petBusyTs: typeof parsed.petBusyTs === 'number' ? parsed.petBusyTs : null,
            petDoneMime: typeof parsed.petDoneMime === 'string' ? parsed.petDoneMime : null,
            petDoneTs: typeof parsed.petDoneTs === 'number' ? parsed.petDoneTs : null,
          }
        }
      } catch (err) {}
    }
    return { scale: 1.5, showBalance: true, usageMode: 'ledger', fontScale: 1, bubbleScale: 1, petMime: null, petTs: null, petBusyMime: null, petBusyTs: null, petDoneMime: null, petDoneTs: null }
  }
  // 合并式写入：单次更新部分字段时保留其余字段（scale/showBalance/usageMode/fontScale/bubbleScale/pet 元数据）
  function writeConfig(partial) {
    const old = readConfig()
    const next = {
      scale: partial.scale !== undefined && typeof partial.scale === 'number' ? partial.scale : old.scale,
      showBalance: partial.showBalance !== undefined ? partial.showBalance !== false : old.showBalance,
      usageMode: partial.usageMode !== undefined ? (partial.usageMode === 'token' ? 'token' : 'ledger') : old.usageMode,
      fontScale: partial.fontScale !== undefined ? partial.fontScale : old.fontScale,
      bubbleScale: partial.bubbleScale !== undefined ? partial.bubbleScale : old.bubbleScale,
      petMime: partial.petMime !== undefined ? partial.petMime : old.petMime,
      petTs: partial.petTs !== undefined ? partial.petTs : old.petTs,
      petBusyMime: partial.petBusyMime !== undefined ? partial.petBusyMime : old.petBusyMime,
      petBusyTs: partial.petBusyTs !== undefined ? partial.petBusyTs : old.petBusyTs,
      petDoneMime: partial.petDoneMime !== undefined ? partial.petDoneMime : old.petDoneMime,
      petDoneTs: partial.petDoneTs !== undefined ? partial.petDoneTs : old.petDoneTs,
      updatedAt: new Date().toISOString(),
    }
    const body = JSON.stringify(next)
    for (const p of CONFIG_CANDIDATES) {
      try { fs.writeFileSync(p, body, 'utf8'); return true } catch (err) {}
    }
    return false
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > 8192) { reject(new Error('body too large')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }
  // 原始二进制请求体读取（自定义图标上传，上限 4MB）
  function readRawBody(req, cap) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (c) => {
        size += c.length
        if (size > cap) { reject(new Error('body too large')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }
  function sendJson(res, obj) {
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(obj))
  }

  // ---- 路由注册 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-buddy/widget.js',
    handler: (req, res) => {
      const src = loadWidgetSource()
      if (src === null) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('[dsh-buddy] lib/widget.js missing from the package')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(src)
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-buddy/state.json',
    handler: (req, res) => {
      try {
        const day = ensureToday()
        const payload = {
          ok: true,
          now: Date.now(),
          activity: activityView(),
          last: lastTurn
            ? { seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, cacheTokens: lastTurn.cacheTokens || 0, ms: lastTurn.ms, ts: lastTurn.ts }
            : { seq: 0, turn: null, amount: null, tokens: null, ms: null, ts: null },
          today: {
            turns: day.turns || 0,
            msgs: day.msgs || 0,
            tokens: day.tokens || { input: 0, cache: 0, output: 0, reason: 0 },
            cost: day.cost || 0,
          },
          week: weekSummary(),
        }
        sendJson(res, payload)
      } catch (err) {
        sendJson(res, { ok: false, error: String((err && err.message) || err).slice(0, 200) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-buddy/balance.json',
    handler: async (req, res) => {
      try {
        sendJson(res, await getBalance())
      } catch (err) {
        sendJson(res, { ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) })
      }
    },
  }))

  // ---- 自定义宠物图标：GET / PUT / DELETE；?slot=idle|busy|done（缺省 idle） ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-buddy/pet',
    handler: async (req, res) => {
      try {
        const slot = petSlotFromUrl(req.url)
        const method = req.method
        const meta = PET_SLOT_META[slot] || PET_SLOT_META.idle
        const mimeKey = meta.mimeKey
        const tsKey = meta.tsKey
        if (method === 'PUT' || method === 'POST') {
          const buf = await readRawBody(req, PET_MAX_BYTES)
          if (!buf || buf.length === 0) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'empty body' }))
            return
          }
          const mime = sniffPetMime(buf)
          if (!mime) {
            res.writeHead(415, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'unsupported image type (need png/jpg/gif/webp/avif)' }))
            return
          }
          const list = PET_SLOT_CANDIDATES[slot] || PET_SLOT_CANDIDATES.idle
          let saved = false
          for (const p of list) {
            try {
              fs.writeFileSync(p, buf)
              saved = true
              break
            } catch (err) {}
          }
          if (!saved) {
            sendJson(res, { ok: false, error: '无法写入图标文件' })
            return
          }
          const ts = Date.now()
          const partial = {}
          partial[mimeKey] = mime
          partial[tsKey] = ts
          writeConfig(partial)
          sendJson(res, { ok: true, mime, size: buf.length, ts, slot })
          return
        }
        if (method === 'DELETE') {
          petDelete(slot)
          const partial = {}
          partial[mimeKey] = null
          partial[tsKey] = null
          writeConfig(partial)
          sendJson(res, { ok: true, slot })
          return
        }
        // GET：自定义字节优先，其次打包默认图标；两者皆无才 404
        let bytes = petRead(slot)
        const isDefault = !bytes
        if (!bytes) bytes = petDefaultRead(slot)
        if (!bytes) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end('no pet image')
          return
        }
        const cfg = readConfig()
        res.writeHead(200, {
          'Content-Type': (isDefault ? null : cfg[mimeKey]) || sniffPetMime(bytes) || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'Content-Length': String(bytes.length),
        })
        res.end(bytes)
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-buddy/config.json',
    handler: async (req, res) => {
      try {
        if (req.method === 'PUT' || req.method === 'POST') {
          const body = await readBody(req)
          const parsed = JSON.parse(body)
          const scale = typeof parsed.scale === 'number' ? parsed.scale : null
          if (scale === null) {
            res.writeHead(400, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'missing scale' }))
            return
          }
          const showBalance = parsed.showBalance !== false
          const clampAdj = (v) => (typeof v === 'number' && isFinite(v) ? Math.min(2, Math.max(0.5, v)) : undefined)
          const fontScale = clampAdj(parsed.fontScale)
          const bubbleScale = clampAdj(parsed.bubbleScale)
          // usageMode：字段缺失=保持原值；出现即归一化（非 'token' 一律按 'ledger'）
          const modePrev = readConfig().usageMode
          const modeNext = parsed.usageMode === undefined ? null : (parsed.usageMode === 'token' ? 'token' : 'ledger')
          const partial = { scale, showBalance }
          if (fontScale !== undefined) partial.fontScale = fontScale
          if (bubbleScale !== undefined) partial.bubbleScale = bubbleScale
          if (modeNext !== null) partial.usageMode = modeNext
          writeConfig(partial)
          // 仅当用量模式真的变了才让余额缓存失效，避免其他保存动作打穿缓存
          if (modeNext !== null && modeNext !== modePrev) balanceCache = null
          const cfg = readConfig()
          sendJson(res, {
            ok: true, scale, showBalance, usageMode: cfg.usageMode,
            fontScale: cfg.fontScale, bubbleScale: cfg.bubbleScale,
            petMime: cfg.petMime, petTs: cfg.petTs, hasPet: !!cfg.petMime,
            petBusyMime: cfg.petBusyMime, petBusyTs: cfg.petBusyTs, hasBusyPet: !!cfg.petBusyMime,
            petDoneMime: cfg.petDoneMime, petDoneTs: cfg.petDoneTs, hasDonePet: !!cfg.petDoneMime,
          })
          return
        }
        const cfg = readConfig()
        let hasKey = false
        try { hasKey = !!(await ctx.credentials.resolve('DEEPSEEK_API_KEY')) } catch (err) {}
        let hasPlatformToken = false
        try { hasPlatformToken = !!(await ctx.credentials.resolve(PLATFORM_REF)) } catch (err) {}
        // 完成庆祝图标播放时长：按 3 遍估算（默认优先于自定义的时长以实际图为准）
        let doneMs = 0
        try {
          const doneBytes = petRead('done') || petDefaultRead('done')
          if (doneBytes) {
            const cycle = gifCycleMs(doneBytes)
            doneMs = cycle > 0 ? Math.min(15000, Math.max(1200, cycle * 3)) : 2600
          }
        } catch (err) {}
        sendJson(res, {
          ...cfg,
          hasKey,
          hasPlatformToken,
          hasPet: !!(cfg.petMime && petRead('idle')),
          hasBusyPet: !!(cfg.petBusyMime && petRead('busy')),
          hasDonePet: !!(cfg.petDoneMime && petRead('done')),
          hasDefaultPet: !!petDefaultRead('idle'),
          hasDefaultBusyPet: !!petDefaultRead('busy'),
          hasDefaultDonePet: !!petDefaultRead('done'),
          petDoneMs: doneMs,
        })
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
      }
    },
  }))

  // 平台令牌写入：把粘贴的 token 存进 DSH 凭据（ctx.credentials.set），供菜单内「平台令牌」使用。
  // 只写不读：任何响应都不回显值；仅当请求带 Origin 且与 Host 不同源时拒绝。
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-buddy/platform-token',
    handler: async (req, res) => {
      try {
        if (req.method !== 'PUT' && req.method !== 'POST' && req.method !== 'DELETE') {
          res.writeHead(405, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const headers = (req && req.headers) || {}
        if (headers.origin && headers.host) {
          let originHost = ''
          try { originHost = new URL(String(headers.origin)).host } catch (err) { originHost = '' }
          if (originHost !== headers.host) {
            res.writeHead(403, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'cross-origin rejected' }))
            return
          }
        }
        if (req.method === 'DELETE') {
          await ctx.credentials.unset(PLATFORM_REF)
          balanceCache = null
          sendJson(res, { ok: true, hasPlatformToken: false })
          return
        }
        const parsed = JSON.parse(await readBody(req))
        const token = normalizePlatformToken(parsed && parsed.token)
        if (!token) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'empty token' }))
          return
        }
        if (token.length > 4096) {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: 'token too long' }))
          return
        }
        await ctx.credentials.set(PLATFORM_REF, token)
        balanceCache = null
        sendJson(res, { ok: true, hasPlatformToken: true })
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err).slice(0, 200) }))
      }
    },
  }))

  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf('/dsh-buddy/widget.js') !== -1) return html
    const tag = '<script defer src="/dsh-buddy/widget.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  // HMR / 卸载时统一清理
  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch (err) {}
    }
  })
}

export { name, inject, apply }
