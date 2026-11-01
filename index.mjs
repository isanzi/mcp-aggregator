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
const CALL_TIMEOUT_MS = CFG.callTimeoutMs ?? 240000
const CONNECT_TIMEOUT_MS = CFG.connectTimeoutMs ?? 90000

const conns = new Map()
const log = (...a) => process.stderr.write('[mcp-agg] ' + a.join(' ') + '\n')

function expand(value) {
  return String(value).replace(/\$\{(env|file):([^}]+)\}/g, (_m, kind, key) => {
    if (kind === 'env') return process.env[key] ?? ''
    const p = key.startsWith('~') ? join(homedir(), key.slice(1)) : key
    try { return readFileSync(p, 'utf8').trim() } catch { return '' }
  })
}

function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + label)), ms))])
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
    const client = new Client({ name: 'mcp-aggregator', version: '1.0.0' }, { capabilities: {} })
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, name + ' connect')
    entry.client = client
    entry.connected = true
    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, name + ' tools/list')
    for (const t of listed.tools ?? []) {
      entry.catalog.set(t.name, {
        server: name,
        tool: t.name,
        description: (t.description ?? '').replace(/\s+/g, ' ').trim(),
        schema: t.inputSchema ?? { type: 'object', properties: {} },
      })
    }
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
  await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, ms))])
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
    description: 'Invoke one catalogued MCP tool and return its result verbatim (text and images).',
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
]

async function catalogText(a) {
  const servers = await waitAll(Number(CFG.catalogWaitMs ?? 20000))
  const q = String(a.query ?? '').trim().toLowerCase()
  const only = a.server ? String(a.server).toLowerCase() : null
  const limit = Number(a.limit ?? 40) || 40
  if (!q) {
    const ready = servers.filter((c) => !c.error)
    const pending = servers.filter((c) => c.error === null && !c.connected)
    const lines = servers.map((c) => '- ' + c.name + ': ' + (c.error ? 'UNAVAILABLE (' + c.error + ')' : c.catalog.size + ' tools'))
    const total = ready.reduce((n, c) => n + c.catalog.size, 0)
    return 'MCP aggregator: ' + total + ' tools on ' + ready.length + '/' + servers.length + ' servers'
      + (pending.length ? ' (still starting: ' + pending.map((c) => c.name).join(', ') + ')' : '')
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
  await waitAll(Number(CFG.catalogWaitMs ?? 20000))
  const e = resolveTool(a.tool)
  if (!e) return 'Unknown tool "' + a.tool + '". Call catalog first.'
  return e.server + '.' + e.tool + '\n\n' + (e.description || '(no description)') + '\n\nparameters:\n' + JSON.stringify(e.schema, null, 2)
}

async function ensureAlive(c, force = false) {
  if (!force && c.client && !c.error) return c
  log('reconnecting', c.name)
  const spec = c.spec
  conns.delete(c.name)
  c.client = null
  c.catalog.clear()
  c.error = null
  c.connected = false
  const fresh = connect(c.name, spec)
  await fresh.ready
  if (fresh.error) throw new Error('server "' + c.name + '" unavailable: ' + fresh.error)
  return fresh
}

const looksDisconnected = (err) => /Not connected|closed|disconnect|EPIPE|ECONNRESET|transport/i.test(String(err?.message ?? err))

async function callTool(a) {
  await waitAll(Number(CFG.catalogWaitMs ?? 20000))
  let e = resolveTool(a.tool)
  if (!e) return { content: [text('Unknown tool "' + a.tool + '". Call catalog first.')], isError: true }
  let c = await waitOne(e.server)
  const invoke = () => withTimeout(
    c.client.callTool({ name: e.tool, arguments: a.arguments ?? {} }),
    c.spec?.callTimeoutMs ?? CALL_TIMEOUT_MS,
    e.server + '.' + e.tool,
  )
  let res
  try {
    res = await invoke()
  } catch (err) {
    if (!looksDisconnected(err)) throw err
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
  await waitAll(Number(CFG.catalogWaitMs ?? 20000))
  const calls = Array.isArray(a.calls) ? a.calls.filter((c) => c && typeof c === 'object') : []
  if (!calls.length) return { content: [text('batch: pass calls:[{tool, arguments, label?}]')], isError: true }
  const resolved = calls.map((c) => {
    try { return { call: c, entry: resolveTool(c.tool) } }
    catch (err) { return { call: c, entry: null, err: String(err?.message ?? err) } }
  })
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
    for (const c of conns.values()) {
      if (!c.client) continue
      try { return await withTimeout(c.client.readResource({ uri }), 30000, 'resources/read ' + c.name) } catch {}
    }
    throw new Error('unknown resource uri: ' + uri)
  }
  const c = await waitOne(owner)
  return await withTimeout(c.client.readResource({ uri }), 30000, owner + ' resources/read')
}


async function handleMsg(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: {
    protocolVersion: params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
    serverInfo: { name: 'mcp-aggregator', version: '1.0.0' },
  } }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
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
      // 不支持 server->client SSE 推送；告知能力
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      res.end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"SSE stream not offered; use POST"}}')
      return
    }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end('{"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"}}')
      return
    }
    const batch = Array.isArray(body)
    const out = []
    for (const msg of batch ? body : [body]) {
      if (msg?.id === undefined) continue           // notification: swallow
      try { const r = await handleMsg(msg); if (r) out.push(r) }
      catch (e) { out.push({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } }) }
    }
    const headers = { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID }
    if (out.length === 0) { res.writeHead(202, headers).end(); return }
    res.writeHead(200, headers)
    res.end(JSON.stringify(batch ? out : out[0]))
  })
  server.listen(HTTP_PORT, '127.0.0.1', () => log('HTTP listening on 127.0.0.1:' + HTTP_PORT + '/mcp'))
}

// ---- lifecycle ----
async function shutdown() {
  for (const c of conns.values()) { try { await c.client?.close() } catch {} }
  process.exit(0)
}
if (HTTP_PORT <= 0) process.stdin.on('end', shutdown)   // HTTP 模式下 stdin 关掉不算退出
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

