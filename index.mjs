#!/usr/bin/env node
// MCP aggregator: exposes ONE tiny tool surface over many downstream MCP servers.
// Downstream tool schemas never enter the model context; the model pulls a compact
// catalog on demand and calls tools by name.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const HERE = dirname(fileURLToPath(import.meta.url))
const CFG = JSON.parse(readFileSync(process.env.AGG_CONFIG || join(HERE, 'servers.json'), 'utf8'))
const DESC_WIDTH = CFG.descWidth ?? 84
// hub "load": index + on-demand FULL declarations. Folding stays; you pay only for what you load.
const HUB = CFG.hub ?? {}
const HUB_NAME = String(HUB.name ?? 'load')
const HUB_LINE = Number(HUB.lineWidth ?? 96)
const HUB_INDEX_BUDGET = Number(HUB.indexBudgetBytes ?? 6000)
const HUB_FULL_BUDGET = Number(HUB.fullBudgetBytes ?? 12288)
const CALL_TIMEOUT_MS = CFG.callTimeoutMs ?? 240000
const CONNECT_TIMEOUT_MS = CFG.connectTimeoutMs ?? 90000
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

function withTimeout(p, ms, label) {
  let timer
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout: ' + label)), ms) })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

function connect(name, spec) {
  let entry = conns.get(name)
  if (entry) return entry
  entry = { name, spec, client: null, catalog: new Map(), error: null, ready: null, connected: false }
  conns.set(name, entry)
  entry.ready = (async () => {
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
    const client = new Client({ name: 'mcp-aggregator', version: '1.0.0' }, {
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
    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, name + ' tools/list')
    setCatalog(entry, listed.tools)
    entry.connected = true
    log('connected', name, 'tools=' + entry.catalog.size)
  })().catch((err) => {
    entry.error = String(err?.message ?? err)
    log('connect failed', name, '->', entry.error)
  })
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

async function waitOne(name) {
  const c = conns.get(name)
  if (!c) throw new Error('unknown server "' + name + '"')
  await c.ready
  if (c.error) throw new Error('server "' + name + '" unavailable: ' + c.error)
  return c
}

const allEntries = () => [...conns.values()].flatMap((c) => [...c.catalog.values()])
const sig = (schema) => {
  const props = schema?.properties ?? {}
  const req = new Set(schema?.required ?? [])
  return Object.entries(props).map(([k, v]) => k + (req.has(k) ? '' : '?') + ':' + (v?.type ?? (v?.enum ? 'enum' : v?.anyOf ? 'anyOf' : 'any'))).join(', ')
}
const short = (t, w) => (t.length <= w ? t : t.slice(0, w - 1) + '…')
const norm = (s) => String(s).replace(/^mcp__/, '').replace(/\./g, '__')

// The ONE place that turns a downstream tools/list into the catalog snapshot, so the
// connect-time fill, the list_changed handler and the miss-path refresh cannot diverge.
function setCatalog(entry, tools) {
  entry.catalog.clear()
  for (const t of tools ?? []) {
    entry.catalog.set(t.name, {
      server: entry.name,
      tool: t.name,
      description: (t.description ?? '').replace(/\s+/g, ' ').trim(),
      schema: t.inputSchema ?? { type: 'object', properties: {} },
    })
  }
}

// Safety net for a downstream that grows tools without announcing it: re-list once, only
// on a lookup miss (hot path untouched; concurrent misses share one refresh).
let refreshInFlight = null
function refreshCatalogs() {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const targets = [...conns.values()].filter((c) => c.client && c.connected)
    await Promise.allSettled(targets.map(async (c) => {
      const listed = await withTimeout(c.client.listTools(), PRE_RESOLVE_WAIT_MS, c.name + ' tools/list(refresh)')
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
      + 'Then invoke with call, or read the exact JSON schema with describe.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Keyword(s) matched against tool name and description (case-insensitive).' },
      server: { type: 'string', description: 'Restrict to one server name.' },
      limit: { type: 'number', description: 'Max lines (default 40).' },
    } },
  },
  {
    name: 'describe',
    description: 'Full description and exact JSON parameter schema of one catalogued tool. Use before call when arguments are not obvious (enums, units, required fields).',
    inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'server.tool, mcp__server__tool, or a unique bare tool name.' } }, required: ['tool'] },
  },
  {
    name: 'call',
    description: 'Invoke one catalogued MCP tool and return its result verbatim (text and images). '
      + 'Unfamiliar with a tool description/pitfalls? Call load({tools:["<server>.<tool>"]}) first to pull its full declaration.',
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
    description: 'WARNING: call me BEFORE invoking unfamiliar tools - hub index + on-demand FULL declarations. '
      + 'This aggregator folds every downstream tool into catalog/describe/call/batch, so a bare call() loses the tool description (rules, field semantics, known pitfalls). '
      + 'load({}) = usage; load({server:"lceda-tools"}) = one-line index of that server; '
      + 'load({tools:["lceda-tools.lceda_batch","lceda-tools.lceda_symbol_create"]}) = full description + JSON schema of exactly those; '
      + 'load({server, full:true}) = whole server, budgeted. Zero standing cost: you pay only for what you load.',
    inputSchema: { type: 'object', properties: {
      server: { type: 'string', description: 'Server name, e.g. "lceda-tools". Returns its full one-line index.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'server.tool refs whose FULL declaration you want.' },
      full: { type: 'boolean', description: 'With server: load full declarations for all its tools (subject to budget).' },
      promote: { type: 'boolean', description: 'ALSO install the tool into the live tool face (native call, schema-validated). Costs one full prompt-cache miss per change, then ~per-turn standing schema tokens; only worth it for tools you will call repeatedly. Default false = read-only.' },
      unload: { type: 'boolean', description: 'Remove from the tool face (with tools:[...] or all:true). One more cache miss, then standing cost returns to zero.' },
      all: { type: 'boolean', description: 'With unload: drop every promoted tool.' },
    } },
  },
]

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
    const ready = servers.filter((c) => !c.error)
    const pending = servers.filter((c) => c.error === null && !c.connected)
    const lines = shownServers.map((c) => '- ' + c.name + ': ' + (c.error ? 'UNAVAILABLE (' + c.error + ')' : c.catalog.size + ' tools'))
    const total = ready.reduce((n, c) => n + c.catalog.size, 0)
    return 'MCP aggregator: ' + total + ' tools on ' + ready.length + '/' + servers.length + ' servers'
      + (pending.length ? ' (still starting: ' + pending.map((c) => c.name).join(', ') + ' — call catalog again in a few seconds)' : '')
      + '.\n' + lines.join('\n')
      + '\n\nNext: catalog({query:"<keyword>"}) → call({tool:"server.tool", arguments:{…}}).'
  }
  const hits = []
  for (const c of servers) {
    if (only && c.name.toLowerCase() !== only) continue
    for (const e of c.catalog.values()) {
      const hay = (e.server + ' ' + e.tool + ' ' + e.description).toLowerCase()
      if (!q.split(/\s+/).every((w) => hay.includes(w))) continue
      hits.push(e)
    }
  }
  if (!hits.length) return 'No tool matched "' + a.query + '". Call catalog with no arguments for the server overview.'
  const shown = hits.slice(0, limit)
  return hits.length + ' match(es):\n'
    + shown.map((e) => e.server + '.' + e.tool + '(' + sig(e.schema) + ') — ' + short(e.description, DESC_WIDTH)).join('\n')
    + (hits.length > shown.length ? '\n… ' + (hits.length - shown.length) + ' more; narrow the query or raise limit.' : '')
}

async function describeText(a) {
  let e = resolveTool(a.tool)
  if (!e) await waitAll(PRE_RESOLVE_WAIT_MS)
  if (!e && [...conns.values()].some((c) => !c.connected && !c.error)) {
    await waitAll(Number(CFG.catalogWaitMs ?? 20000))
    e = resolveTool(a.tool)
  }
  if (!e) return 'Unknown tool "' + a.tool + '". Call catalog first.'
  return e.server + '.' + e.tool + '\n\n' + (e.description || '(no description)') + '\n\nparameters:\n' + JSON.stringify(e.schema, null, 2)
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
const SSE_CLIENTS = new Set()   // GET 长连接（server->client 推送通道）
// ---- 会话校验（MCP Streamable HTTP 合规）：initialize 发新 id，后续请求必须携带，未知会话按规范回 404 让客户端重新握手 ----
const ENFORCE_SESSION = CFG.enforceSession !== false
const SESSIONS = new Set()
let SESS_SEQ = 0
const newSessionId = function () { return 'agg-' + process.pid + '-' + (++SESS_SEQ) + '-' + Date.now().toString(36) }
const notifyListChanged = function () {
  let n = 0
  for (const r of SSE_CLIENTS) { try { r.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n\n'); n++ } catch (e) {} }
  if (process.env.AGG_TRACE) log('list_changed pushed to ' + n + ' sse stream(s)')
  return n
}
// ---- hub: 索引 + 按需全量声明（聚合器目标不变，按工具粒度付费） ----
const hubOneLine = (e) => {
  const req = (e.schema?.required ?? []).join(',')
  return e.server + '.' + e.tool + '(' + req + ') — ' + short(String(e.description ?? '').replace(/\s+/g, ' '), HUB_LINE)
}
const hubFull = (e) => e.server + '.' + e.tool
  + '\n' + String(e.description ?? '(no description)')
  + '\n\nparameters:\n' + JSON.stringify(e.schema ?? { type: 'object', properties: {} }, null, 2)

async function hubText(a, sid) {
  const bag = sbag(sid)
  await waitAll(PRE_RESOLVE_WAIT_MS)
  const mounted = [...conns.values()]
  const wantServer = a.server ? String(a.server).trim().toLowerCase() : null
  const wantTools = Array.isArray(a.tools) ? a.tools.map((x) => String(x)) : []
  const full = a.full === true
  if (a.unload === true) {
    const removed = []
    if (a.all === true) { for (const k of [...bag.keys()]) { bag.delete(k); removed.push(k) } }
    else for (const n of wantTools) { const key = String(n).split('.').pop(); if (bag.has(key)) { bag.delete(key); removed.push(key) } }
    if (removed.length) { HUB_CHANGED.add(sidOf(sid)); return 'unloaded ' + removed.length + ' tool(s): ' + removed.join(', ') + ' — tool face shrinks on the next client poll' }
    return 'nothing to unload (currently loaded: ' + ([...bag.keys()].join(', ') || 'none') + ')'
  }

  if (!wantServer && !wantTools.length) {
    const total = mounted.reduce((n, c) => n + (c.catalog ? c.catalog.size : 0), 0)
    return 'hub: ' + total + ' tools are folded into catalog/describe/call/batch. Call me before invoking unfamiliar tools.\n'
      + '  load({server:"<name>"})              -> one-line index of that server\n'
      + '  load({tools:["<server>.<tool>",...]}) -> index + FULL description & schema (you pay only for these)\n'
      + '  load({server:"<name>", full:true})   -> whole server in full (' + HUB_FULL_BUDGET + ' B budget; batch if truncated)\n'
      + 'Mounted: ' + mounted.map((c) => c.name + ':' + (c.error ? 'UNAVAILABLE' : (c.catalog ? c.catalog.size : 0))).join('  ')
  }

  const picked = [], missing = []
  for (const n of wantTools) { const e = resolveTool(n); if (e) picked.push(e); else missing.push(n) }

  let pool = []
  if (wantServer) {
    const c = mounted.find((x) => String(x.name).toLowerCase() === wantServer)
    if (!c) return 'Unknown server "' + a.server + '". Mounted: ' + mounted.map((x) => x.name).join(', ')
    if (c.error) return c.name + ' is UNAVAILABLE (' + c.error + ')'
    pool = [...c.catalog.values()].sort((x, y) => String(x.tool).localeCompare(String(y.tool)))
  }

  const out = []
  if (pool.length) {
    const idx = pool.map(hubOneLine).join('\n')
    out.push('[index] ' + pool[0].server + ' (' + pool.length + ' tools, ' + idx.length + ' B)\n' + short(idx, HUB_INDEX_BUDGET))
    if (full) picked.push(...pool)
    else out.push('\nnext: load({tools:["' + pool[0].server + '.<tool>"]}) for one full declaration, or load({server:"' + pool[0].server + '", full:true}).')
  }

  const seen = new Set(), decls = [], skipped = []
  let used = 0
  for (const e of picked) {
    const k = e.server + '.' + e.tool
    if (seen.has(k)) continue
    seen.add(k)
    const d = hubFull(e)
    if (used + d.length > HUB_FULL_BUDGET) { skipped.push(k); continue }
    used += d.length
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
  if (missing.length) out.push('\nnot found: ' + missing.join(', '))
  if (skipped.length) out.push('\nover budget, not loaded (call again in batches): ' + skipped.join(', '))
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
    c.client = null
    c.catalog.clear()
    c.error = null
    c.connected = false
    conns.delete(c.name)
    const fresh = connect(c.name, spec)      // re-registers in conns synchronously
    try { await oldClient?.close() } catch {}
    await fresh.ready
    if (fresh.error) throw new Error('server "' + c.name + '" unavailable: ' + fresh.error)
    return fresh
  })().finally(() => reconnectInFlight.delete(c.name))
  reconnectInFlight.set(c.name, p)
  return p
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
  && /Not connected|closed|disconnect|EPIPE|ECONNRESET|socket hang up|transport/i.test(String(err?.message ?? err))

async function callTool(a) {
  let e = await resolveWithWait(a.tool)
  if (!e) return { content: [text('Unknown tool "' + a.tool + '". Call catalog first.')], isError: true }
  let c = await waitOne(e.server)
  // The SDK's own per-request timeout aborts the request (and tells the downstream to
  // cancel); racing our own timer left the request in flight, blocking serial servers.
  const invoke = () => c.client.callTool(
    { name: e.tool, arguments: a.arguments ?? {} },
    { timeout: c.spec?.callTimeoutMs ?? CALL_TIMEOUT_MS },
  )
  let res
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
    e = resolveTool(a.tool) ?? e
    res = await invoke()
  }
  const out = { content: (res?.content?.length ? res.content : [text('(no content)')]) }
  if (res?.structuredContent !== undefined) out.structuredContent = res.structuredContent
  if (res?.isError) out.isError = true
  return out
}

async function batchTools(a) {
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
      try { results[i] = await callTool({ tool: call.tool, arguments: call.arguments ?? {} }) }
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
      const res = await withTimeout(c.client.listResources({}), 15000, c.name + ' resources/list')
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
      const res = await withTimeout(c.client.listResourceTemplates({}), 15000, c.name + ' templates/list')
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

async function handleMsg(msg, sid) {
  const { id, method, params } = msg
  // 每次客户端建立会话时清空已装载集合：避免长跑进程里提升的工具无限累积（跨会话共享的聚合器必须这样隔离）
  if (method === 'initialize') { LOADED_SESSIONS.delete(sidOf(sid)); HUB_CHANGED.delete(sidOf(sid)) }
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: {
    protocolVersion: PROTOCOL_VERSIONS.has(params?.protocolVersion) ? params.protocolVersion : '2025-06-18',
    capabilities: { tools: { listChanged: true }, resources: { subscribe: false, listChanged: false } },
    serverInfo: { name: 'mcp-aggregator', version: '1.0.0' },
  } }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS.concat([...sbag(sid).values()].map((e) => ({ name: e.tool, description: e.description, inputSchema: e.schema }))) } }
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
    try {
      if (name === 'catalog') return { jsonrpc: '2.0', id, result: { content: [text(await catalogText(a))] } }
      if (name === 'describe') return { jsonrpc: '2.0', id, result: { content: [text(await describeText(a))] } }
      if (name === HUB_NAME) return { jsonrpc: '2.0', id, result: { content: [text(await hubText(a, sid))] } }
      if (sbag(sid).has(name)) return { jsonrpc: '2.0', id, result: await callTool({ tool: sbag(sid).get(name).server + '.' + name, arguments: a }) }
      if (name === 'call') return { jsonrpc: '2.0', id, result: await callTool(a) }
      if (name === 'batch') return { jsonrpc: '2.0', id, result: await batchTools(a) }
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
if (HTTP_PORT > 0) {
  const { createServer } = await import('node:http')
  const server = createServer(async (req, res) => {
    const url = req.url ?? '/'
    if (!url.startsWith('/mcp')) { res.writeHead(404).end(); return }
    if (req.method === 'GET') {
      const acc = String(req.headers.accept || '')
      if (acc.indexOf('text/event-stream') >= 0) {
        // B: 实现 server->client 的 SSE 长连接（MCP Streamable HTTP 的 GET 通道）
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'mcp-session-id': SESSION_ID })
        res.write(': connected\n\n')
        SSE_CLIENTS.add(res)
        if (process.env.AGG_TRACE) log('GET sse stream opened (clients=' + SSE_CLIENTS.size + ')')
        const ka = setInterval(function () { try { res.write(': ka\n\n') } catch (e) {} }, 20000)
        req.on('close', function () { clearInterval(ka); SSE_CLIENTS.delete(res); if (process.env.AGG_TRACE) log('GET sse stream closed (clients=' + SSE_CLIENTS.size + ')') })
        return
      }
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, GET' })
      res.end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"send accept: text/event-stream to open the SSE channel"}}')
      return
    }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return }
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
    if (__isInit) { __sid = newSessionId(); SESSIONS.add(__sid) }
    else if (__hdrSess) {
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
    }
    if (process.env.AGG_TRACE && __isInit) log('initialize -> session ' + __sid)
    const out = []
    for (const msg of batch ? body : [body]) {
      if (msg?.id === undefined) continue           // notification: swallow
      if (msg && msg.method === 'tools/list') log('http tools/list from client (accept=' + String(req.headers.accept || '-') + ')')
      try { const r = await handleMsg(msg, __sid); if (r) out.push(r) }
      catch (e) { out.push({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } }) }
    }
    const headers = { 'content-type': 'application/json', 'mcp-session-id': __sid }
    if (out.length === 0) { res.writeHead(202, headers).end(); return }
    const wantsSSE = String(req.headers.accept || '').indexOf('text/event-stream') >= 0
    if (HUB_CHANGED.has(sidOf(__sid))) { notifyListChanged(); HUB_CHANGED.delete(sidOf(__sid)) }
    if (process.env.AGG_TRACE && !wantsSSE) log('no sse accept, accept=' + String(req.headers.accept || '-'))
    if (wantsSSE && HUB_CHANGED.has(sidOf(__sid))) {
      HUB_CHANGED.delete(sidOf(__sid))
      if (process.env.AGG_TRACE) log('SSE notify sent (tools/list_changed)')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'mcp-session-id': __sid })
      res.write('data: ' + JSON.stringify(batch ? out : out[0]) + '\n\n')
      res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n\n')
      res.end()
      return
    }
    res.writeHead(200, headers)
    res.end(JSON.stringify(batch ? out : out[0]))
  })
  server.listen(HTTP_PORT, '127.0.0.1', () => log('HTTP listening on 127.0.0.1:' + HTTP_PORT + '/mcp'))
}

// ---- lifecycle ----
// This process owns the whole MCP surface: one stray rejection must not take every
// downstream down (and with it the tools of a running session). Log and keep serving.
process.on('unhandledRejection', (e) => log('unhandledRejection:', String(e?.stack ?? e)))
process.on('uncaughtException', (e) => log('uncaughtException:', String(e?.stack ?? e)))

async function shutdown() {
  for (const c of conns.values()) { try { await c.client?.close() } catch {} }
  process.exit(0)
}
if (HTTP_PORT <= 0) process.stdin.on('end', shutdown)   // HTTP 模式下 stdin 关掉不算退出
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

