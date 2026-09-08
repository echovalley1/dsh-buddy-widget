// dsh-buddy-widget 离线冒烟测试：不依赖真实 DSH 运行时
// 用法：DSH_HOME=<临时目录> node smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// 清空测试用 DSH_HOME，避免上次运行残留污染断言
if (process.env.DSH_HOME) {
  fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true })
  fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
}
const src = fs.readFileSync(path.join(here, 'lib', 'index.js'), 'utf8')

// 1) 校验内嵌前端 JS 语法（只 parse，不执行 DOM）
const m = src.match(/const WIDGET_JS = `([\s\S]*?)`\n\n\/\/ ={20,}/)
if (!m) { console.error('FAIL: WIDGET_JS block not found'); process.exit(1) }
try {
  new Function(m[1]) // 语法检查
  console.log('PASS: WIDGET_JS 语法正确, 长度', m[1].length)
} catch (err) {
  console.error('FAIL: WIDGET_JS 语法错误 ->', err.message)
  process.exit(1)
}

// 2) mock ctx 驱动宿主 apply
const mod = await import('file:///' + path.join(here, 'lib', 'index.js').replace(/\\/g, '/'))
const listeners = new Map()
const routes = []
const taps = []
let cleanups = []
const fakeCtx = {
  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, [])
    listeners.get(ev).push(fn)
    return () => {}
  },
  effect(fn) { const ret = fn(); cleanups = Array.isArray(ret) ? ret : [ret] },
  webServer: {
    register(r) { routes.push(r); return () => {} },
    tapIndex(t) { taps.push(t); return () => {} },
  },
  credentials: { async resolve() { return undefined } },
}

mod.apply(fakeCtx)

const route = (p) => routes.find((r) => r.path === p)
if (!route('/dsh-buddy/widget.js') || !route('/dsh-buddy/state.json') || !route('/dsh-buddy/balance.json') || !route('/dsh-buddy/config.json')) {
  console.error('FAIL: 缺少必需路由'); process.exit(1)
}
if (taps.length !== 1) { console.error('FAIL: tapIndex 应注册 1 个'); process.exit(1) }
// tapIndex 幂等 & 注入
const html0 = '<html><body>hi</body></html>'
const html1 = taps[0](html0)
if (html1.indexOf('/dsh-buddy/widget.js') === -1) { console.error('FAIL: tapIndex 未注入'); process.exit(1) }
const html2 = taps[0](html1)
if (html2 !== html1) { console.error('FAIL: tapIndex 幂等失败'); process.exit(1) }

// 模拟请求
function call(r, method = 'GET', bodyText) {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      writeHead(code) { this.status = code },
      end(s) { resolve({ status: this.status, body: JSON.parse(s) }) },
    }
    const req = {
      method,
      url: r.path,
      on(ev, fn) {
        if (ev === 'data') { if (bodyText) fn(Buffer.from(bodyText)) }
        if (ev === 'end') fn()
      },
      destroy() {},
    }
    r.handler(req, res).catch(() => {})
  })
}

const st0 = await call(route('/dsh-buddy/state.json'))
if (!st0.body.ok || st0.body.activity.status !== 'idle' || st0.body.today.turns !== 0) {
  console.error('FAIL: 初始 state 异常', JSON.stringify(st0.body)); process.exit(1)
}
console.log('PASS: 初始 state idle / turns=0')

const bal0 = await call(route('/dsh-buddy/balance.json'))
if (bal0.body.ok !== false || bal0.body.code !== 'NO_KEY') {
  console.error('FAIL: 无 key 时应返回 NO_KEY', JSON.stringify(bal0.body)); process.exit(1)
}
console.log('PASS: 无 DEEPSEEK_API_KEY → NO_KEY(静默)')

// 会话事件模拟：一条 assistant/message + turn/end
const ev = listeners.get('session/event')[0]
const sess = { id: 's1' }
ev(sess, { type: 'assistant/chunk', data: { turn: 1, step: 0, chunk: { text: 'hi' } } })
ev(sess, {
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 0,
    message: { source: { model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: 'hi' }] },
    usage: { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 300, reasoningTokens: 100 },
  },
})
const stMid = await call(route('/dsh-buddy/state.json'))
if (stMid.body.activity.status !== 'busy') { console.error('FAIL: 应处于 busy', JSON.stringify(stMid.body.activity)); process.exit(1) }
console.log('PASS: chunk/message 后 activity=busy')

ev(sess, { type: 'turn/end', data: { turn: 1, reason: { kind: 'ok' } } })
const st1 = await call(route('/dsh-buddy/state.json'))
if (!st1.body.ok || st1.body.activity.status !== 'idle') { console.error('FAIL: turn/end 后应 idle'); process.exit(1) }
if (st1.body.today.turns !== 1 || st1.body.today.msgs !== 1) { console.error('FAIL: turns 应=1', JSON.stringify(st1.body.today)); process.exit(1) }
if (st1.body.last.seq !== 1 || !(st1.body.last.amount > 0)) { console.error('FAIL: last seq=1 & amount>0', JSON.stringify(st1.body.last)); process.exit(1) }
const totalTokens = st1.body.today.tokens.input + st1.body.today.tokens.cache + st1.body.today.tokens.output + st1.body.today.tokens.reason
if (totalTokens !== 3400) { console.error('FAIL: tokens 应=3400, got', totalTokens); process.exit(1) }
console.log('PASS: 每轮结算 turns=1 tokens=3400 cost>0 → last{seq:1}')
// 期望 cost：cache 2000*0.05 + input 1000*1.5 + (300+100)*4.5，按 /1e6，空闲价或高峰价之一
const c = st1.body.today.cost
if (!(Math.abs(c - (2000 * 0.05 + 1000 * 1.5 + 400 * 4.5) / 1e6) < 1e-9 || Math.abs(c - (2000 * 0.1 + 1000 * 3.0 + 400 * 9) / 1e6) < 1e-9)) {
  console.error('FAIL: cost 定价异常', c); process.exit(1)
}
console.log('PASS: cost 按峰谷定价表换算合理 =', c.toFixed(6))

// 原始字节请求/响应（宠物图标）
function rawCall(r, method = 'GET', bodyBuf, url) {
  return new Promise((resolve) => {
    let ctype = ''
    const res = {
      status: 0,
      writeHead(code, headers) { this.status = code; ctype = (headers && headers['Content-Type']) || '' },
      end(s) { resolve({ status: this.status, ctype, body: s }) },
    }
    const req = {
      method,
      url: url || r.path,
      on(ev, fn) {
        if (ev === 'data') { if (bodyBuf) fn(bodyBuf) }
        if (ev === 'end') fn()
      },
      destroy() {},
    }
    r.handler(req, res).catch(() => {})
  })
}

// config GET/PUT
const cfg0 = await call(route('/dsh-buddy/config.json'))
if (cfg0.body.scale !== 1.5 || cfg0.body.hasKey !== false || cfg0.body.hasPet !== false) { console.error('FAIL: config 初值异常', JSON.stringify(cfg0.body)); process.exit(1) }
const cfgPut = await call(route('/dsh-buddy/config.json'), 'PUT', JSON.stringify({ scale: 2.1, showBalance: false, fontScale: 1.3, bubbleScale: 0.8 }))
if (cfgPut.body.ok !== true || cfgPut.body.scale !== 2.1) { console.error('FAIL: config PUT 失败', JSON.stringify(cfgPut.body)); process.exit(1) }
const cfg1 = await call(route('/dsh-buddy/config.json'))
if (cfg1.body.scale !== 2.1 || cfg1.body.showBalance !== false) { console.error('FAIL: config 持久化失败', JSON.stringify(cfg1.body)); process.exit(1) }
if (cfg1.body.fontScale !== 1.3 || cfg1.body.bubbleScale !== 0.8) { console.error('FAIL: 字号/气泡倍率持久化失败', JSON.stringify(cfg1.body)); process.exit(1) }
console.log('PASS: config GET/PUT 回路 OK (scale 2.1, showBalance false, font 1.3, bubble 0.8)')

// 自定义宠物图标：无 → PUT(gif) → GET → DELETE → 无
const petNone = await rawCall(route('/dsh-buddy/pet'))
if (petNone.status !== 404) { console.error('FAIL: 无图标时应 404, got', petNone.status); process.exit(1) }
const gifHeader = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16, 0)])
const petPut = await call2(route('/dsh-buddy/pet'), 'PUT', gifHeader)
if (!petPut.ok || petPut.mime !== 'image/gif' || !(petPut.ts > 0)) { console.error('FAIL: pet PUT 失败', JSON.stringify(petPut)); process.exit(1) }
const petGet = await rawCall(route('/dsh-buddy/pet'))
if (petGet.status !== 200 || petGet.ctype !== 'image/gif' || petGet.body.length !== gifHeader.length) { console.error('FAIL: pet GET 异常', petGet.status, petGet.ctype); process.exit(1) }
const cfg2 = await call(route('/dsh-buddy/config.json'))
if (cfg2.body.hasPet !== true || cfg2.body.petMime !== 'image/gif') { console.error('FAIL: config 应反映 hasPet', JSON.stringify(cfg2.body)); process.exit(1) }
const petDel = await call(route('/dsh-buddy/pet'), 'DELETE')
if (!petDel.body.ok) { console.error('FAIL: pet DELETE 失败'); process.exit(1) }
const petNone2 = await rawCall(route('/dsh-buddy/pet'))
if (petNone2.status !== 404) { console.error('FAIL: DELETE 后应 404'); process.exit(1) }
console.log('PASS: 图标 PUT(gif)/GET/DELETE 回路 + config.hasPet 同步')

// 回复图标（busy slot）：PUT ?slot=busy → GET 区分 → DELETE
const busyUrl = '/dsh-buddy/pet?slot=busy'
const busyNone = await rawCall(route('/dsh-buddy/pet'), 'GET', null, busyUrl)
if (busyNone.status !== 404) { console.error('FAIL: 无回复图标时应 404'); process.exit(1) }
const busyPut = await call2(route('/dsh-buddy/pet'), 'PUT', gifHeader, busyUrl)
if (!busyPut.ok || busyPut.slot !== 'busy' || busyPut.mime !== 'image/gif') { console.error('FAIL: busy PUT 失败', JSON.stringify(busyPut)); process.exit(1) }
const busyGet = await rawCall(route('/dsh-buddy/pet'), 'GET', null, busyUrl)
if (busyGet.status !== 200 || busyGet.ctype !== 'image/gif') { console.error('FAIL: busy GET 异常'); process.exit(1) }
const idleStill404 = await rawCall(route('/dsh-buddy/pet'))
if (idleStill404.status !== 404) { console.error('FAIL: busy 不应影响 idle slot'); process.exit(1) }
const cfg3 = await call(route('/dsh-buddy/config.json'))
if (cfg3.body.hasBusyPet !== true || cfg3.body.petBusyMime !== 'image/gif') { console.error('FAIL: config 应反映 hasBusyPet', JSON.stringify(cfg3.body)); process.exit(1) }
const busyDelRaw = await rawCall(route('/dsh-buddy/pet'), 'DELETE', null, busyUrl)
const busyDel = JSON.parse(busyDelRaw.body)
if (!busyDel.ok || busyDel.slot !== 'busy') { console.error('FAIL: busy DELETE 失败', JSON.stringify(busyDel)); process.exit(1) }
console.log('PASS: 回复图标 busy slot PUT/GET/DELETE 回路 + config.hasBusyPet 同步')

// call2：raw body + json 响应
async function call2(r, method, buf, url) {
  const out = await rawCall(r, method, buf, url)
  return JSON.parse(out.body)
}

// 落盘文件核对
const dailyFile = path.join(process.env.DSH_HOME, '.dshb-daily.json')
const cfgFile = path.join(process.env.DSH_HOME, '.dshb-config.json')
if (!fs.existsSync(dailyFile) || !fs.existsSync(cfgFile)) { console.error('FAIL: 状态文件未落盘到 $DSH_HOME'); process.exit(1) }
const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'))
if (daily.turns !== 1) { console.error('FAIL: daily 文件 turns!=1'); process.exit(1) }
console.log('PASS: 状态文件落盘', path.basename(dailyFile), 'turns=', daily.turns)

// 卸载清理
cleanups.forEach((fn) => { try { fn() } catch (e) {} })
console.log('ALL PASS')
