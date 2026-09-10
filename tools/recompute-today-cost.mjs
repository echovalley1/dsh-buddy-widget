import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = 'C:/Users/ECHO-VALLEY/.dsh/sessions'
const DAILY = path.join(process.env.USERPROFILE || 'C:/Users/ECHO-VALLEY', '.dsh', '.dshb-daily.json')

// ---- 官方价表（CNY / 百万 token；[空闲, 高峰]） ----
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
function priceFor(model) {
  const m = String(model || '').toLowerCase()
  return m.indexOf('deepseek-v4-pro') !== -1 ? PRO_PRICE : BASE_PRICE
}
function isPeak(timeMs) {
  const bj = new Date(timeMs + 8 * 3600 * 1000)
  const dow = bj.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const h = bj.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

// ---- 多帧 zstd：按块头长度遍历帧边界 ----
function frameEnd(buf, pos) {
  if (buf.length < pos + 5) return -1
  if (!(buf[pos] === 0x28 && buf[pos + 1] === 0xb5 && buf[pos + 2] === 0x2f && buf[pos + 3] === 0xfd)) return -1
  const fhd = buf[pos + 4]
  const fcsFlag = (fhd >> 6) & 3
  const single = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const didFlag = fhd & 3
  let p = pos + 5
  if (!single) p += 1
  if (didFlag === 1) p += 1
  else if (didFlag === 2) p += 2
  else if (didFlag === 3) p += 4
  if (fcsFlag === 0) { if (single) p += 1 }
  else if (fcsFlag === 1) p += 2
  else if (fcsFlag === 2) p += 4
  else p += 8
  while (p + 3 <= buf.length) {
    const b0 = buf[p], b1 = buf[p + 1], b2 = buf[p + 2]
    const last = b0 & 1
    const type = (b0 >> 1) & 3
    const size = (b0 >> 3) | (b1 << 5) | (b2 << 13)
    p += 3
    if (type === 0) p += size
    else if (type === 1) p += 1
    else if (type === 2) p += size
    else return -1
    if (last) { if (checksum) p += 4; return p }
  }
  return -1
}
function decodeAll(buf) {
  const out = []
  let pos = 0
  while (pos < buf.length - 4) {
    if (!(buf[pos] === 0x28 && buf[pos + 1] === 0xb5 && buf[pos + 2] === 0x2f && buf[pos + 3] === 0xfd)) { pos++; continue }
    const end = frameEnd(buf, pos)
    if (end <= pos) { pos++; continue }
    try { out.push(zlib.zstdDecompressSync(buf.subarray(pos, end))) } catch (e) {}
    pos = end
  }
  return Buffer.concat(out).toString('utf8')
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.jsonl.zstd')) acc.push(p)
  }
  return acc
}

// ---- 目标日期（--date=YYYY-MM-DD，缺省今天） ----
const argv = process.argv.slice(2)
const dateArg = (() => {
  const withEq = argv.find((a) => a.startsWith('--date='))
  if (withEq) return withEq.slice('--date='.length)
  const i = argv.indexOf('--date')
  return i >= 0 ? argv[i + 1] : null
})()
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const target = dateArg
  ? new Date(Number(dateArg.slice(0, 4)), Number(dateArg.slice(5, 7)) - 1, Number(dateArg.slice(8, 10)))
  : new Date(now.getFullYear(), now.getMonth(), now.getDate())
const targetKey = target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate())
const rangeStart = target.getTime()
const rangeEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1).getTime()

const agg = { input: 0, cache: 0, output: 0, reason: 0, cost: 0, costOff: 0, costPeak: 0, msgs: 0, turns: 0, peakMsgs: 0, sessions: 0, byModel: {} }
for (const f of walk(SESSIONS)) {
  let text
  try { text = decodeAll(fs.readFileSync(f)) } catch (e) { continue }
  let used = false
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"usage"') === -1) continue
    let o
    try { o = JSON.parse(line) } catch (e) { continue }
    if (!o.time || o.time < rangeStart || o.time >= rangeEnd) continue
    if (o.type === 'turn/end') { agg.turns++; used = true; continue }
    if (o.type !== 'assistant/message') continue
    const d = o.data || {}
    const u = d.usage
    if (!u) continue
    const model = (d.message && d.message.source && d.message.source.model) || ''
    const input = Number(u.inputTokens) || 0
    const cache = Number(u.cacheReadTokens) || 0
    const output = Number(u.outputTokens) || 0
    const reason = Number(u.reasoningTokens) || 0
    const p = priceFor(model)
    const peak = isPeak(o.time)
    const off = peak ? 1 : 0
    const c = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
    agg.input += input; agg.cache += cache; agg.output += output; agg.reason += reason
    agg.cost += c; agg.msgs++
    if (peak) { agg.costPeak += c; agg.peakMsgs++ } else agg.costOff += c
    const key = model || '(unknown)'
    agg.byModel[key] = (agg.byModel[key] || 0) + c
    used = true
  }
  if (used) agg.sessions++
}

console.log('date:', targetKey)
console.log('events(assistant/message):', agg.msgs, '| turns(turn/end):', agg.turns, '| peak events:', agg.peakMsgs, '| sessions:', agg.sessions)
console.log('tokens  input=%d cache=%d output=%d reason=%d (显示用 tokens=%d)', agg.input, agg.cache, agg.output, agg.reason, agg.input + agg.output)
console.log('cost  total=¥%s  (off-peak ¥%s + peak ¥%s)', agg.cost.toFixed(4), agg.costOff.toFixed(4), agg.costPeak.toFixed(4))
console.log('by model:', JSON.stringify(Object.fromEntries(Object.entries(agg.byModel).map(([k, v]) => [k, Number(v.toFixed(4))]))))

let day = null
try { day = JSON.parse(fs.readFileSync(DAILY, 'utf8')) } catch (e) {}
if (day && day.date === targetKey) {
  console.log('--- stored buckets vs recomputed（今日）---')
  console.log('stored  input=%d cache=%d output=%d reason=%d cost=%s', day.tokens.input, day.tokens.cache, day.tokens.output, day.tokens.reason, day.cost)
  console.log('delta   input=%d cache=%d output=%d reason=%d', agg.input - day.tokens.input, agg.cache - day.tokens.cache, agg.output - day.tokens.output, agg.reason - day.tokens.reason)
}

if (argv.includes('--write')) {
  if (!day) { console.error('FAIL: daily file unreadable'); process.exit(1) }
  if (day.date === targetKey && !argv.includes('--force-today')) {
    console.error('SKIP: 目标是今天（已清零或正常累计）；如需覆盖请加 --force-today')
    process.exit(2)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = path.join(path.dirname(DAILY), `.dshb-daily.bak-${stamp}.json`)
  fs.writeFileSync(backup, fs.readFileSync(DAILY))
  day.history = day.history || {}
  const prev = day.history[targetKey] || {}
  day.history[targetKey] = {
    // 会话日志中的 turn/end 无独立时间戳（不在时间窗内），无法重算轮数 → 回退旧值
    turns: agg.turns || prev.turns || 0,
    cost: Number(agg.cost.toFixed(6)),
    tokens: agg.input + agg.output, // 非缓存口径（旧值含缓存，已修正）
    cacheTokens: agg.cache,
    costMethod: 'session-logs-official-2026-08-17',
    prevCost: typeof prev.cost === 'number' ? prev.cost : null,
    prevTokens: typeof prev.tokens === 'number' ? prev.tokens : null,
  }
  fs.writeFileSync(DAILY, JSON.stringify(day), 'utf8')
  console.log('WRITTEN history[' + targetKey + '] =', JSON.stringify(day.history[targetKey]))
  console.log('backup:', backup)
}

