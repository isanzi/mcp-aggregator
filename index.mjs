#!/usr/bin/env node
// MCP aggregator: exposes ONE tiny tool surface over many downstream MCP servers.
// Downstream tool schemas never enter the model context; the model pulls a compact
// catalog on demand and calls tools by name.
import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { deriveOpTable, opTableText, opRowText, opKeyOf, paramDocsFor, flattenUnion } from './op-table.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CFG = JSON.parse(readFileSync(process.env.AGG_CONFIG || join(HERE, 'servers.json'), 'utf8'))
const STARTED_AT = Date.now()
const DESC_WIDTH = CFG.descWidth ?? 150   // catalog 一行上限：摘要按功能多少浮动，最长 150 字符
// hub "load": index + on-demand FULL declarations. Folding stays; you pay only for what you load.
const HUB = CFG.hub ?? {}
const HUB_NAME = String(HUB.name ?? 'load')
const HUB_LINE = Number(HUB.lineWidth ?? 96)
const HUB_INDEX_BUDGET = Number(HUB.indexBudgetBytes ?? 6000)
const HUB_FULL_BUDGET = Number(HUB.fullBudgetBytes ?? 12288)
// 首调投递（hub.firstCallDecl，默认 full）：本会话没 describe 过这个工具/op 时，call 照常派发，
// 并在 content 末尾带回「本该由 describe 返回的全部内容」——同一个 describeText 产出，不另写一套，就不会漂移。
//   full=与 describe 同构 · brief=判据块+必填+按 op 参数表+指针 · off=关闭
// 单次投递超 hub.firstCallDeclBudgetBytes（默认 4096）时自动降为 brief 形态（全库 describe 实测
// p95 2,353 B、max 6,760 B ⇒ 只有 2 个工具会走到降级分支，见 evidence.md §⑧），
// 绝不把 16–47 KB 的 schema 带进上下文（jlceda-native 有 47 KB 的单件 schema）。
const FIRST_DECL = String(HUB.firstCallDecl ?? (HUB.describeNudge === false ? 'off' : 'full')).toLowerCase()
const FIRST_DECL_ON = FIRST_DECL === 'full' || FIRST_DECL === 'brief'
const FIRST_DECL_BUDGET = Number(HUB.firstCallDeclBudgetBytes ?? 4096)
const FIRST_DECL_BATCH_BUDGET = Number(HUB.firstCallDeclBatchBytes ?? 8192)
// 严格流程（hub.strictFlow，默认关）：模型必须按 catalog → describe → call 走，
// 每个工具每会话先 describe 过一次才允许 call。为 false 时保持旧的「建议性」流程。
const STRICT_FLOW = HUB.strictFlow === true
// 判据块（hub.notes / notesFile）：use 何时用 · alt 别用改用谁 · bounds 硬边界 · trap 坑
// 精选摘要（hub.summary）：catalog 只显示 84 字符，描述被截的工具用这条 ≤84 字的手写摘要代替
// 别名（hub.alias）：中文/别名关键词 → 工具引用，补 catalog 关键词检索的召回
const NOTES = (function () {
  let n = HUB.notes
  if (HUB.notesFile) { try { const j = JSON.parse(readFileSync(join(HERE, String(HUB.notesFile)), 'utf8')); n = j.notes ?? j } catch (e) { log('hub.notesFile load failed: ' + String(e?.message ?? e)) } }
  return (n && typeof n === 'object') ? n : {}
})()
const SUMMARY = (function () {
  let s = (HUB.summary && typeof HUB.summary === 'object') ? HUB.summary : {}
  if (HUB.summaryFile) {
    try { const j = JSON.parse(readFileSync(join(HERE, String(HUB.summaryFile)), 'utf8')); s = { ...s, ...(j.summary ?? j) } } catch (e) { log('hub.summaryFile load failed: ' + String(e?.message ?? e)) }   // 文件优先，内联 summary 只作兜底
  }
  return s
})()
// 章节化说明书：hub.manualsFile = { "server.tool": { overview:{title,tags,body}, "op:wire":{…}, pitfalls:{…} } }
const MANUALS = (function () {
  if (!HUB.manualsFile) return {}
  try {
    const j = JSON.parse(readFileSync(join(HERE, String(HUB.manualsFile)), 'utf8'))
    const man = (j.manuals ?? j) || {}
    for (const t of Object.values(man)) for (const sec of Object.values(t || {})) {
      if (typeof sec?.tags === 'string') sec.tags = sec.tags.split(',').map((x) => x.trim()).filter(Boolean)   // 容错：tags 允许写成逗号串
    }
    return man
  } catch (e) { log('hub.manualsFile load failed: ' + String(e?.message ?? e)); return {} }
})()
const CATALOG_BUDGET = Number(HUB.catalogBudgetBytes ?? 6000)
const ALIAS = (HUB.alias && typeof HUB.alias === 'object') ? HUB.alias : {}
// 每 op 参数表（hub.opTable）：把多 op 工具的 schema 拆成每 op 的必填/可选。
// sidecar 文件（hub.opTableFile，{ "server.tool": {opKey, ops:{<op>:{required,optional,weak}}} }）
// 是人工权威口径；派生结果只作缺省。off 时退回旧行为（只给整份 schema）。
const OP_TABLE_MODE = String(HUB.opTable ?? 'on').toLowerCase()
const OP_TABLE_ON = OP_TABLE_MODE !== 'off'
const OP_SIDECAR = (function () {
  if (!HUB.opTableFile) return {}
  try {
    const j = JSON.parse(readFileSync(join(HERE, String(HUB.opTableFile)), 'utf8'))
    return (j.ops ?? j) || {}
  } catch (e) { log('hub.opTableFile load failed: ' + String(e?.message ?? e)); return {} }
})()
// 无 op 维度工具的参数说明（sidecar 里的 paramDocs 段）：只补说明，不参与预检
const PARAM_DOCS = (function () {
  if (!HUB.opTableFile) return {}
  try {
    const j = JSON.parse(readFileSync(join(HERE, String(HUB.opTableFile)), 'utf8'))
    return (j.paramDocs && typeof j.paramDocs === 'object') ? j.paramDocs : {}
  } catch (e) { return {} }
})()
const OP_CACHE = new WeakMap()
const opTableOf = function (e) {
  if (!OP_TABLE_ON) return null
  if (OP_CACHE.has(e)) return OP_CACHE.get(e)
  let t = null
  try {
    const ref = e.server + '.' + e.tool
    t = deriveOpTable(e.schema ?? {}, OP_SIDECAR[ref])
    // 参数说明覆盖（sidecar paramDocs）：给下游没写 description 的第三方工具补用法
    const extraDocs = PARAM_DOCS[ref]
    if (t && extraDocs) t.paramDocs = { ...(t.paramDocs ?? {}), ...extraDocs }
    if (t && t.warnings.length) log('op-table warn', e.server + '.' + e.tool, t.warnings.join(' | '))
  } catch (err) { log('op-table derive failed', e.server + '.' + e.tool, String(err?.message ?? err)) }
  OP_CACHE.set(e, t)
  return t
}
// 当前调用实际选的 op（参数里的 op/action/…）；没有 op 维度时返回 null
const opOfArgs = function (e, args) {
  const key = opKeyOf(e.schema)
  if (!key) return null
  const v = args && typeof args === 'object' ? args[key] : undefined
  return typeof v === 'string' && v ? v : null
}
const noteBlock = function (e) {
  const n = NOTES[e.server + '.' + e.tool]
  if (!n) return ''
  if (typeof n === 'string') return '[判据] ' + e.server + '.' + e.tool + '\n  ' + n
  const L = ['[判据] ' + e.server + '.' + e.tool]
  if (n.use) L.push('  何时用: ' + n.use)
  if (n.alt) L.push('  别用/改用: ' + n.alt)
  if (n.bounds) L.push('  硬边界: ' + n.bounds)
  if (n.trap) L.push('  坑: ' + n.trap)
  return L.join('\n')
}
const sel = function (e) { return SUMMARY[e.server + '.' + e.tool] }
const displayDesc = function (e) {
  const s = sel(e)
  if (s && typeof s === 'object') return (s.fn ? s.fn : '') + (s.when ? ' ｜用法: ' + s.when : '')
  return String(s ?? e.description ?? '')
}
// 必带段：与投递形态无关，永远给（最便宜、最值钱：参数对不对全靠这几行）
// 结果形状提示（每工具每会话一次，随 ① 必带段下发）：MCP 结果不是字符串，是 content 块数组
const SHAPE_HINT = '[结果形状] 返回 {content:[{type:"text",text}|{type:"image",data}]}：文本用 content.map(c=>c.text).join("")；'
  + '别用 String()（静默得 15 字符 "[object Object]"）；图片块无 .text，join 会丢，按 type 判。';

// 2026-11-15 修（condreq）：allOf(if/then) 条件必填 —— op 驱动的必填参数（如 lceda_probe 的 signature→expr）
// 背景：schema 写 required:[] + 参数描述里写「op=signature 必填」⇒ 摘要行渲染成 (无)，调用方只能猜参数名
// 实测代价：10 个只读任务里 1 个（lceda_probe）因猜 methodName 被预检拦下，多花一次往返
const condReqPairs = function (sch) {
  const out = []
  const all = (sch && Array.isArray(sch.allOf)) ? sch.allOf : []
  for (const it of all) {
    const cond = it && it.if && it.if.properties
    const then = (it && it.then && Array.isArray(it.then.required)) ? it.then.required : null
    if (!cond || !then || !then.length) continue
    const keys = Object.keys(cond)
    if (keys.length !== 1) continue
    const k = keys[0], spec = cond[k] ?? {}
    const vals = spec.const !== undefined ? [spec.const] : (Array.isArray(spec.enum) ? spec.enum : null)
    if (!vals) continue
    out.push({ key: k, vals: vals, req: then })
  }
  return out
}
const condReqFor = function (sch, args) {
  const res = []
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : null
  if (!a) return res
  for (const c of condReqPairs(sch)) {
    if (Object.prototype.hasOwnProperty.call(a, c.key) && c.vals.includes(a[c.key])) for (const x of c.req) if (!res.includes(x)) res.push(x)
  }
  return res
}
const condReqHint = function (sch) {
  const pairs = condReqPairs(sch)
  if (!pairs.length) return ''
  return pairs.map(function (c) { return c.vals.map(function (v) { return v + '→' + c.req.join('+') }).join(' / ') }).join('；')
}
const basicDecl = function (e, args) {
  const sch = e.schema ?? {}
  const props = sch.properties ?? {}
  const base = (Array.isArray(sch.required) ? sch.required : []).filter((k) => !(props[k] && Object.prototype.hasOwnProperty.call(props[k], 'default')))
  const req = base.concat(condReqFor(sch, args).filter((k) => !base.includes(k)))
  const hint = condReqHint(sch)
  const anyOfHint = (Array.isArray(sch.__anyOfReq) && sch.__anyOfReq.length)
    ? '至少满足一组: ' + sch.__anyOfReq.map((g) => '(' + g.join('+') + ')').join(' 或 ')
    : ''
  const reqTxt = req.length
    ? (req.join(', ') + (hint ? '（条件必填 ' + hint + '）' : '') + (anyOfHint ? '（另需 ' + anyOfHint + '）' : ''))
    : ((hint || anyOfHint) ? '(无条件必填；' + [hint ? '条件必填 ' + hint : '', anyOfHint].filter(Boolean).join('；') + ')' : '(无)')
  const parts = ['[必填] ' + e.server + '.' + e.tool + ' → ' + reqTxt, SHAPE_HINT]
  const enumLines = []
  for (const k of Object.keys(props).slice(0, 12)) {
    const pr = props[k] ?? {}
    if (pr.enum) enumLines.push(k + '=' + pr.enum.join('/'))
    else if (/\bmil\b|inch|mm|px|单位/.test(String(pr.description ?? ''))) enumLines.push(k + '(' + clip(flat(pr.description), 46) + ')')
  }
  if (enumLines.length) parts.push('  ' + enumLines.join(' · '))
  return clip(parts.join('\n'), 780)
}
// 参数块（替掉整份 JSON schema）：每个顶层参数一行，带类型/必填/枚举/默认/说明，嵌套对象展开一层键名。
// 原始 schema 不再随 describe 下发 —— 只留 describe({tool:"srv.tool#schema"}) 一个入口。
const typeBits = function (p) {
  if (!p || typeof p !== 'object') return '?'
  // zod 的条件约束序列化成 allOf:[{type,description},{type,const}] / allOf:[{}, {oneOf:[…}]]
  // ⇒ 顶层常常没 type，往 allOf 里找第一个带类型线索的项
  if (!p.type && Array.isArray(p.allOf)) {
    const hit = p.allOf.find((x) => x && typeof x === 'object' && (x.type || x.enum || x.properties || x.oneOf || x.anyOf))
    if (hit) p = { ...hit, description: p.description ?? hit.description, default: p.default ?? hit.default }
  }
  const t = p.type ?? (p.oneOf ? 'oneOf' : (p.anyOf ? 'anyOf' : (p.properties ? 'object' : '?')))
  const bits = [t]
  if (Array.isArray(p.enum) && p.enum.length) bits.push('∈' + p.enum.slice(0, 12).join('|') + (p.enum.length > 12 ? '…' : ''))
  if (p.items && typeof p.items === 'object') bits.push('<' + typeBits(p.items) + '>')
  if (p.oneOf || p.anyOf) bits.push('(' + (p.oneOf || p.anyOf).length + ' 分支)')
  if (p.properties) {
    const ks = Object.keys(p.properties)
    bits.push('{' + ks.slice(0, 10).join(',') + (ks.length > 10 ? ',…' : '') + '}')
  }
  return bits.join(' ')
}
const paramBlock = function (e, cap) {
  const sch = e.schema ?? {}
  const props = sch.properties ?? {}
  const keys = Object.keys(props)
  const tail = sch.additionalProperties === false ? '（不接受未知参数）' : ''
  if (!keys.length) return '[参数] 无参数' + tail
  const req = new Set(Array.isArray(sch.required) ? sch.required : [])
  const lines = keys.map(function (k) {
    const p = props[k] ?? {}
    const bits = []
    if (req.has(k)) bits.push('必填')
    if (p.default !== undefined) bits.push('默认 ' + JSON.stringify(p.default))
    const d = p.description ? ': ' + clip(flat(p.description), 70) : ''
    return '  - ' + k + ' (' + typeBits(p) + (bits.length ? ', ' + bits.join(', ') : '') + ')' + d
  })
  const anyOf = Array.isArray(sch.__anyOfReq) && sch.__anyOfReq.length
    ? '\n[分支必填] 至少满足一组: ' + sch.__anyOfReq.map((g) => '(' + g.join('+') + ')').join(' 或 ')
    : ''
  const head = '[参数] 共 ' + keys.length + ' 个' + tail + anyOf
  const limit = Math.max(600, Number(cap) || Number(HUB.paramBlockBudgetBytes ?? 3000))
  const body = [head, ...lines].join('\n')
  if (Buffer.byteLength(body) <= limit) return body
  return head + '\n  ' + keys.join(', ') + '\n  （参数说明超预算已省略：要完整类型/默认值 → describe({tool:"'
    + e.server + '.' + e.tool + '#schema"})）'
}

// 首调投递的降级形态（判据块 + 必填 + 按 op 参数表 + 指针）：预算在这里是**硬上限**，
// 顺序是「先丢按 op 参数表 → 再裁正文」，describe 指针永远保留（它是取全文的唯一口子）。
const shortDecl = function (e, maxBytes) {
  const cap = Math.max(400, Number(maxBytes) || FIRST_DECL_BUDGET)
  const ptr = '完整 schema: describe({tool:"' + e.server + '.' + e.tool + '"})'
  const head = [noteBlock(e), basicDecl(e)].filter(Boolean).join('\n\n')
  const t = opTableOf(e)
  const tbl = t ? opTableText(e.server + '.' + e.tool, e.schema ?? {}, t) : ''
  const withTbl = [head, tbl, ptr].filter(Boolean).join('\n\n')
  if (Buffer.byteLength(withTbl) <= cap) return withTbl
  const noTbl = [head, ptr].filter(Boolean).join('\n\n')
  if (Buffer.byteLength(noTbl) <= cap) return noTbl
  return clipBytes(head, Math.max(120, cap - Buffer.byteLength(ptr) - 2)) + '\n\n' + ptr
}

const collectScrub = function (v, out, depth) {
  if (depth > 4 || v === null || v === undefined) return out
  if (typeof v === 'string') { if (v.length <= 60) out.push(v.toLowerCase()); return out }
  if (typeof v === 'number' || typeof v === 'boolean') { out.push(String(v).toLowerCase()); return out }
  if (Array.isArray(v)) { for (const x of v.slice(0, 40)) collectScrub(x, out, depth + 1); return out }
  if (typeof v === 'object') { for (const k of Object.keys(v).slice(0, 20)) collectScrub(v[k], out, depth + 1) }
  return out
}
const sectionText = function (e, id) {
  const man = MANUALS[e.server + '.' + e.tool]
  const s = man?.[id]
  if (!s) return ''
  return '[手册·' + (s.title || id) + '] ' + e.server + '.' + e.tool + '#' + id + '\n' + String(s.body || '').trim()
}
const sectionIndex = function (e) {
  const man = MANUALS[e.server + '.' + e.tool]
  if (!man) return ''
  return '[手册章节] ' + Object.keys(man).map((id) => id + '（' + (man[id].title || '') + '）').join(' · ') + ' —— describe({tool:"' + e.server + '.' + e.tool + '#<id>"}) 取单章'
}
// describe 直接带上章节正文（总 ≤1600 B 时），模型不必再取单章。
// 但手册正文差异极大（平均 870 B，lceda_batch 9 章 5457 B），所以按体积分档：
//   hub.descSections = "auto"（默认）| "all" | "off"
//   auto：整份正文 ≤ hub.descSectionBudgetBytes（默认 1600 B）才内联，超了退回索引；
//         显式 #op:xxx 的窄分支本来就直接给那一章，不受此限。
const DESC_SECTIONS = String(HUB.descSections ?? 'auto').toLowerCase()
const DESC_SECTION_BUDGET = Number(HUB.descSectionBudgetBytes ?? 1600)
// 返回 { text, ids }：ids 是这次真正下发过正文的章节，供去重桶跳过
const inlineSections = function (e) {
  const man = MANUALS[e.server + '.' + e.tool]
  if (!man || DESC_SECTIONS === 'off') return { text: '', ids: [] }
  const ids = Object.keys(man)
  const bodies = ids.map((id) => ({ id, t: sectionText(e, id) })).filter((x) => x.t)
  if (!bodies.length) return { text: '', ids: [] }
  const total = bodies.reduce((n, x) => n + Buffer.byteLength(x.t) + 2, 0)
  if (DESC_SECTIONS !== 'all' && total > DESC_SECTION_BUDGET) return { text: '', ids: [] }
  return { text: bodies.map((x) => x.t).join('\n\n'), ids }
}
// preflight: 参数预检（缺必填/未知键/enum 越界 → 不派发）。hub.preflight:false 可整体关掉。
const PREFLIGHT = HUB.preflight !== false
const CALL_TIMEOUT_MS = CFG.callTimeoutMs ?? 240000
const CONNECT_TIMEOUT_MS = CFG.connectTimeoutMs ?? 90000
const RETRY = CFG.retry ?? {}
const RETRY_ENABLED = RETRY.enabled !== false
const RETRY_INITIAL_MS = Math.max(100, Number(RETRY.initialMs ?? 1000))
const RETRY_MAX_MS = Math.max(RETRY_INITIAL_MS, Number(RETRY.maxMs ?? 60000))
const RETRY_JITTER = Math.min(0.5, Math.max(0, Number(RETRY.jitter ?? 0.2)))
const LAZY_IDLE_MS = Math.max(1000, Number(CFG.lazyIdleMs ?? 1800000))
const SLOW_CALL_MS = Math.max(1, Number(CFG.slowCallMs ?? 5000))
const AUTH = CFG.auth ?? {}
const AUTH_ENABLED = AUTH.enabled === true
const AUTH_HEALTH_REQUIRED = AUTH.healthRequiresAuth !== false
const CATALOG_CACHE_FILE = (() => {
  const raw = String(CFG.catalogCacheFile ?? join(HERE, 'catalog-cache.json'))
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
})()
// Fast path: how long a call waits for catalogs BEFORE it knows its server.
// The remaining window is only paid when the tool is still unknown (cold start).
const PRE_RESOLVE_WAIT_MS = Number(CFG.preResolveWaitMs ?? 3000)
const MAX_BATCH_CALLS = Number(CFG.maxBatchCalls ?? 64)
const MAX_BODY_BYTES = Number(CFG.maxBodyBytes ?? 16 * 1024 * 1024)

const conns = new Map()
const reconnectInFlight = new Map()   // per-server: one reconnect at a time (see ensureAlive)
const log = (...a) => process.stderr.write('[mcp-agg] ' + a.join(' ') + '\n')

function expand(value) {
  return String(value).replace(/\$\{(env|file):([^}]+)\}/g, (_m, kind, key) => {
    if (kind === 'env') return process.env[key] ?? ''
    const p = key.startsWith('~') ? join(homedir(), key.slice(1)) : key
    try { return readFileSync(p, 'utf8').trim() } catch { return '' }
  })
}

const AUTH_TOKEN = expand(AUTH.token ?? '').trim()
if (AUTH_ENABLED && !AUTH_TOKEN) {
  throw new Error('aggregator auth is enabled but auth.token did not resolve to a non-empty value')
}

function authorized(req) {
  if (!AUTH_ENABLED) return true
  const header = String(req.headers.authorization ?? '')
  if (!header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(AUTH_TOKEN)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

const CATALOG_CACHE = (() => {
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_CACHE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, servers: {} }
  } catch {
    return { version: 1, servers: {} }
  }
})()
// ── 2026-11-11 L3：catalog-cache 缺 server 时从最近备份兜底 ───────────────────
// 背景：2026-11-11 发现 catalog-cache.json 被写成只剩 12 家（354 KB vs 备份 1.3 MB），
// 118 个工具（chrome-devtools 32 / playwright 25 / lceda-cli 3 / jlceda-native 58）的目录
// 静默消失，selftest C1/L10 因此转红。persistCatalog 是合并式、不会删别家，故非正常代码路径；
// 但一旦发生，服务只会安静地少服务几家。这里在启动时比对 CFG.servers 与 cache.servers，
// 缺失的从最近的 catalog-cache.json.bak-* 补回并 WARN；只补不删、不改已有条目。
// 注意：用具名函数 + 调用，不用 IIFE —— 上一版 IIFE 紧跟 `})()` 触发 ASI 陷阱
// （TypeError: (intermediate value)(...) is not a function，2026-11-11 实测踩过一次）。
function restoreMissingCatalogFromBackups() {
  const want = (CFG.servers ?? []).map((s) => s.name)
  const have = new Set(Object.keys(CATALOG_CACHE.servers ?? {}))
  const missing = want.filter((n) => !have.has(n))
  if (!missing.length) return
  CATALOG_CACHE.servers ??= {}
  const backups = []
  try {
    for (const f of readdirSync(HERE)) {
      if (!f.startsWith('catalog-cache.json.bak')) continue
      const p = join(HERE, f)
      try { backups.push({ p, mtime: statSync(p).mtimeMs }) } catch {}
    }
    backups.sort((a, b) => b.mtime - a.mtime)
  } catch {}
  const restored = []
  for (const name of missing) {
    for (const b of backups) {
      try {
        const row = JSON.parse(readFileSync(b.p, 'utf8'))?.servers?.[name]
        if (row && Array.isArray(row.tools) && row.tools.length) {
          CATALOG_CACHE.servers[name] = row
          restored.push(name + ':' + row.tools.length)
          break
        }
      } catch {}
    }
  }
  if (restored.length) {
    try {
      const tmp = CATALOG_CACHE_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(CATALOG_CACHE, null, 2), { mode: 0o600 })
      renameSync(tmp, CATALOG_CACHE_FILE)
    } catch (e) { log('catalog cache restore: rewrite failed: ' + e.message) }
  }
  const still = missing.filter((n) => !restored.some((r) => r.split(':')[0] === n))
  log('WARN catalog-cache 缺 ' + missing.length + ' 家 [' + missing.join(',') + '] restored=[' +
      (restored.join(',') || 'none') + ']' + (still.length ? ' still-missing=[' + still.join(',') + ']' : ''))
}
restoreMissingCatalogFromBackups()

let cacheWriteInFlight = false
let cacheWriteAgain = false

const CACHE_SERVED = new Set()   // 该 server 的声明本次进程内仍来自 catalog-cache（可能过期）
function cachedTools(name) {
  CACHE_SERVED.add(name)
  const rows = CATALOG_CACHE.servers?.[name]?.tools
  return Array.isArray(rows) ? rows : []
}

function persistCatalog(entry) {
  CACHE_SERVED.delete(entry.name)
  if (!entry.catalog.size) return
  CATALOG_CACHE.version = 1
  CATALOG_CACHE.servers ??= {}
  CATALOG_CACHE.servers[entry.name] = {
    savedAt: new Date().toISOString(),
    tools: [...entry.catalog.values()].map((e) => ({
      name: e.tool,
      description: e.description,
      inputSchema: e.rawSchema ?? e.schema,
    })),
  }
  if (cacheWriteInFlight) {
    cacheWriteAgain = true
    return
  }
  cacheWriteInFlight = true
  queueMicrotask(() => {
    try {
      mkdirSync(dirname(CATALOG_CACHE_FILE), { recursive: true })
      const tmp = CATALOG_CACHE_FILE + '.tmp-' + process.pid
      writeFileSync(tmp, JSON.stringify(CATALOG_CACHE, null, 2), { mode: 0o600 })
      renameSync(tmp, CATALOG_CACHE_FILE)
    } catch (err) {
      log('catalog cache write failed:', String(err?.message ?? err))
    } finally {
      cacheWriteInFlight = false
      if (cacheWriteAgain) {
        cacheWriteAgain = false
        persistCatalog(entry)
      }
    }
  })
}

function hydrateCatalog(entry) {
  const rows = cachedTools(entry.name)
  if (!rows.length) return 0
  setCatalog(entry, rows, { fromCache: true })
  return rows.length
}

function withTimeout(p, ms, label) {
  let timer
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout: ' + label)), ms) })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

function clearRetryTimer(entry) {
  if (entry.retryTimer) clearTimeout(entry.retryTimer)
  entry.retryTimer = null
  entry.nextRetryAt = null
}

function retryDelay(attempt) {
  const raw = Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * (2 ** Math.max(0, attempt - 1)))
  const spread = raw * RETRY_JITTER
  return Math.max(100, Math.round(raw - spread + Math.random() * spread * 2))
}

function scheduleRetry(entry) {
  if (!RETRY_ENABLED || conns.get(entry.name) !== entry) {
    entry.status = 'unavailable'
    return
  }
  clearRetryTimer(entry)
  const delay = retryDelay(entry.attempts)
  entry.status = 'backoff'
  entry.nextRetryAt = Date.now() + delay
  log('retry scheduled', entry.name, 'attempt=' + (entry.attempts + 1), 'in=' + delay + 'ms')
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null
    if (conns.get(entry.name) !== entry) return
    startConnect(entry)
  }, delay)
  entry.retryTimer.unref?.()
}

function startConnect(entry) {
  if (entry.status === 'starting' && entry.ready) return entry.ready
  clearRetryTimer(entry)
  entry.status = 'starting'
  entry.error = null
  entry.connected = false
  let client = null
  entry.ready = (async () => {
    const { name, spec } = entry
    let transport
    if (spec.url) {
      const headers = {}
      for (const [k, v] of Object.entries(spec.headers ?? {})) {
        const expanded = expand(v)
        if (!/^Bearer\s*$/.test(expanded) && expanded !== '') headers[k] = expanded
      }
      transport = new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers } })
    } else {
      transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        env: { ...process.env, ...(spec.env ?? {}) },
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        stderr: 'inherit',
      })
    }
    // `listChanged` makes the snapshot LIVE: when a downstream announces
    // notifications/tools/list_changed (konnect's load_toolset does exactly that), the SDK
    // re-lists and hands us the fresh array. Without it the snapshot freezes at connect time
    // and the aggregator answers "Unknown tool" for tools that genuinely exist.
    // Only this cache changes: the model-facing surface stays the same 4 tools.
    client = new Client({ name: 'mcp-aggregator', version: '1.0.0' }, {
      capabilities: {},
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (error) return log('catalog live-update failed', name, '->', String(error?.message ?? error))
            if (!Array.isArray(tools)) return
            setCatalog(entry, tools)
            log('catalog live-updated', name, 'tools=' + entry.catalog.size)
          },
        },
      },
    })
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, name + ' connect')
    entry.client = client
    const listed = await listAll(client, 'listTools', 'tools', CONNECT_TIMEOUT_MS, name + ' tools/list')
    if (conns.get(name) !== entry) {
      Promise.resolve(client.close()).catch(() => {})
      return
    }
    setCatalog(entry, listed.tools)
    entry.connected = true
    entry.status = 'ready'
    entry.attempts = 0
    entry.error = null
    entry.nextRetryAt = null
    entry.catalogFromCache = false
    entry.lastUsedAt = Date.now()
    persistCatalog(entry)
    log('connected', name, 'tools=' + entry.catalog.size)
  })().catch((err) => {
    entry.error = String(err?.message ?? err)
    entry.connected = false
    entry.client = null
    entry.attempts += 1
    log('connect failed', entry.name, 'attempt=' + entry.attempts, '->', entry.error)
    Promise.resolve(client?.close()).catch(() => {})
    scheduleRetry(entry)
  })
  return entry
}

function connect(name, spec) {
  let entry = conns.get(name)
  if (entry) return entry
  entry = {
    name,
    spec,
    client: null,
    catalog: new Map(),
    error: null,
    ready: null,
    connected: false,
    status: 'idle',
    attempts: 0,
    retryTimer: null,
    nextRetryAt: null,
    catalogFromCache: false,
    lastUsedAt: null,
    activeCalls: 0,
    retiredClients: [],
  }
  conns.set(name, entry)
  hydrateCatalog(entry)
  const mode = String(spec.startup ?? 'eager').toLowerCase()
  if (mode === 'lazy') {
    entry.status = 'cold'
    entry.ready = Promise.resolve()
  } else {
    startConnect(entry)
  }
  return entry
}

for (const s of CFG.servers ?? []) connect(s.name, s)

async function waitAll(ms) {
  const pending = [...conns.values()].map((c) => c.ready)
  let timer
  const stop = new Promise((r) => { timer = setTimeout(r, ms) })
  try { await Promise.race([Promise.all(pending), stop]) } finally { clearTimeout(timer) }
  return [...conns.values()]
}

function unavailableServerError(c) {
  const retry = c.nextRetryAt ? ', retrying in ' + Math.max(0, Math.ceil((c.nextRetryAt - Date.now()) / 1000)) + 's' : ''
  return new Error('server "' + c.name + '" unavailable' + retry + ': ' + (c.error ?? c.status))
}

async function waitOne(name) {
  const c = conns.get(name)
  if (!c) throw new Error('unknown server "' + name + '"')
  if (c.status === 'backoff') {
    if (!c.nextRetryAt || Date.now() < c.nextRetryAt) throw unavailableServerError(c)
    startConnect(c)
  } else if (c.status === 'unavailable') {
    throw unavailableServerError(c)
  } else if (c.status === 'cold' || c.status === 'idle') {
    startConnect(c)
  }
  await c.ready
  if (c.error) throw unavailableServerError(c)
  c.lastUsedAt = Date.now()
  return c
}

// Inside an exclusive lane, never start a connection: a long connect timeout must not
// hold the server lock. The outer waitOne has already established readiness.
function readyOne(name) {
  const c = conns.get(name)
  if (!c) throw new Error('unknown server "' + name + '"')
  if (c.status !== 'ready' || !c.client || c.error) {
    throw new Error('server "' + name + '" became ' + c.status + ' while waiting for its exclusive lock')
  }
  return c
}

const retryText = function (c) {
  if (!c.nextRetryAt) return ''
  return 'retry in ' + Math.max(0, Math.ceil((c.nextRetryAt - Date.now()) / 1000)) + 's'
}

const allEntries = () => [...conns.values()].flatMap((c) => [...c.catalog.values()])
const sig = (schema) => {
  const props = schema?.properties ?? {}
  const req = new Set(schema?.required ?? [])
  const keys = Object.keys(props)
  const head = keys.filter((k) => req.has(k))
  const rest = keys.filter((k) => !req.has(k))
  const shown = head.concat(rest.slice(0, Math.max(0, 6 - head.length)))
  const parts = shown.map((k) => k + (req.has(k) ? '' : '?') + ':' + (props[k]?.type ?? (props[k]?.enum ? 'enum' : props[k]?.anyOf ? 'anyOf' : 'any')))
  const more = keys.length - shown.length
  return parts.join(', ') + (more > 0 ? ', +' + more : '')
}
const short = (t, w) => (t.length <= w ? t : t.slice(0, w - 1) + '…')
const norm = (s) => String(s).replace(/^mcp__/, '').replace(/\./g, '__')

// Tool discovery: rank against all curated metadata instead of only the downstream
// description. The cache is keyed by catalog entries, so list_changed refreshes naturally
// create fresh documents without a process-global rebuild step.
const SEARCH = HUB.search ?? {}
const SEARCH_SYNONYMS = (HUB.synonyms && typeof HUB.synonyms === 'object') ? HUB.synonyms : {}
const SEARCH_STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is',
  'it', 'no', 'of', 'on', 'or', 'please', 'such', 'the', 'to', 'tool', 'tools', 'use',
  'using', 'what', 'with',
  '帮我', '一下', '这个', '那个', '如何', '怎么', '可以',
])
const SEARCH_CACHE = new WeakMap()
const SEARCH_MIN_SCORE = Number(SEARCH.minScore ?? 4)

function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[_./:\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function addSearchTokens(text, out) {
  const normalized = normalizeSearchText(text)
  if (!normalized) return out
  for (const part of normalized.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []) {
    if (!part || SEARCH_STOP.has(part)) continue
    if (/^\p{Script=Han}+$/u.test(part)) {
      if (part.length === 1) out.add(part)
      else {
        out.add(part)
        for (let i = 0; i < part.length - 1; i++) out.add(part.slice(i, i + 2))
      }
    } else out.add(part)
  }
  return out
}

function searchTokens(text) {
  return addSearchTokens(text, new Set())
}

function searchDoc(e) {
  const cached = SEARCH_CACHE.get(e)
  if (cached) return cached
  const ref = e.server + '.' + e.tool
  const s = sel(e)
  const n = NOTES[ref]
  const man = MANUALS[ref]
  const schemaProps = Object.keys(e.schema?.properties ?? {}).join(' ')
  const nameText = normalizeSearchText(e.server + ' ' + e.tool)
  const summaryText = normalizeSearchText(
    s && typeof s === 'object' ? [s.fn, s.when, s.kw].filter(Boolean).join(' ') : String(s ?? ''),
  )
  const noteText = normalizeSearchText(collectScrub(n, [], 0).join(' '))
  const manualText = normalizeSearchText(collectScrub(man, [], 0).join(' '))
  const descText = normalizeSearchText(e.description ?? '')
  const schemaText = normalizeSearchText(schemaProps + ' ' + collectScrub(e.schema, [], 0).join(' '))
  const all = new Set()
  for (const text of [nameText, summaryText, noteText, manualText, descText, schemaText]) addSearchTokens(text, all)
  const doc = {
    ref,
    tool: normalizeSearchText(e.tool),
    nameText,
    summaryText,
    noteText,
    manualText,
    descText,
    schemaText,
    nameTokens: searchTokens(nameText),
    summaryTokens: searchTokens(summaryText),
    noteTokens: searchTokens(noteText),
    manualTokens: searchTokens(manualText),
    descTokens: searchTokens(descText),
    schemaTokens: searchTokens(schemaText),
    allTokens: all,
  }
  SEARCH_CACHE.set(e, doc)
  return doc
}

function queryInfo(query) {
  const normalized = normalizeSearchText(query)
  const tokens = searchTokens(query)
  const expanded = new Set()
  for (const [key, values] of Object.entries(SEARCH_SYNONYMS)) {
    const k = normalizeSearchText(key)
    if (!k || !normalized.includes(k)) continue
    for (const value of (Array.isArray(values) ? values : [values])) addSearchTokens(value, expanded)
  }
  for (const token of tokens) expanded.delete(token)
  return { normalized, tokens: [...tokens], expanded: [...expanded] }
}

const countMatches = (tokens, haystack) => tokens.reduce((n, token) => n + (haystack.has(token) ? 1 : 0), 0)
const ratio = (matched, total) => total ? matched / total : 0

function fieldSearchScore(tokens, haystack, weight) {
  return ratio(countMatches(tokens, haystack), tokens.length) * weight
}

function buildAliasBoosts(query, entries) {
  const q = normalizeSearchText(query)
  const boosts = new Map()
  for (const [key, refs] of Object.entries(ALIAS)) {
    // 2026-11-15：别名按「去空白」子串匹配 —— 实测「截 PCB 图」与「截PCB图」归一化后一个带空格一个不带，旧逻辑会漏召
    const k = normalizeSearchText(key).replace(/\s+/g, '')
    const qn = String(q ?? '').replace(/\s+/g, '')
    if (!k || !qn.includes(k) || !Array.isArray(refs)) continue
    refs.forEach((ref, index) => {
      const e = resolveTool(String(ref))
      if (!e || !entries.includes(e)) return
      const score = Math.max(boosts.get(e) ?? 0, 100000 + k.length * 1000 - index * 500)
      boosts.set(e, score)
    })
  }
  return boosts
}

function scoreSearchEntry(e, qi, aliasBoost) {
  const d = searchDoc(e)
  const { tokens, expanded, normalized } = qi
  const baseMatched = countMatches(tokens, d.allTokens)
  const expandedMatched = countMatches(expanded, d.allTokens)
  if (!baseMatched && !expandedMatched && !aliasBoost && d.ref !== normalized) return null

  let score = aliasBoost
  if (d.ref === normalized || norm(d.ref) === norm(normalized)) score += 2000
  if (d.nameText === normalized) score += 2000
  if (d.tool === normalized) score += 700
  score += fieldSearchScore(tokens, d.nameTokens, 150)
  score += fieldSearchScore(tokens, d.summaryTokens, 80)
  score += fieldSearchScore(tokens, d.noteTokens, 55)
  score += fieldSearchScore(tokens, d.manualTokens, 35)
  score += fieldSearchScore(tokens, d.descTokens, 35)
  score += fieldSearchScore(tokens, d.schemaTokens, 15)
  score += ratio(baseMatched, tokens.length) * 35
  if (tokens.length && baseMatched === tokens.length) score += 25
  score += ratio(expandedMatched, expanded.length) * 18

  if (normalized && normalized.length >= 2) {
    if (d.nameText.includes(normalized)) score += 120
    if (d.summaryText.includes(normalized)) score += 70
    if (d.noteText.includes(normalized)) score += 45
    if (d.descText.includes(normalized)) score += 30
  }
  return score >= SEARCH_MIN_SCORE ? score : null
}

function searchEntries(query, entries) {
  const qi = queryInfo(query)
  if (!qi.tokens.length && !qi.expanded.length) return []
  const aliasBoosts = buildAliasBoosts(query, entries)
  const scored = []
  for (const e of entries) {
    const score = scoreSearchEntry(e, qi, aliasBoosts.get(e) ?? 0)
    if (score !== null) scored.push({ e, score })
  }
  scored.sort((a, b) => b.score - a.score
    || String(a.e.server + '.' + a.e.tool).localeCompare(String(b.e.server + '.' + b.e.tool)))
  return scored
}

function bigramSet(value) {
  const s = normalizeSearchText(value).replace(/\s+/g, '')
  if (!s) return new Set()
  if (s.length === 1) return new Set([s])
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function diceSimilarity(a, b) {
  const left = bigramSet(a), right = bigramSet(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const x of left) if (right.has(x)) shared++
  return (2 * shared) / (left.size + right.size)
}

function suggestEntries(ref, entries, limit = 5) {
  const q = normalizeSearchText(ref)
  if (!q) return []
  const candidates = new Map()
  const add = (e, label) => {
    if (!e || !entries.includes(e)) return
    const previous = candidates.get(e)
    const score = diceSimilarity(q, label)
    if (!previous || score > previous.score) candidates.set(e, { e, score })
  }
  for (const e of entries) {
    add(e, e.server + '.' + e.tool)
    add(e, e.tool)
  }
  for (const [key, refs] of Object.entries(ALIAS)) {
    for (const value of (Array.isArray(refs) ? refs : [])) add(resolveTool(String(value)), key)
  }
  return [...candidates.values()]
    .filter((x) => x.score >= 0.62)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e)
}

function suggestionBlock(ref, entries, limit = 5) {
  const suggestions = suggestEntries(ref, entries, limit)
  if (!suggestions.length) return ''
  return '\n\nNearest tool names:\n' + suggestions
    .map((e) => '- ' + e.server + '.' + e.tool + ' — ' + short(flat(displayDesc(e)), 120))
    .join('\n')
}

async function listAll(client, method, key, timeoutMs, label) {
  const items = []
  let cursor
  for (let page = 0; page < 100; page++) {
    const res = await withTimeout(client[method](cursor ? { cursor } : {}), timeoutMs, label + ' page=' + (page + 1))
    items.push(...(res?.[key] ?? []))
    cursor = res?.nextCursor
    if (!cursor) return { [key]: items }
  }
  throw new Error(label + ': pagination exceeded 100 pages')
}

// The ONE place that turns a downstream tools/list into the catalog snapshot, so the
// connect-time fill, the list_changed handler and the miss-path refresh cannot diverge.
function setCatalog(entry, tools, opts = {}) {
  entry.catalog.clear()
  for (const t of tools ?? []) {
    entry.catalog.set(t.name, {
      server: entry.name,
      tool: t.name,
      description: (t.description ?? '').replace(/\s+/g, ' ').trim(),
      // schema = 摊平后的口径（oneOf/anyOf 判别联合 → flat properties + allOf 条件必填）：
      // 参数表、参数块、参数预检全靠它。原始 schema 留在 rawSchema，只给 #schema 与 tools/list。
      schema: flattenUnion(t.inputSchema ?? { type: 'object', properties: {} }),
      rawSchema: t.inputSchema ?? { type: 'object', properties: {} },
    })
  }
  entry.catalogFromCache = opts.fromCache === true
  if (!entry.catalogFromCache && entry.status === 'ready') persistCatalog(entry)
}

// Safety net for a downstream that grows tools without announcing it: re-list once, only
// on a lookup miss (hot path untouched; concurrent misses share one refresh).
let refreshInFlight = null
function refreshCatalogs() {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const targets = [...conns.values()].filter((c) => c.client && c.connected)
    await Promise.allSettled(targets.map(async (c) => {
      const listed = await listAll(c.client, 'listTools', 'tools', PRE_RESOLVE_WAIT_MS, c.name + ' tools/list(refresh)')
      setCatalog(c, listed.tools)
      log('catalog refreshed', c.name, 'tools=' + c.catalog.size)
    }))
  })().finally(() => { refreshInFlight = null })
  return refreshInFlight
}

// Resolve without blocking on every server: a healthy catalog answers in 0 ms, so
// one slow downstream can no longer delay calls aimed at a healthy one (head-of-line block).
async function resolveWithWait(ref) {
  let e = resolveTool(ref)
  if (e) return e
  const clean = String(ref ?? '').trim()
  const explicitServer = clean.includes('.')
    ? clean.split('.', 1)[0]
    : clean.startsWith('mcp__') ? clean.slice(5).split('__', 1)[0] : null
  const target = explicitServer ? conns.get(explicitServer) : null
  if (target && target.status !== 'ready') await waitOne(target.name)
  await waitAll(PRE_RESOLVE_WAIT_MS)
  e = resolveTool(ref)
  if (e) return e
  // Only pay the full catalog window when a server is still starting (cold start).
  if ([...conns.values()].some((c) => !c.connected && !c.error)) await waitAll(Number(CFG.catalogWaitMs ?? 20000))
  e = resolveTool(ref)
  if (e) return e
  // Still unknown: the tool may have appeared after connect (dynamic toolsets) — re-list once.
  await refreshCatalogs()
  return resolveTool(ref)
}

function resolveTool(ref) {
  const clean = String(ref ?? '').trim()
  const entries = allEntries()
  const exact = entries.filter((e) => norm(e.server + '__' + e.tool) === norm(clean))
  if (exact.length === 1) return exact[0]
  const byTool = entries.filter((e) => e.tool === clean)
  if (byTool.length === 1) return byTool[0]
  if (byTool.length > 1) throw new Error('ambiguous "' + clean + '": ' + byTool.map((e) => e.server + '.' + e.tool).join(', '))
  return null
}

const text = (t) => ({ type: 'text', text: t })

const TOOLS = [
  {
    name: 'catalog',
    description:
      'List tools of the mounted MCP servers (' + (CFG.servers ?? []).map((x) => x.name).join(', ') + '). '
      + 'No arguments = per-server overview. With query = matching tools as server.tool(signature) — one-line description. '
      + 'Step 1 of catalog -> describe -> call: pick a tool here, run describe to get its parameter table and manual chapters, then call.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Keyword(s) matched against tool name and description (case-insensitive).' },
      server: { type: 'string', description: 'Restrict to one server name.' },
      limit: { type: 'number', description: 'Max lines (default 40).' },
    } },
  },
  {
    name: 'describe',
    description: 'Full description and exact JSON parameter schema of one catalogued tool. '
      + 'Step 2 of catalog -> describe -> call: call is rejected until this tool has been described in the session. '
      + 'For a multi-op tool you may fetch a single branch: "server.tool#op:<value>".',
    inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'server.tool, mcp__server__tool, or a unique bare tool name.' } }, required: ['tool'] },
  },
  {
    name: 'call',
    description: 'Invoke one catalogued MCP tool and return its result verbatim (text and images). '
      + 'Step 3 of catalog -> describe -> call: requires describe({tool:"<server>.<tool>"}) first in this session.',
    inputSchema: { type: 'object', properties: {
      tool: { type: 'string', description: 'server.tool, mcp__server__tool, or a unique bare tool name.' },
      arguments: { type: 'object', description: 'Arguments object; omit when the tool takes none.' },
    }, required: ['tool'] },
  },
  {
    name: 'batch',
    description:
      'Invoke several catalogued MCP tools in ONE call. Calls run concurrently ACROSS servers and '
      + 'sequentially WITHIN one server (a downstream owns a single channel). Results return in submission order, '
      + 'each prefixed by a header line; image blocks pass through verbatim.',
    inputSchema: { type: 'object', properties: {
      calls: { type: 'array', description: 'Calls in submission order.', items: { type: 'object', properties: {
        tool: { type: 'string', description: 'server.tool, mcp__server__tool, or a unique bare tool name.' },
        arguments: { type: 'object', description: 'Arguments object; omit when the tool takes none.' },
        label: { type: 'string', description: 'Optional label echoed in the result header.' },
      }, required: ['tool'] } },
    }, required: ['calls'] },
  },
  {
    name: HUB_NAME,
    description: '批量取工具完整声明（description + JSON schema），单次预算 12,288 B。'
      + 'load({}) 用法；load({tools:["srv.tool",…]}) 指定工具；load({server,full:true}) 整家；load({preset}) 预设集。'
      + '零常驻：只为装进来的付费。',
    inputSchema: { type: 'object', properties: {
      server: { type: 'string', description: 'server 名，返回一页索引' },
      tools: { type: 'array', items: { type: 'string' }, description: 'server.tool 列表' },
      preset: { type: 'string', description: 'servers.json hub.presets 里的预设名' },
      full: { type: 'boolean', description: '配合 server：取全部（受预算）' },
      promote: { type: 'boolean', description: '同时挂到原生工具面（全量 cache miss，默认 false）' },
      unload: { type: 'boolean', description: '配合 tools/all：从工具面移除' },
      all: { type: 'boolean', description: '配合 unload：全部移除' },
    } },
  },
]

// 工具面开关：servers.json 的 hub.<工具名> === false ⇒ 该工具不出现在 tools/list、调用直接拒。
// ⚠ 改一次 tools/list = 一次全价 cache miss（SKILL §7）；只在某个入口确实不要时才用。
const TOOLS_OFF = new Set(TOOLS.filter((t) => HUB[t.name] === false).map((t) => t.name))
const TOOLS_ON = TOOLS.filter((t) => !TOOLS_OFF.has(t.name))

async function catalogText(a) {
  const servers = await waitAll(PRE_RESOLVE_WAIT_MS)
  const q = String(a.query ?? '').trim().toLowerCase()
  const only = a.server ? String(a.server).toLowerCase() : null
  const limit = Number(a.limit ?? 40) || 40
  if (!q) {
    const shownServers = only ? servers.filter((c) => c.name.toLowerCase() === only) : servers
    if (only && !shownServers.length) {
      return 'Unknown server "' + a.server + '". Mounted: ' + servers.map((c) => c.name).join(', ') + '.'
    }
    const available = servers.filter((c) => c.status === 'ready' || (c.status === 'cold' && c.catalog.size > 0))
    const pending = servers.filter((c) => c.status === 'starting')
    const lines = shownServers.map((c) => {
      if (c.status === 'ready') return '- ' + c.name + ': ' + c.catalog.size + ' tools'
      if (c.status === 'cold' && c.catalog.size > 0) return '- ' + c.name + ': ' + c.catalog.size + ' cached tools (cold; starts on call)'
      if (c.status === 'cold') return '- ' + c.name + ': cold (no cached catalog; starts on call)'
      const retry = retryText(c)
      return '- ' + c.name + ': ' + (c.status === 'backoff' ? 'RETRYING' : 'UNAVAILABLE')
        + ' (' + (retry ? retry + '; ' : '') + (c.error ?? c.status) + ')'
    })
    const total = available.reduce((n, c) => n + c.catalog.size, 0)
    return 'MCP aggregator: ' + total + ' tools on ' + available.length + '/' + servers.length + ' servers'
      + (pending.length ? ' (still starting: ' + pending.map((c) => c.name).join(', ') + ' — call catalog again in a few seconds)' : '')
      + '.\n' + lines.join('\n')
      + '\n\nNext: catalog({query:"<keyword>"}) → call({tool:"server.tool", arguments:{…}}).'
  }
  const entries = []
  for (const c of servers) {
    if (only && c.name.toLowerCase() !== only) continue
    for (const e of c.catalog.values()) {
      entries.push(e)
    }
  }
  const hits = searchEntries(a.query, entries)
  if (!hits.length) {
    return 'No tool matched "' + a.query + '". Call catalog with no arguments for the server overview.'
      + suggestionBlock(a.query, entries)
  }
  const shown = []
  let used = 0
  for (const { e } of hits.slice(0, limit)) {
    const line = e.server + '.' + e.tool + '(' + sig(e.schema) + ') — ' + short(displayDesc(e), DESC_WIDTH)
    const b = Buffer.byteLength(line) + 1
    if (shown.length && used + b > CATALOG_BUDGET) break
    used += b; shown.push({ e, line })
  }
  return hits.length + ' match(es)' + (shown.length < Math.min(hits.length, limit) ? '（输出已按 ' + CATALOG_BUDGET + ' B 预算截断）' : '') + ':\n'
    + shown.map((x) => x.line).join('\n')
    + (hits.length > shown.length ? '\n… ' + (hits.length - shown.length) + ' more; narrow the query or raise limit.' : '')
}

async function describeText(a, sid, convo) {
  // 支持 describe({tool:"server.tool#op:wire"}) 只取某一章
  const rawRef = String(a.tool ?? '')
  const hash = rawRef.lastIndexOf('#')
  if (hash > 0) {
    const base = resolveTool(rawRef.slice(0, hash)) ?? await resolveWithWait(rawRef.slice(0, hash))
    if (base) {
      const id = rawRef.slice(hash + 1)
      // #schema：唯一的原始 JSON 入口（describe 正文不再内联 schema，只在核对嵌套/默认值时按需取）
      if (id.toLowerCase() === 'schema') {
        declBag(sid, convo).add(base.server + '.' + base.tool + '#desc')
        return '[原始 schema] ' + base.server + '.' + base.tool + '\nparameters:\n' + JSON.stringify(base.rawSchema ?? base.schema ?? { type: 'object', properties: {} })
      }
      // 章节 id 大小写不敏感（op 枚举常是 setOne，而章节按惯例小写 op:setone）
      const man = MANUALS[base.server + '.' + base.tool]
      const want = id.toLowerCase()
      const canon = man ? (Object.keys(man).find((k) => k.toLowerCase() === want) ?? id) : id
      const body = sectionText(base, canon)
      // 参数表随章节一起给：模型拿到「这一段 op 要哪些参数」，不只是散文
      const tbl = opTableOf(base)
      const opName = canon.startsWith('op:') ? canon.slice(3) : canon
      const row = (tbl && (tbl.rows.has(opName) || [...tbl.rows.keys()].some((k) => k.toLowerCase() === opName.toLowerCase())))
        ? (tbl.rows.has(opName) ? opName : [...tbl.rows.keys()].find((k) => k.toLowerCase() === opName.toLowerCase()))
        : null
      // 窄分支是「一次拿全这个 op 的全部信息」的入口：说明内联，不再要求二次 describe
      const tblTxt = row ? '[参数表] ' + base.server + '.' + base.tool + '\n  ' + opRowText(base.schema, tbl, row, true) : ''
      // 这一章的正文已经发给模型了：记进去重桶，之后的 call 不再重复同一段
      if (body) {
        const _b = declBag(sid, convo)
        _b.add(base.server + '.' + base.tool + '#' + canon)
        // 严格流程按 op 判：窄分支只解锁这一章对应的 op（op:setone → setOne），
        // 不冒充「整份 describe 过」，否则其它 op 会被一并放行。
        if (row) _b.add(base.server + '.' + base.tool + '#op:' + row)
      }
      if (body) return [body, tblTxt, sectionIndex(base)].filter(Boolean).join('\n\n')
      if (row) return [tblTxt, sectionIndex(base)].filter(Boolean).join('\n\n')
      return 'no section "' + id + '" for ' + base.server + '.' + base.tool + '\n' + sectionIndex(base)
    }
  }
  let e = resolveTool(a.tool)
  if (!e) await waitAll(PRE_RESOLVE_WAIT_MS)
  if (!e && [...conns.values()].some((c) => !c.connected && !c.error)) {
    await waitAll(Number(CFG.catalogWaitMs ?? 20000))
    e = resolveTool(a.tool)
  }
  if (!e) return 'Unknown tool "' + a.tool + '". Call catalog first.' + suggestionBlock(a.tool, allEntries())
  const idx = sectionIndex(e)
  // 2026-11-15（方案 A）：describe 也是"说明书"的一种发放方式 ⇒ 记下"该工具已 describe"，
  // 之后的首次 call 就不再重复 ① 必填行/② 判据块；结果形状提示改为随 describe 每会话发一次。
  const _bag = declBag(sid, convo)
  _bag.add(e.server + '.' + e.tool + '#desc')
  const _shape = _bag.has('#shape') ? '' : SHAPE_HINT
  if (_shape) _bag.add('#shape')
  // 多 op 工具：整份 schema 之前先给按 op 拆好的参数表（省下模型从散文/整份 schema 里推必填）
  const _tbl = opTableOf(e)
  const _tblTxt = _tbl ? opTableText(e.server + '.' + e.tool, e.schema ?? {}, _tbl) : ''
  // 没有 op 维度的工具：整份 schema 前先给参数说明表（下游 schema 没写 description 时靠 sidecar 补）
  const _pdTxt = _tbl ? '' : paramDocsFor(e.server + '.' + e.tool, e.schema ?? {}, PARAM_DOCS)
  // 正文装得下就整份内联（模型不必再取单章）
  const _inline = inlineSections(e)
  for (const id of _inline.ids) _bag.add(e.server + '.' + e.tool + '#' + id)
  // 严格流程：整份 describe 覆盖该工具全部 op（参数表已经逐 op 列全，不必再按 op 逐个 describe）
  if (_tbl) for (const _o of _tbl.ops) _bag.add(e.server + '.' + e.tool + '#op:' + _o)
  // 输出顺序：判据块 → 工具名+描述 → 章节索引/正文 → 按 op 参数表 → 参数块 → 形状提示 → 原始 schema 指针。
  // **不再内联整份 JSON schema**：参数块已给类型/必填/枚举/默认/说明，要嵌套细节走 describe({tool:"x#schema"})。
  return noteBlock(e) + (noteBlock(e) ? '\n\n' : '') + e.server + '.' + e.tool + '\n\n' + (e.description || '(no description)')
    + (idx ? '\n\n' + idx : '') + (_inline.text ? '\n\n' + _inline.text : '')
    + (_tblTxt ? '\n\n' + _tblTxt : '') + (_pdTxt ? '\n\n' + _pdTxt : '')
    + (_tbl ? '' : '\n\n' + paramBlock(e))
    + (_shape ? '\n\n' + _shape : '')
    + '\n\n完整 schema: describe({tool:"' + e.server + '.' + e.tool + '#schema"})'
}

// ---- B 试验：已装载集合 + 变更标志 ----
// 已装载集合按 mcp-session-id 分桶：DSH 与 Codex 共用一个聚合器进程，一方 initialize 不能清掉另一方装好的工具
const LOADED_SESSIONS = new Map()   // sid -> Map(toolName -> entry)
const HUB_CHANGED = new Set()       // 有变化的 sid
const ANON = 'anon'
const sidOf = function (sid) { return sid || ANON }
const sbag = function (sid) {
  const k = sidOf(sid)
  let m = LOADED_SESSIONS.get(k)
  if (!m) {
    m = new Map()
    LOADED_SESSIONS.set(k, m)
    if (LOADED_SESSIONS.size > 16) { const oldest = LOADED_SESSIONS.keys().next().value; if (oldest !== k) LOADED_SESSIONS.delete(oldest) }
  }
  return m
}
const SSE_CLIENTS = new Map()   // session id -> Set<GET SSE response>
// ---- 会话校验（MCP Streamable HTTP 合规）：initialize 发新 id，后续请求必须携带，未知会话按规范回 404 让客户端重新握手 ----
const ENFORCE_SESSION = CFG.enforceSession !== false
const SESSION_TTL_MS = Math.max(1000, Number(CFG.sessionTtlMs ?? 3600000))
const SESSION_SWEEP_MS = Math.max(50, Number(CFG.sessionSweepMs ?? 60000))
const SESSIONS = new Map()      // sid -> lastSeen ms
let SESS_SEQ = 0
const newSessionId = function () { return 'agg-' + process.pid + '-' + (++SESS_SEQ) + '-' + Date.now().toString(36) }

function closeSessionStreams(sid) {
  for (const res of SSE_CLIENTS.get(sid) ?? []) {
    try { res.end() } catch {}
  }
  SSE_CLIENTS.delete(sid)
}

function cleanupSessionState(sid) {
  SESSIONS.delete(sid)
  LOADED_SESSIONS.delete(sid)
  HUB_CHANGED.delete(sid)
  // 去重桶按「连接」或「连接\0对话」两种键存在，连接断开时两种都要清，
  // 否则对话级键会随着重连无限累积。
  DECL_SEEN.delete(sid)
  const prefix = sid + '\u0000'
  for (const k of DECL_SEEN.keys()) if (k.startsWith(prefix)) DECL_SEEN.delete(k)
  closeSessionStreams(sid)
}

function sweepSessions(now = Date.now()) {
  for (const [sid, lastSeen] of SESSIONS) {
    if (now - lastSeen > SESSION_TTL_MS) {
      log('session expired', sid.slice(0, 32) + '...')
      cleanupSessionState(sid)
    }
  }
}

function touchSession(sid) {
  const now = Date.now()
  SESSIONS.delete(sid)
  SESSIONS.set(sid, now)
  if (SESSIONS.size > 1024) {
    const oldest = SESSIONS.keys().next().value
    if (oldest && oldest !== sid) cleanupSessionState(oldest)
  }
}

setInterval(sweepSessions, SESSION_SWEEP_MS).unref?.()

const notifyListChanged = function (sid) {
  let n = 0
  const streams = SSE_CLIENTS.get(sid)
  for (const r of streams ?? []) {
    try { r.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n\n'); n++ } catch {}
  }
  if (streams && streams.size === 0) SSE_CLIENTS.delete(sid)
  if (process.env.AGG_TRACE) log('list_changed pushed to ' + n + ' sse stream(s) for ' + String(sid).slice(0, 24))
  return n
}

function healthSnapshot() {
  const servers = [...conns.values()].map((c) => ({
    name: c.name,
    status: c.status,
    connected: c.connected,
    tools: c.catalog.size,
    catalogFromCache: c.catalogFromCache,
    activeCalls: c.activeCalls,
    lastUsedAt: c.lastUsedAt ? new Date(c.lastUsedAt).toISOString() : null,
    nextRetryAt: c.nextRetryAt ? new Date(c.nextRetryAt).toISOString() : null,
    error: c.error,
  }))
  const available = servers.filter((s) => s.status === 'ready' || (s.status === 'cold' && s.tools > 0)).length
  const unhealthy = servers.filter((s) => s.status === 'unavailable' || s.status === 'backoff').length
  return {
    ok: unhealthy === 0,
    pid: process.pid,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    tools: servers.reduce((n, s) => n + s.tools, 0),
    availableServers: available,
    totalServers: servers.length,
    readyServers: servers.filter((s) => s.status === 'ready').length,
    coldServers: servers.filter((s) => s.status === 'cold').length,
    sessions: SESSIONS.size,
    sseSessions: SSE_CLIENTS.size,
    authEnabled: AUTH_ENABLED,
    servers,
  }
}

// ---- hub: 索引 + 按需全量声明（聚合器目标不变，按工具粒度付费） ----
const hubOneLine = (e) => {
  const _b = (e.schema?.required ?? []).join(',')
  const _h = condReqHint(e.schema ?? {})
  const req = _b ? _b : (_h ? ('条件必填: ' + _h) : '')
  return e.server + '.' + e.tool + '(' + req + ') — ' + short(String(displayDesc(e)).replace(/\s+/g, ' '), HUB_LINE)
}
// declBody = 工具名 + 描述 + 参数块（不含判据块）：load 路径用它。与 describe 同口径——不回吐原始 schema。
const declBody = (e) => e.server + '.' + e.tool
  + '\n' + String(e.description ?? '(no description)')
  + '\n\n' + paramBlock(e)
  + '\n\n完整 schema: describe({tool:"' + e.server + '.' + e.tool + '#schema"})'
const hubFull = (e) => noteBlock(e) + (noteBlock(e) ? '\n' : '') + declBody(e)

// ---- 会话内去重桶：每「工具 / 节点」首次投递说明书一次（首调与 describe 共用同一套桶） ----
// 去重桶的键由「MCP 传输连接」和「调用方对话」共同决定：
//   · 只有连接时（旧行为）：DSH 全进程共用一条连接，于是服务重启后第一个对话
//     吃掉说明书，后续对话全都拿不到（2026-11-15 实测确认）。
//   · 带对话 id 时：_meta['dsh.dev/sessionId'] 由宿主侧插件按工具调用填进来，
//     同一连接里每个对话各自一份桶，于是"每个对话每工具首次"都能拿到。
// 没带 _meta 的调用方（Codex、手写 curl、其他 MCP 客户端）行为完全不变。
/** `params._meta` 里承载调用方对话 id 的键；沿用 MCP 反向域名惯例。 */
const CONVO_META_KEY = 'dsh.dev/sessionId'
const DECL_SEEN = new Map()
const declBag = function (sid, convo) {
  const k = convo ? sidOf(sid) + '\u0000' + String(convo) : sidOf(sid)
  let s = DECL_SEEN.get(k)
  if (!s) { s = new Set(); DECL_SEEN.set(k, s); if (DECL_SEEN.size > 16) { const oldest = DECL_SEEN.keys().next().value; if (oldest !== k) DECL_SEEN.delete(oldest) } }
  return s
}
const clip = function (s, n) { s = String(s ?? ''); return s.length <= n ? s : s.slice(0, n - 1) + '…' }
const clipBytes = function (s, max) {   // 预算按 UTF-8 字节（中文 3 B/字，别用字符数糊弄）
  s = String(s ?? '')
  if (Buffer.byteLength(s) <= max) return s
  let lo = 0, hi = s.length
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (Buffer.byteLength(s.slice(0, mid)) <= max - 3) lo = mid; else hi = mid - 1 }
  return s.slice(0, lo) + '…'
}
const flat = function (s) { return String(s ?? '').replace(/\s+/g, ' ').trim() }
// ---- 参数预检：缺必填 / 未知键(schema 明确禁止时) / enum 越界 → 不派发 ----
const checkArgs = function (e, args) {
  const sch = e.schema
  if (!sch || sch.type !== 'object' || !sch.properties) return null
  const props = sch.properties
  const _base = Array.isArray(sch.required) ? sch.required : []
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {}
  // 多 op 工具：必填随 op 变化。schema.required 只列公共项，分 op 的必填由参数表给（只认强约束，弱提示不拦）。
  const _op = opOfArgs(e, a)
  const _tbl = _op && opKeyOf(sch) ? opTableOf(e) : null
  const _opRow = (_tbl && (_tbl.rows.get(_op) ?? [..._tbl.rows.entries()].find(([k]) => k.toLowerCase() === _op.toLowerCase())?.[1])) || null
  const _opReq = _opRow ? _opRow.required : []
  const req = _base.concat(_opReq.filter((k) => !_base.includes(k)))
    .concat(condReqFor(sch, a).filter((k) => !_base.includes(k) && !_opReq.includes(k)))
  const missing = req.filter((k) => (a[k] === undefined || a[k] === null) && !(props[k] && Object.prototype.hasOwnProperty.call(props[k], 'default')))
  const unknown = sch.additionalProperties === false ? Object.keys(a).filter((k) => !(k in props)) : []
  const badEnum = Object.keys(a).filter((k) => props[k]?.enum && a[k] !== undefined && !props[k].enum.includes(a[k]))
    .map((k) => k + '=' + JSON.stringify(a[k]) + ' 不在 enum [' + props[k].enum.join('/') + ']')
  // 该 op 不需要、但别的 op 需要的参数被传进来：不拦，只提示（下游可能宽容接受，硬拦会误伤）
  const _other = _tbl ? [..._tbl.rows.entries()].filter(([k]) => k !== _op).flatMap(([, r]) => r.required.concat(r.weak)) : []
  const extraneous = _op ? Object.keys(a).filter((k) => k !== opKeyOf(sch) && !_opRow?.required.includes(k) && !_opRow?.optional.includes(k) && _opRow && _other.includes(k)) : []
  // 二选一必填（摊平判别联合时留下的 __anyOfReq，如 component_select 的 keyword|properties）：
  // schema 说的是「至少满足一组」，单列 required 表不出来，只能用组判。
  // 组来源两处：整份 schema 的二选一（__anyOfReq），或当前 op 的多分支二选一（参数表的 opAnyOf）
  const _anyOf = (_tbl && _op && Array.isArray(_tbl.opAnyOf?.[_op]) && _tbl.opAnyOf[_op].length)
    ? _tbl.opAnyOf[_op]
    : (Array.isArray(sch.__anyOfReq) ? sch.__anyOfReq : null)
  let anyOf = []
  if (_anyOf && _anyOf.length) {
    const hit = _anyOf.some((g) => Array.isArray(g) && g.length && g.every((k) => a[k] !== undefined && a[k] !== null))
    if (!hit) anyOf = _anyOf.map((g) => '(' + g.join('+') + ')').join(' 或 ')
  }
  // 只有「该 op 不需要的参数」不算错：下游多半宽容接受，硬拦会误伤（如 read 时顺手带了 num）。
  // 它只在已经有真错误时作为附加提示出现。
  if (!missing.length && !unknown.length && !badEnum.length && !anyOf.length) return null
  return { missing, unknown, badEnum, extraneous, anyOf, op: _op, opKey: opKeyOf(sch) }
}
const preflightMsg = function (e, r, args) {
  const why = []
  const _tbl = r.op ? opTableOf(e) : null
  if (r.op) why.push('当前 ' + r.opKey + '=' + r.op + ' 只认这些参数')
  if (r.missing.length) why.push('缺少必填参数: ' + r.missing.join(', '))
  if (r.anyOf && r.anyOf.length) why.push('至少要满足一组必填: ' + r.anyOf)
  if (r.unknown.length) why.push('未知参数(该工具 schema 不接受): ' + r.unknown.join(', '))
  if (r.extraneous && r.extraneous.length) why.push('该 op 不需要的参数: ' + r.extraneous.join(', '))
  for (const b of r.badEnum) why.push(b)
  // 报错不附整份 schema，与首调投递的降级形态保持一致（必填 + 判据 + 指针）
  var _nb = noteBlock(e)
  return '[参数校验失败，未派发] ' + e.server + '.' + e.tool + ' — ' + why.join('；')
    + (_tbl && r.op ? '\n\n' + opTableText(e.server + '.' + e.tool, e.schema ?? {}, _tbl) : '')
    + '\n\n修正参数后重发；该工具摘要与判据：\n\n' + basicDecl(e, args)
    + (_nb ? '\n\n' + _nb : '')
    + '\n\n完整 schema: describe({tool:"' + e.server + '.' + e.tool + '"})'
}

async function hubText(a, sid) {
  const bag = sbag(sid)
  await waitAll(PRE_RESOLVE_WAIT_MS)
  const mounted = [...conns.values()]
  const wantServer = a.server ? String(a.server).trim().toLowerCase() : null
  const wantTools = Array.isArray(a.tools) ? a.tools.map((x) => String(x)) : []
  // presets：servers.json 的 hub.presets 里定义的"常用工具集"，一条 load 装齐 = 一次工具面变化（只付一次 cache miss）
  const PRESETS = (HUB.presets && typeof HUB.presets === 'object') ? HUB.presets : {}
  const wantPresets = a.preset === undefined ? [] : (Array.isArray(a.preset) ? a.preset.map(String) : [String(a.preset)])
  const unknownPresets = []
  for (const p of wantPresets) {
    const list = PRESETS[p]
    if (Array.isArray(list)) wantTools.push(...list.map(String))
    else unknownPresets.push(p)
  }
  const full = a.full === true
  if (a.unload === true) {
    const removed = []
    if (a.all === true) { for (const k of [...bag.keys()]) { bag.delete(k); removed.push(k) } }
    else for (const n of wantTools) { const key = String(n).split('.').pop(); if (bag.has(key)) { bag.delete(key); removed.push(key) } }
    if (removed.length) { HUB_CHANGED.add(sidOf(sid)); return 'unloaded ' + removed.length + ' tool(s): ' + removed.join(', ') + ' — tool face shrinks on the next client poll' }
    return 'nothing to unload (currently loaded: ' + ([...bag.keys()].join(', ') || 'none') + ')'
  }

  if (!wantServer && !wantTools.length && !wantPresets.length) {
    const total = mounted.reduce((n, c) => n + (c.catalog ? c.catalog.size : 0), 0)
    return 'hub: ' + total + ' tools are folded into catalog/describe/call/batch. Call me before invoking unfamiliar tools.\n'
      + '  load({server:"<name>"})              -> one-line index of that server\n'
      + '  load({tools:["<server>.<tool>",...]}) -> index + FULL description & schema (you pay only for these)\n'
      + '  load({server:"<name>", full:true})   -> whole server in full (' + HUB_FULL_BUDGET + ' B budget; batch if truncated)\n'
      + '  load({preset:"<name>", promote:true}) -> install a pre-defined tool set in ONE call (one cache miss); presets: ' + ((HUB.presets && Object.keys(HUB.presets).join(', ')) || 'none configured') + '\n'
      + 'Mounted: ' + mounted.map((c) => c.name + ':' + (
        c.status === 'ready' ? (c.catalog ? c.catalog.size : 0)
          : c.status === 'cold' ? 'COLD(' + (c.catalog?.size ?? 0) + ')'
            : c.status === 'backoff' ? 'RETRY(' + retryText(c) + ')'
              : 'UNAVAILABLE')).join('  ')
  }

  const picked = [], missing = []
  for (const n of wantTools) { const e = resolveTool(n); if (e) picked.push(e); else missing.push(n) }

  let pool = []
  if (wantServer) {
    const c = mounted.find((x) => String(x.name).toLowerCase() === wantServer)
    if (!c) return 'Unknown server "' + a.server + '". Mounted: ' + mounted.map((x) => x.name).join(', ')
    if (c.status !== 'ready' && c.status !== 'cold') return c.name + ' is ' + c.status.toUpperCase()
      + ' (' + (retryText(c) ? retryText(c) + '; ' : '') + (c.error ?? c.status) + ')'
    pool = [...c.catalog.values()].sort((x, y) => String(x.tool).localeCompare(String(y.tool)))
  }

  const out = []
  if (pool.length) {
    const idx = pool.map(hubOneLine).join('\n')
    out.push('[index] ' + pool[0].server + ' (' + pool.length + ' tools, ' + idx.length + ' B)\n' + short(idx, HUB_INDEX_BUDGET))
    if (full) picked.push(...pool)
    else out.push('\nnext: load({tools:["' + pool[0].server + '.<tool>"]}) for one full declaration, or load({server:"' + pool[0].server + '", full:true}).')
  }

  const seen = new Set(), decls = [], skipped = [], oversized = [], unavailable = []
  let used = 0
  for (const e of picked) {
    const k = e.server + '.' + e.tool
    if (seen.has(k)) continue
    seen.add(k)
    const d = hubFull(e)
    const db = Buffer.byteLength(d)              // 预算按 UTF-8 字节（中文 3 B/字），与 clipBytes 同口径
    if (db === 0) { unavailable.push(k); continue }   // 下游不可用/声明为空：别塞一条 0 B 的空壳骗人（实测 L10 曾因此只回 43 B）
    if (db > HUB_FULL_BUDGET) {                  // 单件就超预算：裁一份给出来；直接跳过会让它永远装不进来
      const cut = clipBytes(d, HUB_FULL_BUDGET - 200)
      const cb = Buffer.byteLength(cut)
      if (used + cb > HUB_FULL_BUDGET) { skipped.push(k); continue }
      used += cb
      decls.push(cut)
      oversized.push(k)
      continue
    }
    if (used + db > HUB_FULL_BUDGET) { skipped.push(k); continue }
    used += db
    decls.push(d)
  }
  // 装载会改提示前缀 → 整段 cache miss（实测一次 ≈19.5 万 tokens 全价）。所以"读说明书"（默认）与"装进工具面"（promote:true）必须分开。
  var promote = a.promote === true
  var promoted = []
  if (decls.length) {
    const blob = decls.join('\n')
    for (const e of picked) {
      const k = e.server + '.' + e.tool
      if (blob.indexOf(k) < 0) continue
      if (!promote) break
      if (!bag.has(e.tool)) { bag.set(e.tool, e); promoted.push(e.tool) }
    }
    if (promoted.length) { HUB_CHANGED.add(sidOf(sid)); out.push('\n[promoted] ' + promoted.length + ' tool(s) joined the tool face: ' + promoted.join(', ')) }
    out.push('\n[full declaration] ' + decls.length + ' tool(s), ' + used + ' B\n\n' + decls.join('\n\n---\n\n'))
  }
  if (wantPresets.length) out.push('\n[preset] ' + wantPresets.filter((p) => PRESETS[p]).length + ' applied (' + wantPresets.filter((p) => PRESETS[p]).join(', ') + '), tools expanded: ' + wantTools.length
    + (unknownPresets.length ? ' | unknown preset(s): ' + unknownPresets.join(', ') + ' (available: ' + (Object.keys(PRESETS).join(', ') || 'none') + ')' : ''))
  if (missing.length) out.push('\nnot found: ' + missing.join(', '))
  if (oversized.length) out.push('\noversized (truncated to fit; full view: describe({tool:"<ref>"})): ' + oversized.join(', '))
  if (skipped.length) out.push('\nover budget, not loaded (call again in batches): ' + skipped.join(', '))
  if (unavailable.length) out.push('\ndeclaration unavailable (server not connected; no empty shell emitted): ' + unavailable.join(', '))
  return out.length ? out.join('\n') : '(nothing to load)'
}


async function ensureAlive(c, force = false) {
  if (!force && c.client && !c.error) return c
  // One reconnect per server at a time: without this, N concurrent failures each
  // called conns.delete + connect, leaving N-1 orphaned downstream processes.
  const running = reconnectInFlight.get(c.name)
  if (running) return running
  const p = (async () => {
    log('reconnecting', c.name)
    const spec = c.spec
    const oldClient = c.client          // 先抓引用：old === c，置 null 之后就拿不到旧 client 了
    clearRetryTimer(c)
    c.client = null
    c.catalog.clear()
    c.error = null
    c.connected = false
    c.status = 'idle'
    conns.delete(c.name)
    const fresh = connect(c.name, spec)      // re-registers in conns synchronously
    retireClient(c, oldClient)
    await fresh.ready
    if (fresh.error) throw new Error('server "' + c.name + '" unavailable: ' + fresh.error)
    return fresh
  })().finally(() => reconnectInFlight.delete(c.name))
  reconnectInFlight.set(c.name, p)
  return p
}

function retireClient(entry, client) {
  if (!client) return
  entry.retiredClients.push(client)
  closeRetiredClients(entry)
}

function closeRetiredClients(entry) {
  if (entry.activeCalls > 0 || !entry.retiredClients.length) return
  const clients = entry.retiredClients.splice(0)
  for (const client of clients) Promise.resolve(client.close()).catch(() => {})
}

function releaseActiveCall(entry) {
  if (!entry) return
  entry.activeCalls = Math.max(0, entry.activeCalls - 1)
  closeRetiredClients(entry)
}

function transferActiveCall(from, to) {
  if (!to || from === to) return to ?? from
  releaseActiveCall(from)
  to.activeCalls += 1
  return to
}

async function sweepIdleLazyServers() {
  const now = Date.now()
  for (const c of conns.values()) {
    if (String(c.spec?.startup ?? 'eager').toLowerCase() !== 'lazy') continue
    if (c.status !== 'ready' || c.activeCalls > 0 || !c.lastUsedAt) continue
    const idleMs = Math.max(1000, Number(c.spec?.idleMs ?? LAZY_IDLE_MS))
    if (now - c.lastUsedAt < idleMs) continue
    const oldClient = c.client
    c.client = null
    c.connected = false
    c.status = 'cold'
    c.ready = Promise.resolve()
    c.error = null
    log('lazy idle stop', c.name, 'idle=' + Math.round((now - c.lastUsedAt) / 1000) + 's', 'cachedTools=' + c.catalog.size)
    try { await oldClient?.close() } catch {}
  }
}

setInterval(sweepIdleLazyServers, Math.min(60000, Math.max(1000, Math.floor(LAZY_IDLE_MS / 2)))).unref?.()

// Stateful GUI servers are shared by every client session. An exclusive server has one
// global FIFO lane, independent of batch grouping, so Codex and DSH cannot interleave
// mutating calls against the same EDA/KiCad/FreeCAD process.
const SERVER_LOCK_TAILS = new Map()

async function acquireServerLock(c) {
  const name = c.name
  const timeoutMs = Math.max(1, Number(c.spec?.lockTimeoutMs ?? CFG.lockTimeoutMs ?? 30000))
  const previous = SERVER_LOCK_TAILS.get(name) ?? Promise.resolve()
  let releaseHold
  const hold = new Promise((resolve) => { releaseHold = resolve })
  const tail = previous.catch(() => {}).then(() => hold)
  SERVER_LOCK_TAILS.set(name, tail)

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('SERVER_BUSY: "' + name + '" stayed locked for ' + timeoutMs + 'ms')), timeoutMs)
  })
  try {
    await Promise.race([previous.catch(() => {}), timeout])
  } catch (err) {
    releaseHold()
    if (SERVER_LOCK_TAILS.get(name) === tail) SERVER_LOCK_TAILS.delete(name)
    throw err
  } finally {
    clearTimeout(timer)
  }

  let released = false
  return function release() {
    if (released) return
    released = true
    releaseHold()
    queueMicrotask(() => {
      if (SERVER_LOCK_TAILS.get(name) === tail) SERVER_LOCK_TAILS.delete(name)
    })
  }
}

async function withServerLock(c, fn) {
  if (String(c.spec?.concurrency ?? 'parallel').toLowerCase() !== 'exclusive') return fn()
  const release = await acquireServerLock(c)
  try { return await fn() } finally { release() }
}

// Failure taxonomy. A replay is only safe when the downstream provably never ran the
// call — a JSON-RPC error with a numeric code came FROM the tool (it ran and failed),
// and a timeout/connection loss may have half-executed. Only SdkError(NotConnected)
// throws BEFORE the request is sent, so that is the one case we retry.
const isRpcError = (err) => typeof err?.code === 'number'
const isTimeout = (err) => err?.name === 'AbortError'
  || /^(REQUEST_TIMEOUT|RequestTimeout)$/i.test(String(err?.code ?? ''))
  || /^(Request timed out|timeout:)/.test(String(err?.message ?? ''))
const isPreSendFailure = (err) => /^NOT_?CONNECTED$/i.test(String(err?.code ?? ''))
  || /^Not connected$/.test(String(err?.message ?? ''))
const looksDisconnected = (err) => !isRpcError(err)
  && /Not connected|closed|disconnect|EPIPE|ECONNRESET|ECONNREFUSED|socket hang up|transport|fetch failed|other side closed|UND_ERR/i.test(String(err?.message ?? err))

async function callTool(a, sid, budget, convo) {
  let stalePreflightNote = null
  let e = await resolveWithWait(a.tool)
  if (!e) return { content: [text('Unknown tool "' + a.tool + '". Call catalog first.' + suggestionBlock(a.tool, allEntries()))], isError: true }
  // 首调补发（默认路径，hub.firstCallDecl）：本会话没 describe 过这个工具/op ⇒ 照常派发，
  // 并在 content 末尾追加一块与 describe 同构的说明书（每工具/op 每会话一次）。门（STRICT_FLOW）默认关。
  let firstDecl = null
  if (!STRICT_FLOW && FIRST_DECL_ON) {
    const _nRef = e.server + '.' + e.tool
    const _nOp = opOfArgs(e, (a.arguments && typeof a.arguments === 'object') ? a.arguments : {})
    const _nBag = declBag(sid, convo)
    const _nKey = _nOp ? _nRef + '#op:' + _nOp : _nRef + '#desc'
    const _nCovered = _nBag.has(_nRef + '#desc') || _nBag.has(_nKey)
      || (_nOp && [..._nBag].some((k) => k.toLowerCase() === _nKey.toLowerCase()))
    if (!_nCovered) {
      // 与 describe 同一个产出；describeText 顺带把 #desc / #op:* 记进桶，之后不再重复
      const _full = await describeText({ tool: _nRef }, sid, convo)
      const _ok = FIRST_DECL === 'full' && Buffer.byteLength(_full) <= FIRST_DECL_BUDGET
      firstDecl = '[说明书·自动补发]\n\n'
        + (_ok ? _full : shortDecl(e, budget ? Math.min(FIRST_DECL_BUDGET, Math.max(300, budget.left)) : FIRST_DECL_BUDGET))
      if (budget) {
        if (budget.left <= 0) firstDecl = null
        else {
          firstDecl = clipBytes(firstDecl, Math.max(300, budget.left))
          budget.left -= Buffer.byteLength(firstDecl) + 1
        }
      }
    }
  }
  // 严格流程（hub.strictFlow，默认关）：按「工具 + 功能/op」粒度门禁 —— 本会话内某个 op 首次
  // 被调用前，必须先 describe 过它。多 op 工具可以并行首调不同 op（各自 describe 一次即可）。
  //   整份 describe(tool)      → 覆盖该工具的全部 op
  //   窄分支 describe(tool#op:x) → 只覆盖 op x
  //   无 op 维度的工具         → 覆盖该工具本身
  if (STRICT_FLOW) {
    const _gateRef = e.server + '.' + e.tool
    const _gateOp = opOfArgs(e, (a.arguments && typeof a.arguments === 'object') ? a.arguments : {})
    const _gateKey = _gateOp ? _gateRef + '#op:' + _gateOp : _gateRef + '#desc'
    const _bag = declBag(sid, convo)
    const _covered = _bag.has(_gateRef + '#desc') || _bag.has(_gateKey)
      || (_gateOp && [..._bag].some((k) => k.toLowerCase() === _gateKey.toLowerCase()))
    if (!_covered) {
      return {
        content: [text('[流程校验失败，未派发] ' + _gateRef
          + (_gateOp ? ' 的 ' + (opKeyOf(e.schema) ?? 'op') + '=' + _gateOp : '')
          + ' — 本会话还没 describe 过'
          + (_gateOp ? '这个 op' : '它') + '。\n先取参数表与用法再调用：'
          + 'describe({tool:"' + _gateRef + (_gateOp ? '#op:' + _gateOp : '') + '"})\n'
          + (_gateOp
            ? '（只需要这一个分支就够了；describe 会把该 op 的参数表与手册章节一并给你，之后 call 不再重复回吐）'
            : '（catalog → describe → call；describe 会把参数表、手册章节一并给你，之后 call 不再重复回吐）'))],
        isError: true,
      }
    }
  }
  // 老调用方可能还带 _intent / _sections（旧选章参数）：派发前剥掉，不进下游；
  // 说明书投递现在与 describe 同构，选章改用 describe({tool:"server.tool#章节id"})。
  const rawArgs = (a.arguments && typeof a.arguments === 'object' && !Array.isArray(a.arguments)) ? { ...a.arguments } : {}
  delete rawArgs._intent; delete rawArgs._sections
  const bad = PREFLIGHT ? checkArgs(e, rawArgs) : null
  // 声明来自旧 catalog-cache 时不做硬拦：缓存里的 required/schema 可能已过期（实测改完下游 schema 后
  // 首次调用会被"缺少必填参数"假拦、重发就过）。放行交给下游自己校验；一旦 persistCatalog 刷新过就不再有这个豁免。
  const staleSchema = CACHE_SERVED.has(e.server)
  if (bad && staleSchema) { stalePreflightNote = preflightMsg(e, bad, rawArgs) }
  if (bad && !staleSchema) {
    declBag(sid, convo).add(e.server + '.' + e.tool)   // 预检已附声明，别在下一次重复
    let msg = preflightMsg(e, bad, rawArgs)
    if (budget) {                               // batch 内：预检回吐也要吃整批预算
      if (budget.left <= 0) msg = msg.split('\n修正参数后重发')[0]
      else msg = clipBytes(msg, Math.max(200, budget.left))
      budget.left -= Buffer.byteLength(msg) + 1
    }
    return { content: [text(msg)], isError: true }
  }
  let res
  const callStartedAt = Date.now()
  let c = conns.get(e.server)
  if (!c) return { content: [text('Unknown server "' + e.server + '".')], isError: true }
  let activeEntry = c
  activeEntry.activeCalls += 1
  try {
    c = await waitOne(e.server)
    await withServerLock(c, async () => {
      c = readyOne(e.server)
      activeEntry = transferActiveCall(activeEntry, c)
      // The SDK's own per-request timeout aborts the request (and tells the downstream to
      // cancel); racing our own timer left the request in flight, blocking serial servers.
      // skills 下游需要「会话内去重」：把调用方对话 id 以 _dshSession 注入参数
      // （只对 skills.* 生效，避免污染其它下游的参数预检）；下游负责剥掉它。
      const downstreamArgs = (e.server === 'skills' && convo !== undefined)
        ? { ...rawArgs, _dshSession: convo }
        : rawArgs
      const invoke = () => c.client.callTool(
        { name: e.tool, arguments: downstreamArgs },
        { timeout: c.spec?.callTimeoutMs ?? CALL_TIMEOUT_MS },
      )
      try {
        res = await invoke()
      } catch (err) {
        if (!isPreSendFailure(err)) {
          if (looksDisconnected(err) && !isTimeout(err)) {
            // Never replay: the tool may have executed before the link died. Repair the
            // link in the background so the NEXT call is healthy.
            log('link error on', e.server, '(' + String(err?.message ?? err).slice(0, 120) + ') — reconnecting, not replaying')
            ensureAlive(c, true).catch(() => {})
          }
          if (isTimeout(err)) {
            throw new Error(e.server + '.' + e.tool + ' 超时（' + Math.round((c.spec?.callTimeoutMs ?? CALL_TIMEOUT_MS) / 1000)
              + 's）：已向下游发出取消通知。若该下游不实现 cancellation，它可能仍在执行，后续同 server 的调用会排队等它。')
          }
          throw err
        }
        c = await ensureAlive(c, true)
        activeEntry = transferActiveCall(activeEntry, c)
        e = resolveTool(a.tool) ?? e
        res = await invoke()
      }
    })
  } finally {
    c.activeCalls = Math.max(0, c.activeCalls - 1)
    c.lastUsedAt = Date.now()
    const elapsed = Date.now() - callStartedAt
    if (elapsed >= SLOW_CALL_MS) log('slow call', e.server + '.' + e.tool, elapsed + 'ms')
  }
  const out = { content: (res?.content?.length ? res.content : [text('(no content)')]) }
  if (res?.structuredContent !== undefined) out.structuredContent = res.structuredContent
  if (res?.isError) out.isError = true
  // 说明书单独成块、固定在末尾：content[0] 永远是下游真结果（调用方可整段 JSON.parse 它）
  if (firstDecl) out.content = (out.content || []).concat([text(firstDecl)])
  return out
}

async function batchTools(a, sid, convo) {
  const declBudget = { left: FIRST_DECL_BATCH_BUDGET }
  await waitAll(PRE_RESOLVE_WAIT_MS)
  const calls = Array.isArray(a.calls) ? a.calls.filter((c) => c && typeof c === 'object') : []
  if (!calls.length) return { content: [text('batch: pass calls:[{tool, arguments, label?}]')], isError: true }
  if (calls.length > MAX_BATCH_CALLS) {
    return { content: [text('batch: ' + calls.length + ' calls exceeds the limit of ' + MAX_BATCH_CALLS + '; split it.')], isError: true }
  }
  let resolved = calls.map((c) => {
    try { return { call: c, entry: resolveTool(c.tool) } }
    catch (err) { return { call: c, entry: null, err: String(err?.message ?? err) } }
  })
  if (resolved.some((r) => !r.entry && !r.err)) {
    // Cold start: catalogs may still be filling in — pay the full window once.
    await waitAll(Number(CFG.catalogWaitMs ?? 20000))
    resolved = calls.map((c) => {
      try { return { call: c, entry: resolveTool(c.tool) } }
      catch (err) { return { call: c, entry: null, err: String(err?.message ?? err) } }
    })
  }
  if (resolved.some((r) => !r.entry && !r.err)) {
    // Dynamic toolsets (e.g. konnect load_toolset): re-list once before giving up.
    await refreshCatalogs()
    resolved = calls.map((c) => {
      try { return { call: c, entry: resolveTool(c.tool) } }
      catch (err) { return { call: c, entry: null, err: String(err?.message ?? err) } }
    })
  }
  // Group by owning server: one downstream owns ONE channel, so calls into the same
  // server stay sequential (same stdio client / same EDA bridge); servers run concurrently.
  const groups = new Map()
  resolved.forEach((r, i) => {
    const key = r.entry ? r.entry.server : '\u0000unresolved'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(i)
  })
  const results = new Array(calls.length)
  // Per-call start/end offsets in one log line each: overlap is read off the
  // timestamps instead of inferred from wall-clock totals (latency noise hides it).
  const t0 = Date.now()
  const stamp = () => '+' + String(Date.now() - t0).padStart(5) + 'ms'
  log('batch start: ' + calls.length + ' call(s) in ' + groups.size + ' server group(s)')
  await Promise.all([...groups.values()].map(async (idxs) => {
    for (const i of idxs) {
      const { call, entry, err } = resolved[i]
      if (!entry) { results[i] = { content: [text('Unknown tool "' + call.tool + '": ' + (err ?? 'call catalog first'))] }; continue }
      log('batch #' + (i + 1) + ' ' + entry.server + ' start ' + stamp())
      try { results[i] = await callTool({ tool: call.tool, arguments: call.arguments ?? {} }, sid, declBudget, convo) }
      catch (e) { results[i] = { content: [text('ERROR: ' + String(e?.message ?? e))] } }
      log('batch #' + (i + 1) + ' ' + entry.server + ' end   ' + stamp())
    }
  }))
  // Per-call errors stay in the text, never in isError: a top-level isError makes the
  // DSH bridge throw and drop image blocks for the calls that DID succeed.
  const content = []
  results.forEach((r, i) => {
    const c = calls[i]
    content.push(text('\u2500\u2500 [' + (i + 1) + '] ' + (c.label ?? c.tool) + (resolved[i].entry ? '' : '  [UNRESOLVED]') + ' \u2500\u2500'))
    for (const block of r.content ?? []) content.push(block)
  })
  return { content }
}

const resourceOwners = new Map()
const templateOwners = new Map()

function serverSupports(c, kind) {
  try { return !!(c.client?.getServerCapabilities?.() ?? {})[kind] } catch { return false }
}

async function resourcesList() {
  const servers = await waitAll(Number(CFG.catalogWaitMs ?? 20000))
  const out = []
  for (const c of servers) {
    if (c.error || !c.client || !serverSupports(c, 'resources')) continue
    try {
      const res = await listAll(c.client, 'listResources', 'resources', 15000, c.name + ' resources/list')
      for (const r of res?.resources ?? []) {
        resourceOwners.set(r.uri, c.name)
        out.push({ ...r, name: c.name + ': ' + (r.name ?? r.uri) })
      }
    } catch (err) { log('resources/list failed on', c.name, String(err?.message ?? err)) }
  }
  return out
}

async function resourceTemplatesList() {
  const servers = await waitAll(Number(CFG.catalogWaitMs ?? 20000))
  const out = []
  for (const c of servers) {
    if (c.error || !c.client || !serverSupports(c, 'resources')) continue
    try {
      const res = await listAll(c.client, 'listResourceTemplates', 'resourceTemplates', 15000, c.name + ' resources/templates/list')
      for (const t of res?.resourceTemplates ?? []) {
        templateOwners.set(t.uriTemplate, c.name)
        out.push({ ...t, name: c.name + ': ' + (t.name ?? t.uriTemplate) })
      }
    } catch (err) { log('templates/list failed on', c.name, String(err?.message ?? err)) }
  }
  return out
}

async function resourceRead(uri) {
  await waitAll(Number(CFG.catalogWaitMs ?? 20000))
  const owner = resourceOwners.get(uri)
  if (!owner) {
    let lastErr = null
    for (const c of conns.values()) {
      if (!c.client || !serverSupports(c, 'resources')) continue
      try {
        // A hit must come back with contents; an empty answer means "not mine".
        const res = await withTimeout(c.client.readResource({ uri }), 30000, 'resources/read ' + c.name)
        if (res && Array.isArray(res.contents) && res.contents.length) { resourceOwners.set(uri, c.name); return res }
      } catch (err) { lastErr = err }
    }
    throw new Error('unknown resource uri: ' + uri + (lastErr ? ' (last error: ' + String(lastErr?.message ?? lastErr) + ')' : ''))
  }
  const c = await waitOne(owner)
  return await withTimeout(c.client.readResource({ uri }), 30000, owner + ' resources/read')
}


const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])

// initialize.instructions：随握手一次性下发、由客户端注入系统提示（DSH 上限 32,768 B）。
// 这是常驻前缀 ⇒ 文案必须冻结：不写工具数、server 名单等会漂移的量，否则每次改动
// 都会让所有会话的 prompt cache 前缀失效。hub.instructions:false 可关闭。
const INSTRUCTIONS = (HUB.instructions === false) ? undefined : [
  '下游 MCP 工具已折叠，只暴露 3 个入口，必须按顺序走：',
  '',
  '1. catalog({query?, server?, limit?})',
  '   用法：query 关键词找工具（不传=各家概览）。回吐：每行 `server.tool(必填参数) — 一句话说明`，够粗筛。',
  '2. describe({tool:"server.tool"})',
  '   用法：多 op 工具可只取一段 `server.tool#op:<值>`。回吐：判据块（何时用/别用/硬边界/坑）+ 手册章节正文',
  '        + 按 op 拆的参数表（必填/可选/每个参数作用）+ 完整 JSON schema。',
  '3. call({tool, arguments})',
  '   用法：arguments 按 describe 给的表填。未 describe 过该 op 会被拒（粒度=工具+op；describe 整份解锁全部 op，',
  '        窄分支只解锁那一个）。回吐：下游原文（text/image）。参数预检会拦缺必填/未知键/enum 越界，不下发。',
  '',
  'describe 已一次给全，之后 call 不再回吐，重复 describe 是浪费。',
].join('\n')

async function handleMsg(msg, sid) {
  const { id, method, params } = msg
  // 每次客户端建立会话时清空已装载集合：避免长跑进程里提升的工具无限累积（跨会话共享的聚合器必须这样隔离）
  if (method === 'initialize') cleanupSessionState(sidOf(sid))
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: {
    protocolVersion: PROTOCOL_VERSIONS.has(params?.protocolVersion) ? params.protocolVersion : '2025-06-18',
    capabilities: { tools: { listChanged: true }, resources: { subscribe: false, listChanged: false } },
    serverInfo: { name: 'mcp-aggregator', version: '1.0.0' },
    ...(INSTRUCTIONS ? { instructions: INSTRUCTIONS } : {}),
  } }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS_ON.concat([...sbag(sid).values()].map((e) => ({ name: e.tool, description: e.description, inputSchema: e.rawSchema ?? e.schema }))) } }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'resources/list') {
    try { return { jsonrpc: '2.0', id, result: { resources: await resourcesList() } } }
    catch (err) { return { jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } } }
  }
  if (method === 'resources/templates/list') {
    try { return { jsonrpc: '2.0', id, result: { resourceTemplates: await resourceTemplatesList() } } }
    catch (err) { return { jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } } }
  }
  if (method === 'resources/read') {
    try { return { jsonrpc: '2.0', id, result: await resourceRead(params?.uri) } }
    catch (err) { return { jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } } }
  }
  if (method === 'tools/call') {
    const name = params?.name, a = params?.arguments ?? {}
    // 调用方对话 id（可选）：宿主侧插件放在 params._meta 里。用来把说明书投递去重
    // 的粒度从「MCP 连接」细化到「连接 + 对话」，见 declBag 的注释。
    // 只在长度合理时采纳，避免被任意超长串撑大缓存键。
    const convoRaw = params?._meta?.[CONVO_META_KEY]
    const convo = typeof convoRaw === 'string' && convoRaw.length > 0 && convoRaw.length <= 200 ? convoRaw : void 0
    if (TOOLS_OFF.has(name)) return { jsonrpc: '2.0', id, result: { content: [text('Unknown aggregator tool "' + name + '".')], isError: true } }
    try {
      // 2026-11-16 用户定：catalog 是「选工具」的目录，**不做任何去重** —— 每次调用都全量回，
      // 否则模型看不到候选项就可能选错或放弃。字节浪费认，识别错误不认。
      if (name === 'catalog') return { jsonrpc: '2.0', id, result: { content: [text(await catalogText(a))] } }
      if (name === 'describe') return { jsonrpc: '2.0', id, result: { content: [text(await describeText(a, sid, convo))] } }
      if (name === HUB_NAME) return { jsonrpc: '2.0', id, result: { content: [text(await hubText(a, sid))] } }
      if (sbag(sid).has(name)) return { jsonrpc: '2.0', id, result: await callTool({ tool: sbag(sid).get(name).server + '.' + name, arguments: a }, sid, void 0, convo) }
      if (name === 'call') return { jsonrpc: '2.0', id, result: await callTool(a, sid, void 0, convo) }
      if (name === 'batch') return { jsonrpc: '2.0', id, result: await batchTools(a, sid, convo) }
      return { jsonrpc: '2.0', id, result: { content: [text('Unknown aggregator tool "' + name + '".')], isError: true } }
    } catch (err) {
      return { jsonrpc: '2.0', id, result: { content: [text('ERROR: ' + String(err?.message ?? err))], isError: true } }
    }
  }
  if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } }
  return null
}

// ---- transport: stdio (default) ----
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const t = line.trim(); if (!t) return
  let msg; try { msg = JSON.parse(t) } catch { return }
  if (msg.id === undefined) return
  handleMsg(msg)
    .then((res) => { if (res) send(res) })
    .catch((e) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } }))
})

// ---- transport: Streamable HTTP on 127.0.0.1 (set AGG_HTTP_PORT to enable) ----
const HTTP_PORT = Number(process.env.AGG_HTTP_PORT ?? 0)
const SESSION_ID = 'agg-' + process.pid + '-' + Date.now()
let lastMissingSessionLog = 0
let lastUnauthorizedLog = 0
if (HTTP_PORT > 0) {
  const { createServer } = await import('node:http')
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname === '/health' && req.method === 'GET') {
      if (AUTH_HEALTH_REQUIRED && !authorized(req)) {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        res.end('{"ok":false,"error":"unauthorized"}')
        return
      }
      const health = healthSnapshot()
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(health, null, 2))
      return
    }
    if (pathname !== '/mcp') { res.writeHead(404).end(); return }
    if (!authorized(req)) {
      if (Date.now() - lastUnauthorizedLog > 60000) {
        lastUnauthorizedLog = Date.now()
        log('warning: rejected request without valid bearer token')
      }
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      res.end('{"jsonrpc":"2.0","error":{"code":-32001,"message":"unauthorized"}}')
      return
    }
    if (req.method === 'GET') {
      const acc = String(req.headers.accept || '')
      if (acc.indexOf('text/event-stream') >= 0) {
        const requestedSid = String(req.headers['mcp-session-id'] || '')
        const sid = requestedSid || SESSION_ID
        if (ENFORCE_SESSION && (!requestedSid || !SESSIONS.has(requestedSid))) {
          res.writeHead(404, { 'content-type': 'application/json', 'mcp-session-id': sid })
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'session expired: re-initialize (missing/unknown mcp-session-id)' } }))
          return
        }
        touchSession(sid)
        // B: 实现 server->client 的 SSE 长连接（MCP Streamable HTTP 的 GET 通道）
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'mcp-session-id': sid })
        res.write(': connected\n\n')
        if (!SSE_CLIENTS.has(sid)) SSE_CLIENTS.set(sid, new Set())
        SSE_CLIENTS.get(sid).add(res)
        if (process.env.AGG_TRACE) log('GET sse stream opened session=' + sid.slice(0, 24) + ' streams=' + SSE_CLIENTS.get(sid).size)
        const ka = setInterval(function () { try { res.write(': ka\n\n') } catch (e) {} }, 20000)
        req.on('close', function () {
          clearInterval(ka)
          const streams = SSE_CLIENTS.get(sid)
          streams?.delete(res)
          if (streams && streams.size === 0) SSE_CLIENTS.delete(sid)
          if (process.env.AGG_TRACE) log('GET sse stream closed session=' + sid.slice(0, 24) + ' streams=' + (streams?.size ?? 0))
        })
        return
      }
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, GET' })
      res.end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"send accept: text/event-stream to open the SSE channel"}}')
      return
    }
    if (req.method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] || '')
      if (sid) cleanupSessionState(sid)
      res.writeHead(200).end()
      return
    }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end('{"jsonrpc":"2.0","error":{"code":-32600,"message":"request body too large"}}')
        req.destroy()
        return
      }
      chunks.push(chunk)
    }
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"}}')
      return
    }
    if (process.env.AGG_TRACE) log('POST ' + (Array.isArray(body) ? '[batch]' : String(body && body.method) + ':' + String((body && body.params && body.params.name) || '')) + ' accept=' + String(req.headers.accept || '-'))
    const batch = Array.isArray(body)
    const __isInit = !batch && body && body.method === 'initialize'
    const __hdrSess = String(req.headers['mcp-session-id'] || '')
    let __sid = SESSION_ID
    if (__hdrSess.length > 256) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body && body.id, error: { code: -32600, message: 'invalid mcp-session-id' } }))
      return
    }
    if (__isInit) {
      __sid = newSessionId()
    } else if (__hdrSess) {
      if (SESSIONS.has(__hdrSess)) __sid = __hdrSess
      else {
        if (process.env.AGG_TRACE) log('stale session ' + __hdrSess + ' (known=' + SESSIONS.size + ') ' + (ENFORCE_SESSION ? '-> 404 re-initialize' : '-> served anyway'))
        if (ENFORCE_SESSION) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body && body.id, error: { code: -32001, message: 'session expired: re-initialize (missing/unknown mcp-session-id)' } }))
          return
        }
        __sid = __hdrSess
      }
    } else if (ENFORCE_SESSION) {
      res.writeHead(404, { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body && body.id, error: { code: -32001, message: 'session expired: re-initialize (missing mcp-session-id)' } }))
      return
    } else if (Date.now() - lastMissingSessionLog > 60000) {
      lastMissingSessionLog = Date.now()
      log('warning: non-initialize request without mcp-session-id; using shared fallback session')
    }
    if (process.env.AGG_TRACE && __isInit) log('initialize -> session ' + __sid)
    const out = []
    for (const msg of batch ? body : [body]) {
      if (msg?.id === undefined) continue           // notification: swallow
      try { const r = await handleMsg(msg, __sid); if (r) out.push(r) }
      catch (e) { out.push({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } }) }
    }
    touchSession(__sid)
    const headers = { 'content-type': 'application/json', 'mcp-session-id': __sid }
    if (out.length === 0) { res.writeHead(202, headers).end(); return }
    const wantsSSE = String(req.headers.accept || '').indexOf('text/event-stream') >= 0
    const changed = HUB_CHANGED.has(sidOf(__sid))
    if (changed) HUB_CHANGED.delete(sidOf(__sid))
    if (process.env.AGG_TRACE && !wantsSSE) log('no sse accept, accept=' + String(req.headers.accept || '-'))
    if (wantsSSE && changed) {
      if (process.env.AGG_TRACE) log('SSE notify sent (tools/list_changed)')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': __sid })
      res.write('data: ' + JSON.stringify(batch ? out : out[0]) + '\n\n')
      res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n\n')
      res.end()
      return
    }
    if (changed) notifyListChanged(__sid)
    res.writeHead(200, headers)
    res.end(JSON.stringify(batch ? out : out[0]))
  })
  server.listen(HTTP_PORT, '127.0.0.1', () => log('HTTP listening on 127.0.0.1:' + HTTP_PORT + '/mcp'))
}

// ---- lifecycle ----
// A stray rejection is recoverable, but an uncaught exception means process state is not
// trustworthy. Exit and let systemd (Restart=always) rebuild the whole MCP surface.
process.on('unhandledRejection', (e) => log('unhandledRejection:', String(e?.stack ?? e)))
process.on('uncaughtException', (e) => {
  log('uncaughtException:', String(e?.stack ?? e))
  shutdown(1)
})

let shuttingDown = false
async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  const exitCode = Number.isInteger(code) ? code : 0
  const forceExit = setTimeout(() => process.exit(exitCode), 5000)
  for (const c of conns.values()) {
    clearRetryTimer(c)
    try { await c.client?.close() } catch {}
  }
  clearTimeout(forceExit)
  process.exit(exitCode)
}
if (HTTP_PORT <= 0) process.stdin.on('end', shutdown)   // HTTP 模式下 stdin 关掉不算退出
process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))

