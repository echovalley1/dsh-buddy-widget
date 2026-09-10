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

const today = new Date()
const pad = (n) => String(n).padStart(2, '0')
const todayKey = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate())
const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()

const agg = { input: 0, cache: 0, output: 0, reason: 0, cost: 0, costOff: 0, costPeak: 0, msgs: 0, peakMsgs: 0, sessions: 0, byModel: {} }
for (const f of walk(SESSIONS)) {
  let text
  try { text = decodeAll(fs.readFileSync(f)) } catch (e) { continue }
  let used = false
  for (const line of text.split('\n')) {
    if (!line || line.indexOf('"usage"') === -1) continue
    let o
    try { o = JSON.parse(line) } catch (e) { continue }
    if (o.type !== 'assistant/message') continue
    const d = o.data || {}
    const u = d.usage
    if (!u || !o.time || o.time < startOfToday) continue
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

console.log('today:', todayKey)
console.log('events(assistant/message) included:', agg.msgs, '| peak events:', agg.peakMsgs, '| sessions:', agg.sessions)
console.log('tokens  input=%d cache=%d output=%d reason=%d', agg.input, agg.cache, agg.output, agg.reason)
console.log('cost  total=¥%s  (off-peak ¥%s + peak ¥%s)', agg.cost.toFixed(4), agg.costOff.toFixed(4), agg.costPeak.toFixed(4))
console.log('by model:', JSON.stringify(Object.fromEntries(Object.entries(agg.byModel).map(([k, v]) => [k, Number(v.toFixed(4))]))))

// 对照现有分桶（验证覆盖率）
let day = null
try { day = JSON.parse(fs.readFileSync(DAILY, 'utf8')) } catch (e) {}
if (day && day.date === todayKey) {
  console.log('--- stored buckets vs recomputed ---')
  console.log('stored  input=%d cache=%d output=%d reason=%d cost=%s', day.tokens.input, day.tokens.cache, day.tokens.output, day.tokens.reason, day.cost)
  console.log('delta   input=%d cache=%d output=%d reason=%d', agg.input - day.tokens.input, agg.cache - day.tokens.cache, agg.output - day.tokens.output, agg.reason - day.tokens.reason)
}
if (process.argv.includes('--write') && day && day.date === todayKey) {
  fs.writeFileSync(DAILY, JSON.stringify({
    ...day,
    cost: Number(agg.cost.toFixed(6)),
    costRecomputedAt: new Date().toISOString(),
    costMethod: 'recomputed-from-session-logs-official-2026-08-17-pricing',
    costOffPeak: Number(agg.costOff.toFixed(6)),
    costPeak: Number(agg.costPeak.toFixed(6)),
  }), 'utf8')
  console.log('WRITTEN:', DAILY)
}
