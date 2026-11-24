#!/usr/bin/env node
// MCP aggregator self-test — asserts the design contract in ~/.dsh/skills/mcp-optimizer/SKILL.md
// Usage: node selftest.mjs [--json] [--url http://127.0.0.1:8877/mcp]
import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const URL = (() => { const i = argv.indexOf('--url'); return i >= 0 ? argv[i + 1] : (process.env.AGG_URL || 'http://127.0.0.1:8877/mcp') })()
const AS_JSON = argv.includes('--json')

const AGG_DIR = process.env.AGG_DIR || (process.env.HOME + '/.dsh/mcp-servers/mcp-aggregator')
let CFG = {}
try { CFG = JSON.parse(readFileSync(AGG_DIR + '/servers.json', 'utf8')) } catch {}
const HUB = CFG.hub ?? {}
const AUTH_TOKEN = (() => {
  if (CFG.auth?.enabled !== true) return ''
  const raw = String(CFG.auth.token ?? '')
  const m = raw.match(/^\$\{file:(.+)\}$/)
  if (!m) return raw
  const p = m[1].startsWith('~') ? process.env.HOME + m[1].slice(1) : m[1]
  try { return readFileSync(p, 'utf8').trim() } catch { return '' }
})()
const BUD = {
  catalog: Number(HUB.catalogBudgetBytes ?? 6000),
  index: Number(HUB.indexBudgetBytes ?? 6000),
  full: Number(HUB.fullBudgetBytes ?? 12288),
  decl: Number(HUB.firstCallDeclBudgetBytes ?? 4096),
  declBatch: Number(HUB.firstCallDeclBatchBytes ?? 8192),
}
const ENFORCE = CFG.enforceSession !== false
// describe 不是硬门（hub.strictFlow 默认 false）：没 describe 也照常派发，并在 content 末尾
// 带回与 describe 同构的说明书（hub.firstCallDecl）。自测默认模拟「合规调用方」（先 describe），
// 首调投递由 E1–E8 用 noDescribe 显式覆盖。
const STRICT_FLOW = HUB.strictFlow === true
const DESCRIBED = new Set()   // 本 session 已 describe 过的 "server.tool" / "server.tool#op:x"

let sid = null
let idseq = 0
const checks = []
const add = (id, name, pass, detail) => { checks.push({ id, name, pass: pass === null ? 'SKIP' : (pass ? 'PASS' : 'FAIL'), detail: String(detail ?? '') }) }
const B = (s) => Buffer.byteLength(String(s ?? ''))

async function rpc(method, params, opts = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(AUTH_TOKEN ? { authorization: 'Bearer ' + AUTH_TOKEN } : {}),
  }
  const useSid = 'sid' in opts ? opts.sid : sid
  if (useSid) headers['mcp-session-id'] = useSid
  const t0 = performance.now()
  const res = await fetch(URL, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++idseq, method, params }) })
  const h = res.headers.get('mcp-session-id')
  if (h && !('sid' in opts)) sid = h
  const raw = await res.text()
  const ms = Math.round(performance.now() - t0)
  let msg = null
  try { msg = JSON.parse(raw) } catch {
    for (const line of raw.split('\n')) {
      const m = line.match(/^data: (\{.*\})\s*$/)
      if (m) { try { msg = JSON.parse(m[1]); break } catch {} }
    }
  }
  return { status: res.status, msg, raw, ms, bytes: B(raw), sid: h }
}

async function toolsCall(name, args, opts = {}) {
  if (name === 'call' && !opts.noDescribe) {
    const ref = String(args?.tool ?? '')
    // 用整份 describe（覆盖该工具全部 op）——窄分支只对合法 op 名生效，
    // 而自测里 P3 故意传非法 enum，必须走到预检而不是被流程门禁挡住。
    if (!DESCRIBED.has(ref)) {
      await rpc('tools/call', { name: 'describe', arguments: { tool: ref } })
      DESCRIBED.add(ref)
    }
  }
  const r = await rpc('tools/call', { name, arguments: args })
  const res = r.msg?.result
  const content = res?.content ?? []
  return {
    text: content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    blocks: content.length,
    isError: res?.isError === true,
    ms: r.ms, status: r.status,
    err: r.msg?.error,
    bytes: B(content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')),
    // 首调投递：说明书固定在 content 末尾单独一块，content[0] 永远是下游真结果
    first: content.length ? String(content[0]?.text ?? '') : '',
    decl: (content.length > 1 && /^\[说明书·自动补发\]/.test(String(content[content.length - 1]?.text ?? ''))) ? String(content[content.length - 1].text) : '',
    declB: (content.length > 1 && /^\[说明书·自动补发\]/.test(String(content[content.length - 1]?.text ?? ''))) ? B(String(content[content.length - 1].text)) : 0,
  }
}

async function newSession() {
  sid = null
  DESCRIBED.clear()   // 严格流程按会话记 describe，换会话就得重来
  const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agg-selftest', version: '1' } })
  return r
}

function journalSince(iso) {
  try {
    return execSync('journalctl --user -u mcp-aggregator --since "' + iso + '" -o cat --no-pager', { encoding: 'utf8', maxBuffer: 8 << 20 })
  } catch (e) { return '' }
}
function parseBatchLog(text) {
  const all = text.split('\n')
  let cut = 0
  all.forEach((l, i) => { if (/batch start: \d+ call/.test(l)) cut = i })   // 只看最近一次 batch 的日志
  const rows = []
  for (const line of all.slice(cut)) {
    const m = line.match(/batch #(\d+) (\S+) (start|end)\s+\+\s*(\d+)ms/)
    if (m) rows.push({ n: +m[1], server: m[2], phase: m[3], t: +m[4] })
  }
  return rows
}

// ---------------------------------------------------------------- static face
async function faceChecks() {
  const r = await newSession()
  const tl = await rpc('tools/list', {})
  const tools = tl.msg?.result?.tools ?? []
  const names = tools.map((t) => t.name)
  const base = ['catalog', 'describe', 'call', 'batch', 'load']
  const want = base.filter((n) => HUB[n] !== false)
  const off = base.filter((n) => HUB[n] === false)
  add('F1', 'tools/list = 配置启用的入口（' + want.join('/') + (off.length ? '，已关: ' + off.join(',') : '') + '）',
    names.length === want.length && want.every((n) => names.includes(n)) && !off.some((n) => names.includes(n)), 'got: ' + names.join(','))
  if (off.length) {
    const dis = await toolsCall(off[0], off[0] === 'batch' ? { calls: [] } : {})
    add('F7', '被关掉的入口 ' + off[0] + ' 不可调用（tools/list 与调度都拒）',
      /Unknown aggregator tool/.test(dis.text) && dis.isError === true, dis.text.slice(0, 80))
  }
  const instr = r.msg?.result?.instructions
  add('F2', 'instructions ≤ 32768 B', !instr || B(instr) <= 32768, 'instructions B=' + (instr ? B(instr) : 0))
  const bad = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object' || !t.inputSchema.properties)
  add('F3', '每个工具都有 object inputSchema + properties', bad.length === 0, bad.map((t) => t.name).join(','))
  add('F6', 'tools/list 里各入口的描述可达（非空）', tools.every((t) => (t.description ?? '').length > 40), tools.map((t) => t.name + ':' + (t.description ?? '').length).join(' '))
  const batch = tools.find((t) => t.name === 'batch')
  if (batch) {
    const calls = batch.inputSchema?.properties?.calls
    add('F4', 'batch.calls = array(required tool) 且 calls 必填',
      !!(calls && calls.type === 'array' && calls.items?.required?.includes('tool') && batch.inputSchema.required?.includes('calls')),
      JSON.stringify({ type: calls?.type, itemReq: calls?.items?.required, req: batch?.inputSchema?.required }))
  } else {
    add('F4', 'batch 已关闭，跳过其 schema 检查', null, 'hub.batch=false')
  }
  add('F5', 'initialize 返回 mcp-session-id', !!r.sid, 'sid=' + String(r.sid).slice(0, 24))
}

// ---------------------------------------------------------------- catalog
async function catalogChecks() {
  let ov = await toolsCall('catalog', {})
  for (let i = 0; i < 20; i++) {
    const m = ov.text.match(/MCP aggregator: \d+ tools on (\d+)\/(\d+) servers/)
    if (m && m[1] === m[2]) break
    await new Promise((resolve) => setTimeout(resolve, 250))
    ov = await toolsCall('catalog', {})
  }
  const m = ov.text.match(/MCP aggregator: (\d+) tools on (\d+)\/(\d+) servers/)
  const serverLines = ov.text.split('\n').filter((l) => /^- \w[\w-]*: /.test(l))
  const sum = serverLines.map((l) => +(l.match(/: (\d+)(?: cached)? tools/) || [])[1] || 0).reduce((a, b) => a + b, 0)
  add('C1', 'catalog() 服务概览：总数 = 各 server 之和、16/16 available',
    !!m && +m[1] === sum && m[2] === m[3], m ? ('header ' + m[1] + ' tools / ' + m[2] + '/' + m[3] + ', sum=' + sum + ', B=' + ov.bytes) : ov.text.slice(0, 120))

  const alias = await toolsCall('catalog', { query: '截图' })
  const first = alias.text.split('\n').find((l) => /^[\w-]+\.[\w.-]+\(/.test(l)) || ''
  add('C2', '别名提权：catalog({query:"截图"}) 首行是 screenshot 工具', /screenshot/i.test(first), first.slice(0, 120))

  const alias2 = await toolsCall('catalog', { query: '手机' })
  const first2 = alias2.text.split('\n').find((l) => /^[\w-]+\.[\w.-]+\(/.test(l)) || ''
  add('C3', '别名提权：catalog({query:"手机"}) 首行是 dshlink.*', /dshlink\./.test(first2), first2.slice(0, 120))

  const fmt = await toolsCall('catalog', { query: 'pdf read' })
  const lines = fmt.text.split('\n').filter((l) => /^(?:\[[^\]]*\]\s*)?[\w-]+\.[\w.-]+\(/.test(l))
  const okFmt = lines.length > 0 && lines.every((l) => /\) — .+｜用法: /.test(l))
  const descTooLong = lines.filter((l) => { const d = l.split(' — ')[1] || ''; return d.length > 150 })
  add('C4', 'catalog 行格式 = server.tool(必填签名) — fn ｜用法: when，desc ≤150 字符',
    okFmt && descTooLong.length === 0, 'lines=' + lines.length + ' bad=' + descTooLong.length + ' e.g. ' + (lines[0] || '').slice(0, 130))

  const big = await toolsCall('catalog', { query: 'e', limit: 999 })
  add('C5', 'catalog 整段 ≤ catalogBudgetBytes(' + BUD.catalog + ' B) 且超预算有截断提示',
    big.bytes <= BUD.catalog + 200 && (big.bytes <= BUD.catalog || /预算截断/.test(big.text)),
    'B=' + big.bytes + ' budget=' + BUD.catalog + ' truncated=' + /预算截断/.test(big.text))

  const sig = await toolsCall('catalog', { query: 'lceda_batch' })
  const sigLine = sig.text.split('\n').find((l) => l.includes('lceda_batch')) || ''
  add('C6', '长 schema 签名只列必填+≤6 可选并折叠为 +N', /\+\d+\)/.test(sigLine), sigLine.slice(0, 160))

  const noSrv = await toolsCall('catalog', { server: 'nosuchserver' })
  add('C7', 'catalog 未知 server → 明确报错并列出已挂载', /Unknown server/.test(noSrv.text) && /Mounted:/.test(noSrv.text), noSrv.text.slice(0, 100))
  const noHit = await toolsCall('catalog', { query: 'zzzz_no_such_tool_zzzz' })
  add('C8', 'catalog 无命中 → 明确提示改查', /No tool matched/.test(noHit.text), noHit.text.slice(0, 100))
  const oneSrv = await toolsCall('catalog', { server: 'pdf' })
  add('C9', 'catalog({server}) 只列该 server', /- pdf: \d+ tools/.test(oneSrv.text) && !/- github: /.test(oneSrv.text), oneSrv.text.split('\n')[1] || '')
}

async function discoveryChecks() {
  let cases = []
  try {
    const parsed = JSON.parse(readFileSync(AGG_DIR + '/discovery-eval.json', 'utf8'))
    cases = Array.isArray(parsed.cases) ? parsed.cases : []
  } catch (e) {
    add('Q0', 'discovery-eval.json 可读取', false, String(e.message))
    return
  }
  add('Q0', 'discovery-eval.json 含测试用例', cases.length >= 10, 'cases=' + cases.length)
  let top1 = 0
  for (const [index, item] of cases.entries()) {
    const r = await toolsCall('catalog', { query: item.query, limit: 8 })
    const refs = r.text.split('\n')
      .map((line) => (line.match(/^(?:\[[^\]]*\]\s*)?([\w-]+\.[\w.-]+)\(/) || [])[1])
      .filter(Boolean)
    const accepted = new Set(item.accept ?? [])
    const pass = refs.slice(0, 5).some((ref) => accepted.has(ref))
    if (accepted.has(refs[0])) top1++
    add('Q' + (index + 1), 'discovery: ' + item.query, pass,
      'top=' + refs.slice(0, 5).join(', '))
  }
  add('Q99', 'discovery top-1 汇总', top1 >= Math.ceil(cases.length * 0.7), top1 + '/' + cases.length)
}

// ---------------------------------------------------------------- describe
async function describeChecks() {
  const d = await toolsCall('describe', { tool: 'pdf.read_pdf' })
  // 契约（2026-11-22 用户指定）：describe = 可选 [红线] + 整份 [schema]；不再发参数契约/章节索引/#schema 指针
  const hasRed = /^\[红线\] pdf\.read_pdf/.test(d.text.trim())
  const schemaLine = (d.text.split('[schema] pdf.read_pdf')[1] || '').trim()
  let schemaOk = false, schemaProps = []
  try { const sc = JSON.parse(schemaLine); schemaOk = sc.type === 'object'; schemaProps = Object.keys(sc.properties ?? {}) } catch {}
  add('D1', 'describe = 可选[红线] + 整份 [schema]（合法 JSON schema；无参数契约/章节/指针）',
    schemaOk && schemaProps.includes('file_path')
      && !/\[参数表\]|\[参数\]/.test(d.text) && !/\[手册章节\]/.test(d.text) && !/#schema"\)/.test(d.text),
    'B=' + d.bytes + ' 红线=' + hasRed + ' schema合法=' + schemaOk + ' props=' + schemaProps.length)

  const raw = await toolsCall('describe', { tool: 'pdf.read_pdf#schema' })
  let rawOk = false, req = []
  try { const sc = JSON.parse(raw.text.replace(/^[\s\S]*?parameters:\n/, '')); rawOk = sc.type === 'object' && Array.isArray(sc.required); req = sc.required } catch {}
  add('D1b', '#schema 窄分支 = 唯一原始 JSON 入口（含 required）',
    rawOk && req.includes('file_path'), 'B=' + raw.bytes + ' req=' + req.join(','))

  const man = await toolsCall('describe', { tool: 'lceda-tools.lceda_batch' })
  add('D2', '整份 describe 不再内联章节索引（章节只由 #<章> 路径提供，见 D3）',
    !/\[手册章节\]/.test(man.text) && /\[schema\] lceda-tools\.lceda_batch/.test(man.text),
    'B=' + man.bytes + ' 章节=' + /\[手册章节\]/.test(man.text))

  const chap = await toolsCall('describe', { tool: 'lceda-tools.lceda_batch#op:wire' })
  add('D3', 'describe(...#章节) 只回单章（≤1200 B，仍带索引）',
    chap.bytes <= 1200 && /\[手册章节\]/.test(chap.text) && /op:wire/.test(chap.text), 'B=' + chap.bytes)

  const bad = await toolsCall('describe', { tool: 'lceda-tools.lceda_batch#no:such' })
  add('D4', 'describe 不存在的章 → 明确提示 + 索引', /no section/.test(bad.text), bad.text.slice(0, 80))

  const unk = await toolsCall('describe', { tool: 'no.such_tool' })
  add('D5', 'describe 未知工具 → "Unknown tool … call catalog first"', /Unknown tool/.test(unk.text), unk.text.slice(0, 80))

  const typo = await toolsCall('describe', { tool: 'pdf.read_pdff' })
  add('D6', 'describe 工具名拼写错误 → 返回最近工具', /Nearest tool names/.test(typo.text) && /pdf\.read_pdf/.test(typo.text), typo.text.slice(0, 140))
}

// ---------------------------------------------------------------- call: preflight
async function preflightChecks() {
  await newSession()
  const miss = await toolsCall('call', { tool: 'pdf.read_pdf', arguments: {} })
  add('P1', '缺必填 → 拦下不派发（回说明书写「缺少必填参数」）',
    miss.isError && /\[参数校验失败，未派发\]/.test(miss.text) && /缺少必填参数: file_path/.test(miss.text) && !/ENOENT|not found|Error executing/i.test(miss.text),
    'ms=' + miss.ms + ' B=' + miss.bytes)

  const unkKey = await toolsCall('call', { tool: 'pdf.read_pdf', arguments: { file_path: '/tmp/x.pdf', bogus_probe: 1 } })
  add('P2', '未知参数（additionalProperties:false）→ 拦下不派发',
    unkKey.isError && /未知参数/.test(unkKey.text) && /bogus_probe/.test(unkKey.text), 'ms=' + unkKey.ms)

  const badEnum = await toolsCall('call', { tool: 'lceda-tools.lceda_text', arguments: { action: 'nope' } })
  add('P3', 'enum 越界 → 拦下不派发并列出合法值',
    badEnum.isError && /不在 enum/.test(badEnum.text) && /list\/create\/set/.test(badEnum.text), badEnum.text.split('\n')[0].slice(0, 140))

  // 预检拦下时不应有下游往返：同一工具真派发 vs 被拦下的耗时对比（pdf 真读一页 ≈100 ms 级）
  await newSession()
  const real = await toolsCall('call', { tool: 'pdf.read_pdf', arguments: { file_path: '/home/isanzi/work/datasheets/snoa549.pdf', mode: 'text_only', pages: '1' } })
  add('P4', '预检拦下是本地回复（无下游往返）：被拦 < 真派发耗时的 1/3',
    miss.ms * 3 < real.ms + 3, 'blocked=' + miss.ms + 'ms real=' + real.ms + 'ms realB=' + real.bytes + ' realIsError=' + real.isError)
}

// ---------------------------------------------------------------- call: 首调投递 / 去重
async function declChecks() {
  // 未 describe 首调：照常派发 + 末尾带回「与 describe 同构」的说明书
  await newSession()
  const a = await toolsCall('call', { tool: 'dshlink.status', arguments: {} }, { noDescribe: true })
  const desc = await toolsCall('describe', { tool: 'dshlink.status' })
  add('E1', '未 describe 首调：content[0]=真结果，末尾单独一块=说明书（不污染 content[0]）',
    !a.isError && a.blocks === 2 && /^\[说明书·自动补发\]/.test(a.decl) && !/\[判据\]/.test(a.first),
    'blocks=' + a.blocks + ' declB=' + a.declB + ' firstHasNote=' + /\[判据\]/.test(a.first))
  const declSchema = (a.decl.split('[schema] dshlink.status')[1] || '').trim()
  let declSchemaOk = false
  try { declSchemaOk = JSON.parse(declSchema).type === 'object' } catch {}
  add('E2', '首调补发与 describe 同构（可选[红线] + 整份 [schema]，无参数契约/指针）',
    /\[schema\] dshlink\.status/.test(a.decl) && declSchemaOk
      && !/\[参数表\]|\[参数\]/.test(a.decl) && !/#schema"\)/.test(a.decl),
    'declB=' + a.declB + ' schema合法=' + declSchemaOk + ' budget=' + BUD.decl)

  const b = await toolsCall('call', { tool: 'dshlink.status', arguments: {} }, { noDescribe: true })
  add('E3', '同工具第二次调用不再重复投递（blocks=1）', b.blocks === 1 && !b.decl, 'blocks=' + b.blocks + ' declB=' + b.declB)
  const dup = (a.decl.match(/\[schema\] dshlink\.status/g) || []).length
  add('E4', '说明书主体（[schema] 段）只出现一次', dup === 1, '[schema] x' + dup)

  // 最大件（jlceda-native.pcb_document_action ≈ 47 KB schema）：新契约整份内联，用上限护栏盯住成本。
  // 注：首调路径无法安全测（会真派发下游动作），故测 describe 侧——补发与它同构（E2 已验）。
  await newSession()
  const huge = await toolsCall('describe', { tool: 'jlceda-native.pcb_document_action' })
  const hugeBody = (huge.text.split('[schema] jlceda-native.pcb_document_action')[1] || '').trim()
  let hugeOk = false
  try { hugeOk = JSON.parse(hugeBody).type === 'object' } catch {}
  add('E5', '最大件 describe：整份 [schema] 可解析且 ≤ 64 KB（新契约成本护栏）',
    hugeOk && huge.bytes <= 65536, 'B=' + huge.bytes + ' 可解析=' + hugeOk)

  // 报错路径：isError 透传，说明书照样带回（不再依赖 structuredContent，宿主丢不掉）
  await newSession()
  const err = await toolsCall('call', { tool: 'pdf.read_pdf', arguments: { file_path: '/tmp/missing-selftest.pdf' } }, { noDescribe: true })
  add('E6', '下游报错：isError 透传 + 说明书仍随结果带回',
    err.isError && err.blocks === 2 && err.declB > 0, 'isError=' + err.isError + ' blocks=' + err.blocks + ' declB=' + err.declB)

  // 已 describe 过 ⇒ call 不再投递
  await newSession()
  const d0 = await toolsCall('call', { tool: 'dshlink.status', arguments: {} })   // 客户端先 describe
  add('E7', 'describe 过的工具：call 不再投递（零重复）', d0.blocks === 1 && !d0.decl, 'blocks=' + d0.blocks + ' declB=' + d0.declB)

  // 参数预检拦截：说明书只出现一次（预检提示自身带说明，别叠两份）
  await newSession()
  const pre = await toolsCall('call', { tool: 'pdf.read_pdf', arguments: {} }, { noDescribe: true })
  add('E8', '参数预检拦截：isError 且判据块最多出现一次',
    pre.isError && (pre.text.match(/\[判据\] pdf\.read_pdf/g) || []).length <= 1,
    'isError=' + pre.isError + ' blocks=' + pre.blocks + ' note x' + (pre.text.match(/\[判据\]/g) || []).length)
}

// ---------------------------------------------------------------- batch
async function batchChecks() {
  if (HUB.batch === false) {
    add('B0', 'batch 已在 servers.json 关闭（hub.batch=false）⇒ 相关检查跳过', null,
      '恢复：把 hub.batch 改成 true 再重启')
    return
  }
  await newSession()
  const since = new Date(Date.now() - 500).toISOString()
  const r = await toolsCall('batch', { calls: [
    { tool: 'dshlink.status', arguments: {}, label: 'dshlink' },
    { tool: 'lceda-tools.lceda_status', arguments: {}, label: 'lceda' },
    { tool: 'pdf.read_pdf', arguments: { file_path: '/tmp/missing-selftest.pdf' }, label: 'pdf' },
    { tool: 'jlceda.pcb_ping', arguments: {}, label: 'jlceda' },
  ] })
  await new Promise((r2) => setTimeout(r2, 400))
  const rows = parseBatchLog(journalSince(since))
  const starts = rows.filter((x) => x.phase === 'start')
  const spread = starts.length ? Math.max(...starts.map((x) => x.t)) - Math.min(...starts.map((x) => x.t)) : -1
  add('B1', 'batch 跨 server 并发（首个 start 时间戳跨度 < 150 ms）', starts.length >= 3 && spread < 150,
    'servers=' + starts.map((x) => x.server).join(',') + ' spread=' + spread + 'ms rows=' + rows.length)
  add('B2', 'batch 结果按提交顺序分段（[1]..[4] 全在）',
    [1, 2, 3, 4].every((i) => r.text.includes('── [' + i + ']')), 'B=' + r.bytes + ' blocks=' + r.blocks)
  add('B3', '逐调用错误不置顶层 isError、不影响其他调用', r.isError === false && /── \[1\] dshlink/.test(r.text) && /ERROR|参数校验失败|Error/i.test(r.text), 'isError=' + r.isError)

  await newSession()
  const since2 = new Date(Date.now() - 500).toISOString()
  await toolsCall('batch', { calls: [
    { tool: 'dshlink.status', arguments: {}, label: 'a' },
    { tool: 'dshlink.status', arguments: {}, label: 'b' },
    { tool: 'dshlink.status', arguments: {}, label: 'c' },
  ] })
  await new Promise((r2) => setTimeout(r2, 400))
  const rows2 = parseBatchLog(journalSince(since2)).filter((x) => x.server === 'dshlink')
  const seq = rows2.filter((x) => x.phase === 'start').map((x) => x.t)
  const ends = rows2.filter((x) => x.phase === 'end').map((x) => x.t)
  const okSeq = seq.length === 3 && ends.length === 3 && seq[1] >= ends[0] - 2 && seq[2] >= ends[1] - 2
  add('B4', 'batch 同 server 串行（start[n+1] ≥ end[n]）', okSeq, 'starts=' + seq.join(',') + ' ends=' + ends.join(','))

  const empty = await toolsCall('batch', { calls: [] })
  add('B5', 'batch 空 calls → 明确报错', empty.isError && /pass calls/.test(empty.text), empty.text.slice(0, 90))

  const tooMany = await toolsCall('batch', { calls: Array.from({ length: 65 }, () => ({ tool: 'dshlink.status', arguments: {} })) })
  add('B6', 'batch >64 调用 → 明确报错并要求拆分', tooMany.isError && /exceeds the limit/.test(tooMany.text), tooMany.text.slice(0, 90))

  const unk = await toolsCall('batch', { calls: [
    { tool: 'no.such_tool', arguments: {}, label: 'bad' },
    { tool: 'dshlink.status', arguments: {}, label: 'good' },
  ] })
  add('B7', 'batch 未知工具标记 UNRESOLVED 且不影响其他调用',
    /\[UNRESOLVED\]/.test(unk.text) && /── \[2\] good/.test(unk.text) && unk.isError === false, 'B=' + unk.bytes)

  await newSession()
  const dupInBatch = await toolsCall('batch', { calls: [
    { tool: 'dshlink.status', arguments: {}, label: 'first' },
    { tool: 'dshlink.status', arguments: {}, label: 'second' },
  ] })
  const declHits = (dupInBatch.text.match(/\[必填\] dshlink\.status/g) || []).length
  add('B9', 'batch 内同一工具重复调用 → 说明书只回吐一次', declHits <= 1, '[必填] x' + declHits + '，B=' + dupInBatch.bytes)

  await newSession()
  const heavy = await toolsCall('batch', { calls: [
    { tool: 'lceda-tools.lceda_batch', arguments: {} },
    { tool: 'lceda-tools.lceda_symbol_create', arguments: {} },
    { tool: 'lceda-tools.lceda_footprint_create', arguments: {} },
    { tool: 'github.issue_write', arguments: {} },
    { tool: 'lceda-tools.lceda_text', arguments: {} },
    { tool: 'jlceda.calc_impedance', arguments: {} },
  ] })
  const blocked = (heavy.text.match(/\[参数校验失败，未派发\]/g) || []).length
  add('B8', 'batch 首调说明书合计 ≤ firstCallDeclBatchBytes(8192 B)', heavy.bytes <= 8192 + 400, 'B=' + heavy.bytes + '，预检拦截 ' + blocked + '/6')
}

// ---------------------------------------------------------------- load
async function loadChecks() {
  if (HUB.load === false) {
    add('L0', 'load 已在 servers.json 关闭（hub.load=false）⇒ 相关检查跳过', null,
      '恢复：把 hub.load 改成 true 再重启；工具面按 catalog → describe → call 三入口')
    return
  }
  await newSession()
  const u = await toolsCall('load', {})
  add('L1', 'load({}) 给出用法与 Mounted 清单', /hub: \d+ tools/.test(u.text) && /Mounted:/.test(u.text) && /load\(\{server/.test(u.text), 'B=' + u.bytes)

  const li = await toolsCall('load', { server: 'pdf' })
  add('L2', 'load({server}) 返回一行索引 + 下一步提示', /\[index\] pdf \(1 tools/.test(li.text) && /next: load\(\{tools/.test(li.text), 'B=' + li.bytes)

  const lf = await toolsCall('load', { tools: ['pdf.read_pdf'] })
  add('L3', 'load({tools}) 返回完整声明（判据块在前，≤12288 B）',
    /\[full declaration\] 1 tool\(s\)/.test(lf.text) && /^\[判据\] pdf\.read_pdf/.test(lf.text.replace(/^[^]*?\[full declaration\][^\n]*\n\n/, '').trim()) && lf.bytes <= 12288 + 200,
    'B=' + lf.bytes)

  const dupRef = await toolsCall('load', { tools: ['pdf.read_pdf', 'pdf.read_pdf'] })
  add('L4', 'load 同一工具重复 → 只装一次', /1 tool\(s\)/.test(dupRef.text), dupRef.text.match(/\[full declaration\][^\n]*/)?.[0] || '')

  const over = await toolsCall('load', { server: 'lceda-tools', full: true })
  const declBytes = +((/\[full declaration\] (\d+) tool\(s\), (\d+) B/.exec(over.text) || [])[2] || 0)
  const idxBytes = +((/\[index\] [^(]+\(\d+ tools, (\d+) B\)/.exec(over.text) || [])[1] || 0)
  add('L5', 'load 超 fullBudget → 已装部分 ≤ fullBudget 且余下列入 over budget',
    /over budget, not loaded/.test(over.text) && declBytes <= BUD.full && (idxBytes === 0 || idxBytes <= BUD.index),
    'total B=' + over.bytes + ' index=' + idxBytes + '/' + BUD.index + ' decls=' + declBytes + '/' + BUD.full + ' hasDeclHeader=' + over.text.includes('[full declaration]'))

  const nf = await toolsCall('load', { tools: ['no.such_tool'] })
  add('L6', 'load 未知引用 → not found', /not found: no\.such_tool/.test(nf.text), nf.text.slice(0, 80))

  const l9 = await toolsCall('load', { server: 'lceda-tools', full: true })
  const cutTail = (t) => t.split(/\n(?:oversized|over budget, not loaded|\[preset\]|not found:)/)[0]
  const declPart = cutTail(l9.text.slice(Math.max(0, l9.text.indexOf('[full declaration]'))))
  add('L9', 'load 声明的实际字节 ≤ fullBudget(12288 B)（题头 B 数与真实字节一致）',
    declPart ? B(declPart) <= BUD.full + 300 : false,
    '题头=' + ((/\[full declaration\][^\n]*/.exec(l9.text) || [''])[0]) + ' 实际=' + B(declPart) + ' B')

  await newSession()
  const big = await toolsCall('load', { tools: [
    'jlceda-native.manufacture_export', 'jlceda-native.pcb_board_outline_manage', 'jlceda-native.pcb_component_edit',
    'jlceda-native.pcb_constraints_manage', 'jlceda-native.pcb_document_action', 'jlceda-native.pcb_pour_manage',
    'jlceda-native.pcb_region_manage', 'jlceda-native.pcb_routing_edit', 'jlceda-native.pcb_text_manage',
    'jlceda-native.schematic_document_action',
  ] })
  const stuckN = ((big.text.match(/over budget, not loaded \(call again in batches\): (.*)/) || [])[1] || '').split(',').filter(Boolean).length
  await newSession()
  // 2026-11-12：声明改紧凑打印后 pcb_region_manage 已能整份装下（11,231 B < 12,288），
  // 改用仍超预算的 pcb_document_action（紧凑后 ~50 KB）来覆盖「裁剪声明」这条路径
  const one = await toolsCall('load', { tools: ['jlceda-native.pcb_document_action'] })
  const oneCut = one.text.split(/\n(?:over budget, not loaded|\[preset\]|not found:)/)[0]
  add('L10', '单件超预算的工具能拿到裁剪声明（不再永远装不进来）',
    /\[full declaration\] 1 tool\(s\)/.test(one.text) && /oversized \(truncated/.test(one.text) && B(oneCut) <= BUD.full + 300,
    '单件 B=' + B(one.text) + '，10 个批次里剩 ' + stuckN + ' 个（每个需单独一次 load）')

  const pre = await toolsCall('load', { preset: 'eda' })
  add('L8', 'load({preset:"eda"}) 展开预设工具集（3 个；装不下的列入 over budget）',
    /\[preset\] 1 applied \(eda\), tools expanded: 3/.test(pre.text) && /\[full declaration\] [1-3] tool\(s\)/.test(pre.text),
    (pre.text.match(/\[full declaration\][^\n]*/) || [''])[0] + ' | ' + (pre.text.match(/\[preset\][^\n]*/) || [''])[0])

  const t1 = await toolsCall('load', { tools: ['pdf.read_pdf'] })
  const tl = await rpc('tools/list', {})
  const expectN = ['catalog', 'describe', 'call', 'batch', 'load'].filter((n) => HUB[n] !== false).length
  add('L7', 'promote 默认关闭：load 不改 tools/list（仍 ' + expectN + ' 个工具、无 [promoted]）',
    (tl.msg?.result?.tools ?? []).length === expectN && !/\[promoted\]/.test(t1.text), 'tools=' + (tl.msg?.result?.tools ?? []).length)
}

// ---------------------------------------------------------------- session & resources
async function sessionChecks() {
  await newSession()
  const s1 = await toolsCall('call', { tool: 'dshlink.status', arguments: {} })
  await newSession()
  const s2 = await toolsCall('call', { tool: 'dshlink.status', arguments: {} })
  // 每个新 session 都先 describe，因此不再触发首调投递；跨会话不该泄漏说明书。
  add('S1', '每个新 session 都重新走 describe，首调投递均为 0（无跨会话泄漏）',
    s1.declB === 0 && s2.declB === 0, 'blocks=' + s1.blocks + '/' + s2.blocks + ' declB=' + s1.declB + '/' + s2.declB)

  await newSession()
  const stale = await rpc('tools/call', { name: 'catalog', arguments: {} }, { sid: 'agg-bogus-0-0' })
  const staleOk = ENFORCE ? (stale.status === 404 && stale.msg?.error?.code === -32001) : (stale.status === 200 && !!stale.msg?.result)
  add('S2', '未知 session 行为与 enforceSession=' + ENFORCE + ' 配置一致',
    staleOk, 'status=' + stale.status + (ENFORCE ? ' code=' + stale.msg?.error?.code : '（served anyway，配置关闭了强校验）'))

  const rl = await rpc('resources/list', {})
  add('R1', 'resources/list 不崩（代理下游资源）', rl.status === 200 && !!rl.msg?.result, 'status=' + rl.status + ' resources=' + (rl.msg?.result?.resources?.length ?? 'n/a'))
  const rr = await rpc('resources/read', { uri: 'no-such-uri://x' })
  add('R2', 'resources/read 未知 URI → 结构化错误（不崩服务）', !!rr.msg?.error || !!rr.msg?.result?.contents, JSON.stringify(rr.msg?.error ?? 'ok').slice(0, 90))
}

// ---------------------------------------------------------------- data coverage (informational)
function dataChecks() {
  try {
    const dir = process.env.AGG_DIR || (process.env.HOME + '/.dsh/mcp-servers/mcp-aggregator')
    const s = JSON.parse(readFileSync(dir + '/hub-summary.json', 'utf8'))
    const n = JSON.parse(readFileSync(dir + '/hub-notes.json', 'utf8'))
    const m = JSON.parse(readFileSync(dir + '/hub-manuals.json', 'utf8'))
    const S = s.summary ?? s, N = n.notes ?? n, M = m.manuals ?? m
    add('X1', '数据文件可解析并含条目（summary/notes/manuals）', true,
      'summary=' + Object.keys(S).length + ' notes=' + Object.keys(N).length + ' manuals=' + Object.keys(M).length)
  } catch (e) { add('X1', '数据文件可解析', false, String(e.message)) }
}


const t0 = Date.now()
await faceChecks()
await catalogChecks()
await discoveryChecks()
await describeChecks()
await preflightChecks()
await declChecks()
await batchChecks()
await loadChecks()
await sessionChecks()
dataChecks()

const pass = checks.filter((c) => c.pass === 'PASS').length
const fail = checks.filter((c) => c.pass === 'FAIL').length
const skip = checks.filter((c) => c.pass === 'SKIP').length
if (AS_JSON) {
  console.log(JSON.stringify({ ok: fail === 0, pass, fail, skip, tookMs: Date.now() - t0, checks }, null, 2))
} else {
  for (const c of checks) console.log((c.pass === 'PASS' ? '  ok  ' : c.pass === 'SKIP' ? ' skip ' : ' FAIL ') + c.id.padEnd(3) + ' ' + c.name + (c.detail ? '\n         → ' + c.detail : ''))
  console.log('\n' + pass + ' pass / ' + fail + ' fail / ' + skip + ' skip  (' + ((Date.now() - t0) / 1000).toFixed(1) + 's)')
}
const out = '/tmp/agg-selftest-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'
writeFileSync(out, JSON.stringify({ pass, fail, skip, checks }, null, 2))
if (!AS_JSON) console.log('report: ' + out)
process.exit(fail === 0 ? 0 : 1)
