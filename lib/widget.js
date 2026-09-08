(function () {
if (window.__dshBuddyWidget) return
window.__dshBuddyWidget = true

// 自检探针：把运行期异常打上 [dsh-buddy] 前缀，方便与平台报错区分
function buddyLog() {
  try {
    var args = Array.prototype.slice.call(arguments)
    console.log.apply(console, ['[dsh-buddy]'].concat(args))
  } catch (e) {}
}
window.addEventListener('error', function (e) {
  try {
    buddyLog('[page-error]', e && e.message ? e.message : e, e && e.filename ? e.filename : '', e && e.lineno ? e.lineno : '')
  } catch (_) {}
})
window.addEventListener('unhandledrejection', function (e) {
  try {
    var r = e && e.reason
    buddyLog('[unhandledrejection]', r && r.message ? r.message : String(r))
  } catch (_) {}
})

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
var PET_URL = '/dsh-buddy/pet' // 普通图标（idle）
var PET_BUSY_URL = '/dsh-buddy/pet?slot=busy' // 回复图标（busy）
var IDLE_EMOJI = '\ud83d\udc19' // 🐙
var BUSY_EMOJI = '\u270d\ufe0f' // ✍️（回复默认，未设回复图标时使用）

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
  '.dshb-menu-row{display:flex;align-items:center;gap:8px;margin:6px 0;color:#203170;font-size:12px;white-space:nowrap}',
  '.dshb-menu .dshb-menu-label{flex:0 0 60px;color:#203170;font-size:12px;overflow:hidden;text-overflow:ellipsis}',
  '.dshb-menu .dshb-range{flex:1 1 auto;min-width:0;accent-color:#203170}',
  '.dshb-menu .dshb-number{width:46px;flex:0 0 46px;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:2px 4px;font-size:12px;color:#203170;background:#fff;box-sizing:border-box}',
  '.dshb-menu .dshb-val{width:46px;flex:0 0 46px;text-align:right;color:#203170;font-size:12px}',
  '.dshb-menu .dshb-check{width:16px;height:16px;accent-color:#203170;cursor:pointer;flex:0 0 16px;margin-left:auto}',
  '.dshb-menu .dshb-btn{border:1px solid rgba(32,49,112,.4);border-radius:8px;background:rgba(32,49,112,.08);color:#203170;font-size:12px;padding:4px 8px;cursor:pointer;min-width:70px;text-align:center}',
  '.dshb-menu .dshb-btn:hover{background:rgba(32,49,112,.18)}',
  '.dshb-menu .dshb-actions{display:flex;gap:6px;flex:1 0 auto;justify-content:flex-end}',
  '.dshb-menu .dshb-actions .dshb-btn{margin-left:0}',
  '.dshb-menu-note{font-size:11px;color:#9fb0d9;margin-top:4px;line-height:1.5;max-width:230px;white-space:normal}',
  '.dshb-menu-sep{height:1px;background:rgba(32,49,112,.2);margin:8px 0}'
].join('\n')

var styleEl = document.createElement('style')
styleEl.textContent = css
document.head.appendChild(styleEl)

var root = document.createElement('div')
root.className = 'dshb-root'

var ctrl = document.createElement('div')
ctrl.className = 'dshb-ctrl'
var pet = document.createElement('div')
pet.className = 'dshb-pet dshb-idle'
var petImg = document.createElement('img')
petImg.className = 'dshb-pet-img'
petImg.alt = ''
petImg.draggable = false
var emoji = document.createElement('span')
emoji.className = 'dshb-emoji'
emoji.textContent = '\ud83d\udc19' // \u76ca\u5927\u7ae0\u9c7c
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
menuBtn.title = '\u83dc\u5355'
menuBtn.innerHTML = '<span></span><span></span><span></span>'
menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu() })
root.appendChild(menuBtn)

// ---------- 菜单（挂在 body 下，避免被挂件区域裁剪） ----------
var menuBox = document.createElement('div')
menuBox.className = 'dshb-menu'
function mlabel(text) { var s = document.createElement('span'); s.textContent = text; s.className = 'dshb-menu-label'; return s }
function mrow() { var r = document.createElement('div'); r.className = 'dshb-menu-row'; return r }
function mactions() { var a = document.createElement('div'); a.className = 'dshb-actions'; return a }
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
  s.className = 'dshb-val'
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
var r5 = mrow(); r5.appendChild(mlabel('\u5b57\u53f7')); r5.appendChild(fontInput); r5.appendChild(fontVal)
var r6 = mrow(); r6.appendChild(mlabel('\u6c14\u6ce1')); r6.appendChild(bubInput); r6.appendChild(bubVal)
var balToggle = document.createElement('input')
balToggle.type = 'checkbox'
balToggle.className = 'dshb-check'
balToggle.checked = true
balToggle.title = '\u663e\u793a\u4f59\u989d\uff08\u672a\u914d\u7f6e DEEPSEEK_API_KEY \u65f6\u65e0\u6548\u679c\uff09'
balToggle.addEventListener('change', function () { showBal = balToggle.checked; saveConfig() })
var resetBtn = document.createElement('button')
resetBtn.type = 'button'
resetBtn.className = 'dshb-btn'
resetBtn.textContent = '\u56de\u53f3\u4e0b\u89d2'
resetBtn.addEventListener('click', function () { resetPos() })
var r1 = mrow(); r1.appendChild(mlabel('\u5927\u5c0f')); r1.appendChild(scaleInput); r1.appendChild(scaleNumber)
var r2 = mrow(); r2.appendChild(mlabel('\u663e\u793a\u4f59\u989d')); r2.appendChild(balToggle)
var r3 = mrow(); r3.appendChild(mlabel('\u4f4d\u7f6e')); var actPos = mactions(); actPos.appendChild(resetBtn); r3.appendChild(actPos)
// —— 自定义图标：普通图标 + 回复图标，各自可上传/恢复（png/jpg/gif/webp，gif 会动）——
function makeIconRow(slot, label) {
  var row = mrow()
  row.appendChild(mlabel(label))
  var input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/avif'
  input.style.display = 'none'
  input.addEventListener('change', function () { onIconFile(slot, input) })
  var pick = document.createElement('button')
  pick.type = 'button'
  pick.className = 'dshb-btn'
  pick.textContent = '\u9009\u62e9\u56fe\u6807\u2026'
  pick.title = '\u652f\u6301 PNG / JPG / GIF / WebP\uff08GIF \u4f1a\u52a8\uff09\uff0c\u5c0f\u4e8e 4MB'
  pick.addEventListener('click', function () { try { input.click() } catch (err) {} })
  var restore = document.createElement('button')
  restore.type = 'button'
  restore.className = 'dshb-btn'
  restore.textContent = '\u6062\u590d\u9ed8\u8ba4'
  restore.addEventListener('click', function () { resetIcon(slot) })
  var act = mactions()
  act.appendChild(pick)
  act.appendChild(restore)
  row.appendChild(act)
  menuBox.appendChild(input)
  return row
}
var r4 = makeIconRow('idle', '\u56fe\u6807')
var rIconBusy = makeIconRow('busy', '\u56de\u590d\u56fe\u6807')
var note = document.createElement('div')
note.className = 'dshb-menu-note'
menuBox.appendChild(r1)
menuBox.appendChild(r5)
menuBox.appendChild(r6)
menuBox.appendChild(r2)
menuBox.appendChild(r3)
menuBox.appendChild(r4)
menuBox.appendChild(rIconBusy)
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
  return (currency === 'CNY' || !currency) ? ('\u00a5 ' + fixed) : (fixed + ' ' + currency)
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
    return '\u56de\u590d\u4e2d ' + s + 's'
  }
  return '\u6478\u9c7c\u4e2d'
}
function setPill() {
  pill.textContent = pillText()
  pill.classList.toggle('dshb-on', !!(state.activity && state.activity.status === 'busy'))
}
function statRows() {
  var t = state.today || {}
  rowA.textContent = '\u4eca\u65e5\u5bf9\u8bdd'
  rowB.textContent = fmtMoney(todayCost(), 'CNY')
  rowB.classList.add('dshb-red')
  var parts = [fmtTokens(todayTokens()) + ' tokens', (t.turns || 0) + ' \u8f6e']
  if (showBal && balance && balance.ok) parts.push('\u4f59\u989d ' + fmtMoney(balance.totalBalance, balance.currency))
  rowC.textContent = parts.join('  \u00b7  ')
}
function popupRows(l) {
  rowA.textContent = '\u4e0a\u4e00\u8f6e\u56de\u590d'
  rowB.textContent = fmtMoney(l.amount, 'CNY')
  rowB.classList.add('dshb-red')
  var parts = [fmtTokens(l.tokens) + ' tokens']
  if (l.ms) parts.push('\u7528\u65f6 ' + fmtDur(l.ms))
  rowC.textContent = parts.join('  \u00b7  ')
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
  if (m === mode) return // 状态未变：不重设图标 src，避免 GIF 每秒被重播
  mode = m
  pet.classList.toggle('dshb-idle', m === 'idle')
  pet.classList.toggle('dshb-busy', m === 'busy')
  refreshIcon() // 状态切换 → 在普通图标/回复图标之间切换
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
      // 左吸附镜像：宠物视觉移到 [0, 0.66w]，其右上角视觉 x=0.66w；
      // 镜像本地坐标 x'=w-x，反推本地 left = petL + pad，使按钮与右吸附时同距贴角
      left = petL + pad
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
  var r = root.getBoundingClientRect()
  downAt = { x: e.clientX, y: e.clientY, origLeft: r.left, origTop: r.top, w: r.width, h: r.height, moved: false, V: vp() }
  root.classList.add('dshb-dragging')
  // 拖拽期间让 ⋯ 按钮让路，避免从图标右上角起手时误触发菜单
  try { menuBtn.style.pointerEvents = 'none' } catch (err) {}
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
  root.classList.remove('dshb-dragging')
  try { menuBtn.style.pointerEvents = 'auto' } catch (err) {}
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
    // 面板未显示时也可测量（仅 opacity:0，非 display:none）
    var mw = menuBox.offsetWidth || 210
    var mh = menuBox.offsetHeight || 250
    var gap = 6
    // 按钮上方空间不足时改为在下方弹出，避免菜单跑出视口
    var below = b.top < mh + gap * 2
    var x = onLeft ? (b.left - gap) : (b.right - mw + gap)
    x = Math.max(8, Math.min(x, Math.max(8, V.w - mw - 8)))
    var y = below ? (b.bottom + gap) : (b.top - mh - gap)
    y = Math.max(8, Math.min(y, Math.max(8, V.h - mh - 8)))
    menuBox.style.left = Math.round(x) + 'px'
    menuBox.style.right = 'auto'
    menuBox.style.top = Math.round(y) + 'px'
    menuBox.style.bottom = 'auto'
    var ox = onLeft ? 'left' : 'right'
    var oy = below ? 'top' : 'bottom'
    menuBox.style.transformOrigin = oy + ' ' + ox
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
refreshIcon()

// —— 宠物图标：普通/回复各分「自定义 + 打包默认」两层，busy 时自动切换 ——
var idleCustom = false, idleCustomTs = 0
var busyCustom = false, busyCustomTs = 0
var petDefaultIdle = false // 插件打包默认图标（assets/pet-default.*）
var petDefaultBusy = false // 插件打包默认回复图标（assets/pet-busy-default.*）
function petSlotUrl(slot) { return slot === 'busy' ? PET_BUSY_URL : PET_URL }
var lastPetSrc = null // 记录当前 img src，src 不变时不做重设（避免 GIF 重播）
function refreshIcon() {
  var b = mode === 'busy'
  var hasCustom = b ? busyCustom : idleCustom
  var hasAny = hasCustom || (b ? petDefaultBusy : petDefaultIdle)
  if (hasAny) {
    var v = hasCustom ? ((b ? busyCustomTs : idleCustomTs) || Date.now()) : 'def0'
    var src = petSlotUrl(b ? 'busy' : 'idle') + '?v=' + v
    if (lastPetSrc === src) return // 同一图继续播放，不打断
    lastPetSrc = src
    emoji.style.display = 'none'
    petImg.style.display = 'block'
    petImg.src = src
    petImg.onerror = function () {
      // 图源加载失败 → 回到对应状态的默认表情
      lastPetSrc = null
      petImg.style.display = 'none'
      petImg.removeAttribute('src')
      emoji.style.display = ''
      emoji.textContent = b ? BUSY_EMOJI : IDLE_EMOJI
    }
  } else {
    lastPetSrc = null
    petImg.style.display = 'none'
    petImg.removeAttribute('src')
    emoji.style.display = ''
    emoji.textContent = b ? BUSY_EMOJI : IDLE_EMOJI
  }
}
function setCustom(slot, has, ts) {
  if (slot === 'busy') { busyCustom = has; busyCustomTs = has ? (Number(ts) || Date.now()) : 0 }
  else { idleCustom = has; idleCustomTs = has ? (Number(ts) || Date.now()) : 0 }
  refreshIcon()
}
function onIconFile(slot, input) {
  var f = input.files && input.files[0]
  try { input.value = '' } catch (err) {}
  if (!f) return
  if (f.type && f.type.indexOf('image/') !== 0) {
    note.textContent = '\u4ec5\u652f\u6301\u56fe\u7247\u6587\u4ef6 (png/jpg/gif/webp)'
    return
  }
  if (f.size > 4 * 1024 * 1024) {
    note.textContent = '\u6587\u4ef6\u8fc7\u5927\uff0c\u9650 4MB \u4ee5\u5185'
    return
  }
  note.textContent = '\u4e0a\u4f20\u4e2d\u2026'
  var rd = new FileReader()
  rd.onload = function () {
    fetch(petSlotUrl(slot), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: rd.result
    })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (d && d.ok) {
          setCustom(slot, true, d.ts)
          note.textContent = (slot === 'busy' ? '\u5df2\u66ff\u6362\u56de\u590d\u56fe\u6807' : '\u5df2\u66ff\u6362\u56fe\u6807') + ' (' + (d.mime || '') + ')'
        } else {
          note.textContent = '\u66ff\u6362\u5931\u8d25: ' + ((d && d.error) || 'unknown')
        }
      })
      .catch(function () { note.textContent = '\u4e0a\u4f20\u5931\u8d25' })
  }
  rd.onerror = function () { note.textContent = '\u8bfb\u53d6\u6587\u4ef6\u5931\u8d25' }
  try { rd.readAsArrayBuffer(f) } catch (err) { note.textContent = '\u8bfb\u53d6\u6587\u4ef6\u5931\u8d25' }
}
function resetIcon(slot) {
  note.textContent = '\u6b63\u5728\u6062\u590d\u2026'
  fetch(petSlotUrl(slot), { method: 'DELETE' })
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (d && d.ok) {
        setCustom(slot, false, 0)
        note.textContent = slot === 'busy' ? '\u5df2\u6062\u590d\u9ed8\u8ba4\u56de\u590d\u56fe\u6807' : '\u5df2\u6062\u590d\u9ed8\u8ba4\u56fe\u6807'
      } else {
        note.textContent = '\u6062\u590d\u5931\u8d25'
      }
    })
    .catch(function () { note.textContent = '\u6062\u590d\u5931\u8d25' })
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
    // 自定义图标优先；无自定义时回退到插件打包默认图标（再回退 emoji）
    if (typeof d.hasDefaultPet === 'boolean') petDefaultIdle = d.hasDefaultPet
    if (typeof d.hasDefaultBusyPet === 'boolean') petDefaultBusy = d.hasDefaultBusyPet
    if (d.hasPet) setCustom('idle', true, d.petTs || 0)
    if (d.hasBusyPet) setCustom('busy', true, d.petBusyTs || 0)
    if (d.hasKey === false) {
      note.textContent = '\u672a\u914d\u7f6e DEEPSEEK_API_KEY\uff0c\u4f59\u989d\u884c\u5c06\u81ea\u52a8\u9690\u85cf\u3002\u5728 DSH \u51ed\u636e\u7ba1\u7406\u4e2d\u914d\u7f6e\u540e\u91cd\u542f\u5373\u53ef\u663e\u793a\u3002'
    }
    refreshIcon()
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
})()