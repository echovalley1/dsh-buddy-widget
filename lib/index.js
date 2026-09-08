// ============================================================================
// dsh-buddy-widget —— DSH 陪伴助手挂件（宿主侧 + 内嵌页面端）
//
// 仿照 dsh-whale-widget 的「标准 DSH bundle 插件」架构：
//   * package.json 声明 dsh.bundle.patch → ./cordis.patch.yml
//   * 本文件具名导出 { name, inject:['webServer','credentials'], apply }
//   * 宿主（Node 进程）注册 webServer 路由 + 监听 session/event；
//     前端整份代码作为 WIDGET_JS 模板字符串经 /dsh-buddy/widget.js 吐出，
//     再用 webServer.tapIndex() 幂等注入到每次 index.html。
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

// ---- 自定义宠物图标（两套：idle 普通图标 / busy 回复图标；原始字节无扩展名） ----
const PET_CANDIDATES = [
  path.join(DSH_HOME, '.dshb-pet'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshb-pet'),
]
const PET_BUSY_CANDIDATES = [
  path.join(DSH_HOME, '.dshb-pet-busy'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshb-pet-busy'),
]
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
// busy=true → 回复图标；否则普通图标
function petSlotBusy(url) {
  try {
    const q = String(url || '').split('?')[1] || ''
    const m = /(?:^|&)slot=([^&]+)/.exec(q)
    return m ? decodeURIComponent(m[1]) === 'busy' : false
  } catch (err) { return false }
}
function petRead(busy) {
  const list = busy ? PET_BUSY_CANDIDATES : PET_CANDIDATES
  for (const p of list) {
    try {
      const b = fs.readFileSync(p)
      if (b && b.length > 0) return b
    } catch (err) {}
  }
  return null
}
function petDelete(busy) {
  const list = busy ? PET_BUSY_CANDIDATES : PET_CANDIDATES
  for (const p of list) {
    try { fs.unlinkSync(p) } catch (err) {}
  }
}

// ---- 打包默认图标（assets/，英文文件名；无自定义上传时作为兜底“默认”展示） ----
const DEFAULT_PET_FILES = {
  idle: ['pet-default.gif', 'pet-default.png', 'pet-default.jpg', 'pet-default.webp'],
  busy: ['pet-busy-default.gif', 'pet-busy-default.png', 'pet-busy-default.jpg', 'pet-busy-default.webp'],
}
function petDefaultRead(busy) {
  const names = busy ? DEFAULT_PET_FILES.busy : DEFAULT_PET_FILES.idle
  for (const name of names) {
    try {
      const p = path.join(PACKAGE_ROOT, 'assets', name)
      const b = fs.readFileSync(p)
      if (b && b.length > 0) return b
    } catch (err) {}
  }
  return null
}

// 前端挂件源码：每次请求从 lib/widget.js 读盘（no-store）→ 改 UI 只需 F5，
// 无需重启宿主（热更）；读不到（如发布包被精简）时回退内嵌快照 WIDGET_JS。
function loadWidgetSource() {
  try {
    const p = path.join(PACKAGE_ROOT, 'lib', 'widget.js')
    const s = fs.readFileSync(p, 'utf8')
    if (s && s.length > 0) return s
  } catch (err) {}
  return WIDGET_JS
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

// ============================================================================
// 内嵌页面端挂件源码（原生 JS，IIFE；宿主原样吐出，零外部依赖）
// 注意：本段内不使用反引号/模板串，中文一律用 \uXXXX 转义，避免与外层
// 模板字符串冲突且保证任意编码下输出一致。
// ============================================================================
const WIDGET_JS = `(function () {
if (window.__dshBuddyWidget) return
window.__dshBuddyWidget = true

var MIN_SCALE = 0.6
var MAX_SCALE = 2.5
var CLICK_SQ = 9
var STATE_MS = 1000
var BALANCE_MS = 60000
var POPUP_MS = 6000
var BUBBLE_MS = 12000
var STATE_URL = '/dsh-buddy/state.json'
var BALANCE_URL = '/dsh-buddy/balance.json'
var CONFIG_URL = '/dsh-buddy/config.json'
var PET_URL = '/dsh-buddy/pet'

// ---------- 样式（长度单位 = calc(var(--dshb-u) * N)，N 即 base 的 1%） ----------
var css = [
  '.dshb-root{position:fixed;right:0;bottom:0;--dshb-scale:1;--dshb-base:clamp(120px,calc(min(232px,min(100vw,100vh) * 0.26) * var(--dshb-scale)),560px);--dshb-u:calc(var(--dshb-base) / 100);width:var(--dshb-base);height:var(--dshb-base);pointer-events:none;user-select:none;-webkit-user-select:none;z-index:9999;font-family:inherit;transition:left .16s ease,top .16s ease,transform .3s ease}',
  '.dshb-root.dshb-left{transform:scaleX(-1)}',
  '.dshb-root.dshb-left .dshb-text,.dshb-root.dshb-left .dshb-pill{transform:scaleX(-1)}',
  '.dshb-root.dshb-dragging{cursor:grabbing;transition:none}',
  '.dshb-ctrl{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}',
  '.dshb-pet{position:absolute;right:0;bottom:0;width:66%;height:66%;display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:grab;transition:transform .22s cubic-bezier(.34,1.56,.64,1)}',
  '.dshb-pet:active{cursor:grabbing}',
  '.dshb-emoji{font-size:calc(var(--dshb-u) * 38);line-height:1;transform:translateY(calc(var(--dshb-u) * -1));transition:transform .3s ease}',
  '.dshb-pet.dshb-squish{transform:scaleY(.9) scaleX(1.04)}',
  '.dshb-pet.dshb-idle{animation:none}',
  '.dshb-pet.dshb-busy{filter:brightness(1.06)}',
  '.dshb-pet-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:none;pointer-events:none;-webkit-user-drag:none;user-select:none}',
  '.dshb-pet.dshb-custom .dshb-emoji{display:none}',
  '.dshb-pet.dshb-custom .dshb-pet-img{display:block}',
  '.dshb-pill{position:absolute;left:calc(var(--dshb-u) * 4);bottom:calc(var(--dshb-u) * 8);background:rgba(32,49,112,.92);color:#fff;border-radius:calc(var(--dshb-u) * 6);padding:calc(var(--dshb-u) * 2) calc(var(--dshb-u) * 8);font-size:calc(var(--dshb-u) * 5 * var(--dshb-font,1));line-height:1;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .18s ease}',
  '.dshb-pill.dshb-on{opacity:1}',
  '.dshb-bubble{position:absolute;left:0;right:0;bottom:calc(var(--dshb-u) * 52);display:flex;justify-content:center;pointer-events:none;opacity:0;transform:scale(.88) translateY(calc(var(--dshb-u) * 5));transform-origin:50% 100%;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);z-index:2}',
  '.dshb-bubble.dshb-open{opacity:1;transform:none;pointer-events:auto;cursor:pointer}',
  '.dshb-box{position:relative;max-width:96%;background:#fff;border:calc(var(--dshb-u) * 2 * var(--dshb-bub,1)) solid #203170;border-radius:calc(var(--dshb-u) * 12 * var(--dshb-bub,1));box-shadow:0 calc(var(--dshb-u) * 4 * var(--dshb-bub,1)) calc(var(--dshb-u) * 12 * var(--dshb-bub,1)) rgba(32,49,112,.28);padding:calc(var(--dshb-u) * 5 * var(--dshb-bub,1)) calc(var(--dshb-u) * 12 * var(--dshb-bub,1));box-sizing:border-box;color-scheme:light}',
  '.dshb-box::after{content:"";position:absolute;right:calc(var(--dshb-u) * 24 * var(--dshb-bub,1));bottom:calc(var(--dshb-u) * -4 * var(--dshb-bub,1));width:calc(var(--dshb-u) * 7 * var(--dshb-bub,1));height:calc(var(--dshb-u) * 7 * var(--dshb-bub,1));background:#fff;border-right:calc(var(--dshb-u) * 2 * var(--dshb-bub,1)) solid #203170;border-bottom:calc(var(--dshb-u) * 2 * var(--dshb-bub,1)) solid #203170;transform:rotate(45deg);border-bottom-right-radius:calc(var(--dshb-u) * 2 * var(--dshb-bub,1))}',
  '.dshb-text{text-align:center;color:#203170}',
  '.dshb-row-a{font-size:calc(var(--dshb-u) * 6 * var(--dshb-font,1));font-weight:600;letter-spacing:.05em;color:#536ba9}',
  '.dshb-row-b{font-size:calc(var(--dshb-u) * 13 * var(--dshb-font,1));font-weight:800;line-height:1.06;color:#203170;margin-top:calc(var(--dshb-u) * 2 * var(--dshb-font,1))}',
  '.dshb-row-b.dshb-red{color:#e0433f}',
  '.dshb-row-c{font-size:calc(var(--dshb-u) * 5 * var(--dshb-font,1));color:#536ba9;margin-top:calc(var(--dshb-u) * 3 * var(--dshb-font,1));line-height:1.3;white-space:normal}',
  '.dshb-menu-btn{position:absolute;left:0;top:0;width:calc(var(--dshb-u) * 10);height:calc(var(--dshb-u) * 10);border:none;border-radius:calc(var(--dshb-u) * 2.5);background:rgba(32,49,112,.85);cursor:pointer;pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:calc(var(--dshb-u) * 1.4);padding:0;z-index:3;opacity:.95;transition:opacity .15s ease,transform .15s ease}',
  '.dshb-menu-btn:hover{opacity:1;transform:scale(1.1)}',
  '.dshb-menu-btn span{display:block;width:calc(var(--dshb-u) * 5);height:calc(var(--dshb-u) * 1.1);background:#fff;border-radius:1px}',
  '.dshb-menu{position:fixed;min-width:210px;background:rgba(255,255,255,.96);border:1px solid rgba(32,49,112,.35);border-radius:12px;padding:12px 14px;opacity:0;transform:scale(.92) translateY(-4px);transform-origin:top right;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:10000;box-shadow:0 8px 22px rgba(0,0,0,.2);color-scheme:light}',
  '.dshb-menu.dshb-open{opacity:1;transform:scale(1) translateY(0);pointer-events:auto}',
  '.dshb-menu-row{display:flex;align-items:center;gap:10px;margin:6px 0;color:#203170;font-size:13px;white-space:nowrap}',
  '.dshb-menu .dshb-range{flex:1;min-width:0;accent-color:#203170}',
  '.dshb-menu .dshb-number{width:46px;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:2px 4px;font-size:12px;color:#203170;background:#fff;box-sizing:border-box}',
  '.dshb-menu .dshb-check{width:16px;height:16px;accent-color:#203170;cursor:pointer;flex:0 0 auto}',
  '.dshb-menu .dshb-btn{border:1px solid rgba(32,49,112,.4);border-radius:8px;background:rgba(32,49,112,.08);color:#203170;font-size:12px;padding:4px 10px;cursor:pointer;margin-left:auto}',
  '.dshb-menu .dshb-btn:hover{background:rgba(32,49,112,.18)}',
  '.dshb-menu-note{font-size:11px;color:#9fb0d9;margin-top:4px;line-height:1.5;max-width:230px;white-space:normal}',
  '.dshb-menu-sep{height:1px;background:rgba(32,49,112,.2);margin:8px 0}'
].join('\\n')

var styleEl = document.createElement('style')
styleEl.textContent = css
document.head.appendChild(styleEl)

var root = document.createElement('div')
root.className = 'dshb-root'

var ctrl = document.createElement('div')
ctrl.className = 'dshb-ctrl'
var pet = document.createElement('div')
pet.className = 'dshb-pet dshb-idle'
pet.title = 'DSH \\u966a\\u4f34\\u52a9\\u624b'
var petImg = document.createElement('img')
petImg.className = 'dshb-pet-img'
petImg.alt = ''
petImg.draggable = false
var emoji = document.createElement('span')
emoji.className = 'dshb-emoji'
emoji.textContent = '\\ud83d\\udc19' // \\u76ca\\u5927\\u7ae0\\u9c7c
pet.appendChild(petImg)
pet.appendChild(emoji)
ctrl.appendChild(pet)

var pill = document.createElement('div')
pill.className = 'dshb-pill'
ctrl.appendChild(pill)

var bubble = document.createElement('div')
bubble.className = 'dshb-bubble'
var box = document.createElement('div')
box.className = 'dshb-box'
var txt = document.createElement('div')
txt.className = 'dshb-text'
var rowA = document.createElement('div')
rowA.className = 'dshb-row-a'
var rowB = document.createElement('div')
rowB.className = 'dshb-row-b'
var rowC = document.createElement('div')
rowC.className = 'dshb-row-c'
txt.appendChild(rowA)
txt.appendChild(rowB)
txt.appendChild(rowC)
box.appendChild(txt)
bubble.appendChild(box)
ctrl.appendChild(bubble)
root.appendChild(ctrl)

var menuBtn = document.createElement('button')
menuBtn.type = 'button'
menuBtn.className = 'dshb-menu-btn'
menuBtn.title = '\\u83dc\\u5355'
menuBtn.innerHTML = '<span></span><span></span><span></span>'
menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu() })
root.appendChild(menuBtn)

// ---------- 菜单（挂在 body 下，避免被挂件区域裁剪） ----------
var menuBox = document.createElement('div')
menuBox.className = 'dshb-menu'
function mlabel(text) { var s = document.createElement('span'); s.textContent = text; return s }
function mrow() { var r = document.createElement('div'); r.className = 'dshb-menu-row'; return r }
var scaleInput = document.createElement('input')
scaleInput.type = 'range'
scaleInput.min = String(MIN_SCALE)
scaleInput.max = String(MAX_SCALE)
scaleInput.step = '0.1'
scaleInput.className = 'dshb-range'
scaleInput.value = '1.5'
var scaleNumber = document.createElement('input')
scaleNumber.type = 'number'
scaleNumber.min = '1'
scaleNumber.max = '20'
scaleNumber.step = '1'
scaleNumber.className = 'dshb-number'
scaleNumber.value = '10'
scaleInput.addEventListener('pointerdown', function () { root.style.transition = 'none' })
scaleInput.addEventListener('input', function () { setScale(Number(scaleInput.value)) })
scaleInput.addEventListener('change', function () { root.style.transition = '' })
scaleNumber.addEventListener('focus', function () { root.style.transition = 'none' })
scaleNumber.addEventListener('blur', function () { root.style.transition = '' })
scaleNumber.addEventListener('input', function () { setScale(scaleToValue(Number(scaleNumber.value))) })
scaleNumber.addEventListener('change', function () { setScale(scaleToValue(Number(scaleNumber.value))); root.style.transition = '' })
// —— 字号 / 气泡：独立于整体大小的两档微调（CSS 变量 --dshb-font / --dshb-bub） ——
var FONT_MIN = 0.5, FONT_MAX = 2.0
var BUB_MIN = 0.5, BUB_MAX = 2.0
function mkRange(min, max) {
  var i = document.createElement('input')
  i.type = 'range'
  i.min = String(min)
  i.max = String(max)
  i.step = '0.05'
  i.className = 'dshb-range'
  return i
}
function mkVal() {
  var s = document.createElement('span')
  s.style.cssText = 'width:38px;text-align:right;font-size:12px;color:#203170'
  s.textContent = '100%'
  return s
}
var fontInput = mkRange(FONT_MIN, FONT_MAX)
fontInput.value = '1'
var fontVal = mkVal()
fontInput.addEventListener('input', function () { setFont(Number(fontInput.value)) })
var bubInput = mkRange(BUB_MIN, BUB_MAX)
bubInput.value = '1'
var bubVal = mkVal()
bubInput.addEventListener('input', function () { setBub(Number(bubInput.value)) })
var r5 = mrow(); r5.appendChild(mlabel('\\u5b57\\u53f7')); r5.appendChild(fontInput); r5.appendChild(fontVal)
var r6 = mrow(); r6.appendChild(mlabel('\\u6c14\\u6ce1')); r6.appendChild(bubInput); r6.appendChild(bubVal)
var balToggle = document.createElement('input')
balToggle.type = 'checkbox'
balToggle.className = 'dshb-check'
balToggle.checked = true
balToggle.title = '\\u663e\\u793a\\u4f59\\u989d\\uff08\\u672a\\u914d\\u7f6e DEEPSEEK_API_KEY \\u65f6\\u65e0\\u6548\\u679c\\uff09'
balToggle.addEventListener('change', function () { showBal = balToggle.checked; saveConfig() })
var resetBtn = document.createElement('button')
resetBtn.type = 'button'
resetBtn.className = 'dshb-btn'
resetBtn.textContent = '\\u56de\\u53f3\\u4e0b\\u89d2'
resetBtn.addEventListener('click', function () { resetPos() })
var r1 = mrow(); r1.appendChild(mlabel('\\u5927\\u5c0f')); r1.appendChild(scaleInput); r1.appendChild(scaleNumber)
var r2 = mrow(); r2.appendChild(mlabel('\\u663e\\u793a\\u4f59\\u989d')); r2.appendChild(balToggle)
var r3 = mrow(); r3.appendChild(mlabel('\\u4f4d\\u7f6e')); r3.appendChild(resetBtn)
// —— 自定义图标：选择文件上传（支持 png/jpg/gif/webp，gif 会动） / 恢复默认 ——
var petInput = document.createElement('input')
petInput.type = 'file'
petInput.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif'
petInput.style.display = 'none'
petInput.addEventListener('change', onPetFile)
var pickBtn = document.createElement('button')
pickBtn.type = 'button'
pickBtn.className = 'dshb-btn'
pickBtn.textContent = '\\u9009\\u62e9\\u56fe\\u6807\\u2026'
pickBtn.title = '\\u652f\\u6301 PNG / JPG / GIF / WebP\\uff08GIF \\u4f1a\\u52a8\\uff09\\uff0c\\u5c0f\\u4e8e 4MB'
pickBtn.addEventListener('click', function () { try { petInput.click() } catch (err) {} })
var restorePetBtn = document.createElement('button')
restorePetBtn.type = 'button'
restorePetBtn.className = 'dshb-btn'
restorePetBtn.textContent = '\\u6062\\u590d\\u9ed8\\u8ba4'
restorePetBtn.addEventListener('click', function () { resetPet() })
var r4 = mrow(); r4.appendChild(mlabel('\\u56fe\\u6807')); r4.appendChild(pickBtn); r4.appendChild(restorePetBtn)
var note = document.createElement('div')
note.className = 'dshb-menu-note'
menuBox.appendChild(petInput)
menuBox.appendChild(r1)
menuBox.appendChild(r5)
menuBox.appendChild(r6)
menuBox.appendChild(r2)
menuBox.appendChild(r3)
menuBox.appendChild(r4)
menuBox.appendChild(note)
document.body.appendChild(menuBox)
document.body.appendChild(root)

// ---------- 状态 ----------
var state = {
  scale: 1.5,
  h: 'right', hOff: 0,
  v: 'bottom', vOff: 0,
  left: 0, top: 0,
  activity: { status: 'idle', since: null },
  lastSeq: 0,
  today: { turns: 0, msgs: 0, tokens: { input: 0, cache: 0, output: 0, reason: 0 }, cost: 0 }
}
var showBal = true
var fontScale = 1 // 字号倍率（--dshb-font）
var bubbleScale = 1 // 气泡几何倍率（--dshb-bub）
var balance = null
var bubbleTimer = null
var bubbleOpen = false
var bubbleKind = ''
var seqAligned = false
var mode = 'idle' // idle | busy
var menuOpen = false
var downAt = null

function fmtMoney(n, currency) {
  var num = Number(n)
  if (!isFinite(num)) return '--'
  var fixed
  if (num > 0 && num < 0.01) fixed = num.toFixed(3)
  else if (num >= 100) fixed = num.toFixed(0)
  else fixed = num.toFixed(2)
  return (currency === 'CNY' || !currency) ? ('\\u00a5 ' + fixed) : (fixed + ' ' + currency)
}
function fmtTokens(n) {
  var num = Number(n) || 0
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M'
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'k'
  return String(num)
}
function fmtDur(ms) {
  var s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + 'm' + (s % 60) + 's'
}
function scaleToValue(v) {
  v = Math.round(Number(v) || 10)
  return MIN_SCALE + Math.max(0, Math.min(20, v) - 1) * (MAX_SCALE - MIN_SCALE) / 19
}
function valueToScale(v) {
  return Math.round((v - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / 19)) + 1
}
function todayCost() { return isFinite(Number(state.today.cost)) ? Number(state.today.cost) : 0 }
function todayTokens() {
  var t = state.today.tokens || {}
  return (Number(t.input) || 0) + (Number(t.cache) || 0) + (Number(t.output) || 0) + (Number(t.reason) || 0)
}

// ---------- 气泡 / 状态渲染 ----------
function pillText() {
  var a = state.activity
  if (a && a.status === 'busy' && a.since) {
    var s = Math.max(0, Math.round((Date.now() - a.since) / 1000))
    return '\\u56de\\u590d\\u4e2d ' + s + 's'
  }
  return '\\u6478\\u9c7c\\u4e2d'
}
function setPill() {
  pill.textContent = pillText()
  pill.classList.toggle('dshb-on', !!(state.activity && state.activity.status === 'busy'))
}
function statRows() {
  var t = state.today || {}
  rowA.textContent = '\\u4eca\\u65e5\\u5bf9\\u8bdd'
  rowB.textContent = fmtMoney(todayCost(), 'CNY')
  rowB.classList.add('dshb-red')
  var parts = [fmtTokens(todayTokens()) + ' tokens', (t.turns || 0) + ' \\u8f6e']
  if (showBal && balance && balance.ok) parts.push('\\u4f59\\u989d ' + fmtMoney(balance.totalBalance, balance.currency))
  rowC.textContent = parts.join('  \\u00b7  ')
}
function popupRows(l) {
  rowA.textContent = '\\u4e0a\\u4e00\\u8f6e\\u56de\\u590d'
  rowB.textContent = fmtMoney(l.amount, 'CNY')
  rowB.classList.add('dshb-red')
  var parts = [fmtTokens(l.tokens) + ' tokens']
  if (l.ms) parts.push('\\u7528\\u65f6 ' + fmtDur(l.ms))
  rowC.textContent = parts.join('  \\u00b7  ')
}
function showBubble(kind, autoClose) {
  clearBubbleTimer()
  bubbleOpen = true
  bubbleKind = kind
  bubble.classList.add('dshb-open')
  if (autoClose) bubbleTimer = setTimeout(hideBubble, autoClose)
}
function hideBubble() {
  clearBubbleTimer()
  bubbleOpen = false
  bubbleKind = ''
  bubble.classList.remove('dshb-open')
}
function clearBubbleTimer() { if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null } }
function setMode(m) {
  mode = m
  pet.classList.toggle('dshb-idle', m === 'idle')
  pet.classList.toggle('dshb-busy', m === 'busy')
}
function onState(d) {
  if (!d || !d.ok) return
  var a = d.activity || { status: 'idle' }
  state.activity = a
  if (a.status === 'busy') setMode('busy')
  else setMode('idle')
  setPill()
  if (d.today) state.today = d.today
  var seq = Number(d.last && d.last.seq) || 0
  if (!seqAligned) {
    seqAligned = true
    state.lastSeq = seq
  } else if (seq > state.lastSeq) {
    state.lastSeq = seq
    if (d.last && d.last.amount !== null && d.last.amount !== undefined) {
      popupRows(d.last)
      showBubble('popup', POPUP_MS)
    }
  }
  if (bubbleOpen && bubbleKind === 'stats') statRows()
}
function onBalance(d) {
  if (!d) return
  balance = d
  if (bubbleOpen && bubbleKind === 'stats') statRows()
}

// ---------- 拖拽 + 四分之一吸附（left/top 像素模型；绝不用 right/auto 切换） ----------
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }
function vp() { return { w: window.innerWidth || document.documentElement.clientWidth || 1280, h: window.innerHeight || document.documentElement.clientHeight || 800 } }
function settle() {
  var V = vp()
  var w = root.offsetWidth || root.getBoundingClientRect().width || 0
  var h = root.offsetHeight || root.getBoundingClientRect().height || 0
  if (state.h === 'right') state.left = Math.max(0, V.w - w - state.hOff)
  else if (state.h === 'left') state.left = state.hOff
  else state.left = clamp(state.left, 0, Math.max(0, V.w - w))
  if (state.v === 'bottom') state.top = Math.max(0, V.h - h - state.vOff)
  else if (state.v === 'top') state.top = state.vOff
  else state.top = clamp(state.top, 0, Math.max(0, V.h - h))
  express()
}
function express() {
  root.style.right = 'auto'
  root.style.bottom = 'auto'
  root.style.left = state.left + 'px'
  root.style.top = state.top + 'px'
  root.classList.toggle('dshb-left', state.h === 'left')
  placeMenuBtn()
}
// ⋯ 菜单按钮贴住图标（宠物）的右上角，图标随大小缩放/左右镜像时跟随
function placeMenuBtn() {
  try {
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0
    if (!w || !h) return
    var bw = menuBtn.offsetWidth || Math.round(w * 0.1)
    var bh = menuBtn.offsetHeight || Math.round(w * 0.1)
    var pad = Math.max(2, Math.round(w * 0.015))
    var petL = Math.round(w * 0.34) // 宠物局部 box：右下角 66%，故 left/top = 34%
    var top = Math.round(h * 0.34 + pad)
    var left
    if (state.h === 'left') {
      // 左吸附镜像：宠物视觉移到左半区（0~0.66w），右上角 x≈0.66w，反推本地坐标
      left = petL - bw - pad
    } else {
      left = w - bw - pad
    }
    if (left < pad) left = pad
    if (top + bh > h - 2) top = Math.max(pad, h - bh - pad)
    menuBtn.style.left = left + 'px'
    menuBtn.style.top = top + 'px'
    menuBtn.style.right = 'auto'
    menuBtn.style.bottom = 'auto'
  } catch (err) {}
}
function resetPos() {
  state.h = 'right'; state.hOff = 0
  state.v = 'bottom'; state.vOff = 0
  settle()
  savePos()
  hideBubble()
  closeMenu()
}
pet.addEventListener('pointerdown', function (e) {
  if (e.button !== 0 && e.pointerType === 'mouse') return
  try { e.preventDefault(); e.stopPropagation() } catch (err) {}
  pet.classList.add('dshb-squish')
  var r = root.getBoundingClientRect()
  downAt = { x: e.clientX, y: e.clientY, origLeft: r.left, origTop: r.top, w: r.width, h: r.height, moved: false, V: vp() }
  root.classList.add('dshb-dragging')
  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('pointercancel', onCancel, true)
})
function onMove(e) {
  if (!downAt) return
  var dx = e.clientX - downAt.x
  var dy = e.clientY - downAt.y
  if (dx * dx + dy * dy >= CLICK_SQ) downAt.moved = true
  state.left = clamp(downAt.origLeft + dx, 0, Math.max(0, downAt.V.w - downAt.w))
  state.top = clamp(downAt.origTop + dy, 0, Math.max(0, downAt.V.h - downAt.h))
  express()
}
function onUp(e) {
  if (!downAt) return
  var moved = downAt.moved
  var dx = e.clientX - downAt.x
  var dy = e.clientY - downAt.y
  var left = clamp(downAt.origLeft + dx, 0, Math.max(0, downAt.V.w - downAt.w))
  var top = clamp(downAt.origTop + dy, 0, Math.max(0, downAt.V.h - downAt.h))
  var V = downAt.V
  var cx = left + downAt.w / 2
  var cy = top + downAt.h / 2
  if (cx < V.w / 4) { state.h = 'left'; state.hOff = 0 }
  else if (cx > V.w * 3 / 4) { state.h = 'right'; state.hOff = 0 }
  else { state.h = null; state.hOff = left }
  if (cy < V.h / 4) { state.v = 'top'; state.vOff = 0 }
  else if (cy > V.h * 3 / 4) { state.v = 'bottom'; state.vOff = 0 }
  else { state.v = null; state.vOff = top }
  state.left = left
  state.top = top
  settle()
  downAt = null
  pet.classList.remove('dshb-squish')
  root.classList.remove('dshb-dragging')
  document.removeEventListener('pointermove', onMove, true)
  document.removeEventListener('pointerup', onUp, true)
  document.removeEventListener('pointercancel', onCancel, true)
  if (!moved) {
    if (bubbleOpen) hideBubble()
    else { statRows(); showBubble('stats', BUBBLE_MS) }
  } else {
    savePos()
  }
}
function onCancel() { onUp({ clientX: downAt ? downAt.x : 0, clientY: downAt ? downAt.y : 0 }) }
bubble.addEventListener('click', function (e) {
  try { e.stopPropagation() } catch (err) {}
  hideBubble()
})
document.addEventListener('pointerdown', function (e) {
  if (e.target && e.target.closest) {
    if (e.target.closest('.dshb-menu') || e.target.closest('.dshb-menu-btn') || e.target.closest('.dshb-pet') || e.target.closest('.dshb-bubble')) return
  }
  if (menuOpen) closeMenu()
  if (bubbleOpen && bubbleKind !== 'popup') hideBubble()
}, true)
document.addEventListener('pointermove', function (e) {
  if (downAt && downAt.moved) { menuBtn.classList.add('dshb-show'); return }
  var el = null
  try { el = document.elementFromPoint(e.clientX, e.clientY) } catch (err) {}
  if (el && el.closest && el.closest('.dshb-pet')) menuBtn.classList.add('dshb-show')
  else menuBtn.classList.remove('dshb-show')
}, true)

// ---------- 菜单 ----------
function toggleMenu() {
  menuOpen = !menuOpen
  if (menuOpen) positionMenu()
  menuBox.classList.toggle('dshb-open', menuOpen)
  if (menuOpen) menuBtn.classList.add('dshb-show')
}
function closeMenu() {
  menuOpen = false
  menuBox.classList.remove('dshb-open')
  root.style.transition = ''
}
function positionMenu() {
  try {
    var b = menuBtn.getBoundingClientRect()
    var V = vp()
    var r = root.getBoundingClientRect()
    var onLeft = r.left + r.width / 2 < V.w / 2
    if (onLeft) { menuBox.style.left = b.left + 'px'; menuBox.style.right = 'auto'; menuBox.style.transformOrigin = 'bottom left' }
    else { menuBox.style.right = (V.w - b.right) + 'px'; menuBox.style.left = 'auto'; menuBox.style.transformOrigin = 'bottom right' }
    menuBox.style.bottom = (V.h - b.top) + 'px'
    menuBox.style.top = 'auto'
  } catch (err) {}
}
function setScale(v) {
  var next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v))) * 10) / 10
  var prevTrans = root.style.transition
  root.style.transition = 'none'
  var rect = root.getBoundingClientRect()
  var fx = state.h === 'left' ? rect.left : rect.right
  var fy = rect.bottom
  state.scale = next
  root.style.setProperty('--dshb-scale', String(next))
  scaleInput.value = String(next)
  scaleNumber.value = String(valueToScale(next))
  saveConfig()
  var r2 = root.getBoundingClientRect()
  var V = vp()
  if (state.h === 'left') state.left = Math.min(Math.max(fx, 0), Math.max(0, V.w - r2.width))
  else state.left = Math.min(Math.max(fx - r2.width, 0), Math.max(0, V.w - r2.width))
  state.top = Math.min(Math.max(fy - r2.height, 0), Math.max(0, V.h - r2.height))
  express()
  requestAnimationFrame(function () { root.style.transition = prevTrans })
}
function setFont(v) {
  var next = Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, Number(v))) * 100) / 100
  fontScale = next
  root.style.setProperty('--dshb-font', String(next))
  fontInput.value = String(next)
  fontVal.textContent = Math.round(next * 100) + '%'
  saveConfig()
}
function setBub(v) {
  var next = Math.round(Math.min(BUB_MAX, Math.max(BUB_MIN, Number(v))) * 100) / 100
  bubbleScale = next
  root.style.setProperty('--dshb-bub', String(next))
  bubInput.value = String(next)
  bubVal.textContent = Math.round(next * 100) + '%'
  saveConfig()
}
window.addEventListener('resize', function () {
  if (state.h === null && state.v === null && loadPos()) return
  settle()
})

// ---------- 持久化 ----------
function saveConfig() {
  try {
    fetch(CONFIG_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scale: state.scale, showBalance: showBal, fontScale: fontScale, bubbleScale: bubbleScale }) })
  } catch (err) {}
}
function savePos() {
  try {
    var V = vp()
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0
    var leftDist = state.left
    var rightDist = V.w - state.left - w
    var topDist = state.top
    var bottomDist = V.h - state.top - h
    localStorage.setItem('dshb-pos', JSON.stringify({
      v: 1,
      hAnchor: leftDist <= rightDist ? 'left' : 'right',
      hDist: Math.round(Math.min(leftDist, rightDist)),
      vAnchor: topDist <= bottomDist ? 'top' : 'bottom',
      vDist: Math.round(Math.min(topDist, bottomDist))
    }))
  } catch (err) {}
}
function loadPos() {
  try {
    var a = JSON.parse(localStorage.getItem('dshb-pos') || 'null')
    if (!a || a.v !== 1 || (a.hAnchor !== 'left' && a.hAnchor !== 'right') || (a.vAnchor !== 'top' && a.vAnchor !== 'bottom')) return false
    var V = vp()
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0
    var l = a.hAnchor === 'left' ? a.hDist : V.w - a.hDist - w
    var t = a.vAnchor === 'top' ? a.vDist : V.h - a.vDist - h
    state.left = clamp(l, 0, Math.max(0, V.w - w))
    state.top = clamp(t, 0, Math.max(0, V.h - h))
    state.h = a.hAnchor; state.hOff = 0
    state.v = a.vAnchor; state.vOff = 0
    settle()
    return true
  } catch (err) { return false }
}

// ---------- 初始化 ----------
var rect0 = root.getBoundingClientRect()
state.left = rect0.left
state.top = rect0.top
express()
statRows()
setPill()

// —— 自定义宠物图标：hasPet=true 用上传图片（含 gif），否则回退 emoji ——
function applyPet(has, ts) {
  pet.classList.toggle('dshb-custom', !!has)
  if (has) {
    var v = Number(ts) || Date.now()
    petImg.src = PET_URL + '?v=' + v
    note.textContent = ''
  } else {
    petImg.removeAttribute('src')
  }
}
function onPetFile() {
  var f = petInput.files && petInput.files[0]
  try { petInput.value = '' } catch (err) {}
  if (!f) return
  if (f.type && f.type.indexOf('image/') !== 0) {
    note.textContent = '\\u4ec5\\u652f\\u6301\\u56fe\\u7247\\u6587\\u4ef6 (png/jpg/gif/webp)'
    return
  }
  if (f.size > 4 * 1024 * 1024) {
    note.textContent = '\\u6587\\u4ef6\\u8fc7\\u5927\\uff0c\\u9650 4MB \\u4ee5\\u5185'
    return
  }
  note.textContent = '\\u4e0a\\u4f20\\u4e2d\\u2026'
  var rd = new FileReader()
  rd.onload = function () {
    fetch(PET_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: rd.result
    })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (d && d.ok) {
          applyPet(true, d.ts)
          note.textContent = '\\u5df2\\u66ff\\u6362\\u56fe\\u6807 (' + (d.mime || '') + ')'
        } else {
          note.textContent = '\\u66ff\\u6362\\u5931\\u8d25: ' + ((d && d.error) || 'unknown')
        }
      })
      .catch(function (e) { note.textContent = '\\u4e0a\\u4f20\\u5931\\u8d25' })
  }
  rd.onerror = function () { note.textContent = '\\u8bfb\\u53d6\\u6587\\u4ef6\\u5931\\u8d25' }
  try { rd.readAsArrayBuffer(f) } catch (err) { note.textContent = '\\u8bfb\\u53d6\\u6587\\u4ef6\\u5931\\u8d25' }
}
function resetPet() {
  note.textContent = '\\u6b63\\u5728\\u6062\\u590d\\u2026'
  fetch(PET_URL, { method: 'DELETE' })
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (d && d.ok) {
        applyPet(false, 0)
        note.textContent = '\\u5df2\\u6062\\u590d\\u9ed8\\u8ba4\\u56fe\\u6807'
      } else {
        note.textContent = '\\u6062\\u590d\\u5931\\u8d25'
      }
    })
    .catch(function () { note.textContent = '\\u6062\\u590d\\u5931\\u8d25' })
}

function boot(d) {
  if (d) {
    if (typeof d.scale === 'number' && d.scale >= MIN_SCALE - 0.1 && d.scale <= MAX_SCALE + 0.1) {
      state.scale = d.scale
      root.style.setProperty('--dshb-scale', String(d.scale))
      scaleInput.value = String(d.scale)
      scaleNumber.value = String(valueToScale(d.scale))
      settle()
    }
    if (typeof d.showBalance === 'boolean') {
      showBal = d.showBalance
      balToggle.checked = showBal
    }
    // 字号 / 气泡独立倍率
    if (typeof d.fontScale === 'number' && d.fontScale >= FONT_MIN - 0.01 && d.fontScale <= FONT_MAX + 0.01) {
      fontScale = d.fontScale
      root.style.setProperty('--dshb-font', String(d.fontScale))
      fontInput.value = String(d.fontScale)
      fontVal.textContent = Math.round(d.fontScale * 100) + '%'
    }
    if (typeof d.bubbleScale === 'number' && d.bubbleScale >= BUB_MIN - 0.01 && d.bubbleScale <= BUB_MAX + 0.01) {
      bubbleScale = d.bubbleScale
      root.style.setProperty('--dshb-bub', String(d.bubbleScale))
      bubInput.value = String(d.bubbleScale)
      bubVal.textContent = Math.round(d.bubbleScale * 100) + '%'
    }
    // 自定义图标：存在即切换为图片渲染（gif 浏览器原生播放）
    if (d.hasPet) applyPet(true, d.petTs || 0)
    if (d.hasKey === false) {
      note.textContent = '\\u672a\\u914d\\u7f6e DEEPSEEK_API_KEY\\uff0c\\u4f59\\u989d\\u884c\\u5c06\\u81ea\\u52a8\\u9690\\u85cf\\u3002\\u5728 DSH \\u51ed\\u636e\\u7ba1\\u7406\\u4e2d\\u914d\\u7f6e\\u540e\\u91cd\\u542f\\u5373\\u53ef\\u663e\\u793a\\u3002'
    }
  }
  loadPos()
  poll()
  pollBalance()
}
fetch(CONFIG_URL, { cache: 'no-store' })
  .then(function (r) { return r.json() })
  .then(boot)
  .catch(function () { boot(null) })
setInterval(poll, STATE_MS)
setInterval(pollBalance, BALANCE_MS)
function poll() {
  try {
    fetch(STATE_URL, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(onState)
      .catch(function () {})
  } catch (err) {}
}
function pollBalance() {
  if (!showBal) return
  try {
    fetch(BALANCE_URL, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(onBalance)
      .catch(function () {})
  } catch (err) {}
}
})()`

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

  function todayKey() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }
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
  function sumTokens(t) {
    t = t || {}
    return (Number(t.input) || 0) + (Number(t.cache) || 0) + (Number(t.output) || 0) + (Number(t.reason) || 0)
  }
  function ensureToday() {
    let day = readDaily()
    const t = todayKey()
    if (day.date !== t) {
      if (day.date && typeof day.cost === 'number') {
        day.history = day.history || {}
        day.history[day.date] = { turns: day.turns || 0, cost: day.cost, tokens: sumTokens(day.tokens) }
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
    const p = (n) => String(n).padStart(2, '0')
    for (let i = 6; i >= 0; i--) {
      const d = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - i)
      const key = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      if (key === day.date) {
        list.push({ date: key, turns: day.turns || 0, cost: day.cost || 0, tokens: sumTokens(day.tokens) })
      } else {
        const h = (day.history || {})[key]
        list.push(h ? { date: key, turns: h.turns || 0, cost: h.cost || 0, tokens: h.tokens || 0 } : { date: key, turns: 0, cost: 0, tokens: 0 })
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
    const pr = priceFor(model)
    const off = isPeakTime(Math.floor(Date.now() / 1000)) ? 1 : 0
    day.cost = (day.cost || 0) + (cache / 1e6) * pr.hit[off] + (input / 1e6) * pr.miss[off] + ((output + reason) / 1e6) * pr.out[off]
    writeDaily(day)
  }
  function finalizeTurn(sessionId) {
    const agg = turnAggs.get(sessionId)
    if (agg && agg.cost > 0) {
      const day = ensureToday()
      day.turns = (day.turns || 0) + 1
      writeDaily(day)
      lastTurn = { turn: agg.turn, amount: agg.cost, tokens: agg.tokens, ms: agg.lastTs - agg.startedAt, ts: agg.lastTs }
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
        agg = { turn, cost: 0, tokens: 0, startedAt: now, lastTs: now }
        turnAggs.set(sessionId, agg)
      }
      const input = Number(usage.inputTokens) || 0
      const cache = Number(usage.cacheReadTokens) || 0
      const output = Number(usage.outputTokens) || 0
      const reason = Number(usage.reasoningTokens) || 0
      agg.tokens += input + cache + output + reason
      const pr = priceFor(model)
      const off = isPeakTime(Math.floor(now / 1000)) ? 1 : 0
      agg.cost += (cache / 1e6) * pr.hit[off] + (input / 1e6) * pr.miss[off] + ((output + reason) / 1e6) * pr.out[off]
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
    balanceInFlight = fetchBalance()
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
            fontScale: typeof parsed.fontScale === 'number' && parsed.fontScale >= 0.49 && parsed.fontScale <= 2.01 ? parsed.fontScale : 1,
            bubbleScale: typeof parsed.bubbleScale === 'number' && parsed.bubbleScale >= 0.49 && parsed.bubbleScale <= 2.01 ? parsed.bubbleScale : 1,
            petMime: typeof parsed.petMime === 'string' ? parsed.petMime : null,
            petTs: typeof parsed.petTs === 'number' ? parsed.petTs : null,
            petBusyMime: typeof parsed.petBusyMime === 'string' ? parsed.petBusyMime : null,
            petBusyTs: typeof parsed.petBusyTs === 'number' ? parsed.petBusyTs : null,
          }
        }
      } catch (err) {}
    }
    return { scale: 1.5, showBalance: true, fontScale: 1, bubbleScale: 1, petMime: null, petTs: null, petBusyMime: null, petBusyTs: null }
  }
  // 合并式写入：单次更新部分字段时保留其余字段（scale/showBalance/fontScale/bubbleScale/pet 元数据）
  function writeConfig(partial) {
    const old = readConfig()
    const next = {
      scale: partial.scale !== undefined && typeof partial.scale === 'number' ? partial.scale : old.scale,
      showBalance: partial.showBalance !== undefined ? partial.showBalance !== false : old.showBalance,
      fontScale: partial.fontScale !== undefined ? partial.fontScale : old.fontScale,
      bubbleScale: partial.bubbleScale !== undefined ? partial.bubbleScale : old.bubbleScale,
      petMime: partial.petMime !== undefined ? partial.petMime : old.petMime,
      petTs: partial.petTs !== undefined ? partial.petTs : old.petTs,
      petBusyMime: partial.petBusyMime !== undefined ? partial.petBusyMime : old.petBusyMime,
      petBusyTs: partial.petBusyTs !== undefined ? partial.petBusyTs : old.petBusyTs,
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
            ? { seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ms: lastTurn.ms, ts: lastTurn.ts }
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

  // ---- 自定义宠物图标：GET 原图 / PUT 上传 / DELETE 恢复默认；?slot=busy 为回复图标 ----
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-buddy/pet',
    handler: async (req, res) => {
      try {
        const busy = petSlotBusy(req.url)
        const method = req.method
        const mimeKey = busy ? 'petBusyMime' : 'petMime'
        const tsKey = busy ? 'petBusyTs' : 'petTs'
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
          const list = busy ? PET_BUSY_CANDIDATES : PET_CANDIDATES
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
          sendJson(res, { ok: true, mime, size: buf.length, ts, slot: busy ? 'busy' : 'idle' })
          return
        }
        if (method === 'DELETE') {
          petDelete(busy)
          const partial = {}
          partial[mimeKey] = null
          partial[tsKey] = null
          writeConfig(partial)
          sendJson(res, { ok: true, slot: busy ? 'busy' : 'idle' })
          return
        }
        // GET：自定义字节优先，其次打包默认图标；两者皆无才 404
        let bytes = petRead(busy)
        const isDefault = !bytes
        if (!bytes) bytes = petDefaultRead(busy)
        if (!bytes) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end('no pet image')
          return
        }
        const cfg = readConfig()
        res.writeHead(200, {
          'Content-Type': (isDefault ? null : (busy ? cfg.petBusyMime : cfg.petMime)) || sniffPetMime(bytes) || 'application/octet-stream',
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
          const partial = { scale, showBalance }
          if (fontScale !== undefined) partial.fontScale = fontScale
          if (bubbleScale !== undefined) partial.bubbleScale = bubbleScale
          writeConfig(partial)
          const cfg = readConfig()
          sendJson(res, {
            ok: true, scale, showBalance, fontScale: cfg.fontScale, bubbleScale: cfg.bubbleScale,
            petMime: cfg.petMime, petTs: cfg.petTs, hasPet: !!cfg.petMime,
            petBusyMime: cfg.petBusyMime, petBusyTs: cfg.petBusyTs, hasBusyPet: !!cfg.petBusyMime,
          })
          return
        }
        const cfg = readConfig()
        let hasKey = false
        try { hasKey = !!(await ctx.credentials.resolve('DEEPSEEK_API_KEY')) } catch (err) {}
        sendJson(res, {
          ...cfg,
          hasKey,
          hasPet: !!(cfg.petMime && petRead(false)),
          hasBusyPet: !!(cfg.petBusyMime && petRead(true)),
          hasDefaultPet: !!petDefaultRead(false),
          hasDefaultBusyPet: !!petDefaultRead(true),
        })
      } catch (err) {
        res.writeHead(400, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
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
