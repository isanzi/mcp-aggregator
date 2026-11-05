#!/usr/bin/env node
/**
 * MCP aggregator probe: 一条命令复测核心语义（幂等 / 工具面生命周期 / 会话隔离 / batch 错误隔离 / 错误路径）。
 * 用法： AGG_URL=http://127.0.0.1:8877/mcp node tests/probe.mjs
 * 退出码：0 全过；1 有失败。只读为主，末尾总会 unload 复原。
 */
const URL_ = process.env.AGG_URL ?? 'http://127.0.0.1:8877/mcp'
const LABEL = process.env.AGG_LABEL ?? 'probe'
const results = []
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok, info: String(info).slice(0, 160) }) }

const rpc = async (sid, method, params, id = Math.random().toString(36).slice(2)) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (sid) headers['mcp-session-id'] = sid
  const r = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
  return { sid: r.headers.get('mcp-session-id'), status: r.status, body: await r.json() }
}
const text = (r) => (r.body?.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(String.fromCharCode(10))
const init = async (tag) => (await rpc(null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: LABEL + '-' + tag, version: '1' } })).sid
const face = async (sid) => { const b = (await rpc(sid, 'tools/list', {})).body.result?.tools ?? []; return { names: b.map((t) => t.name), bytes: JSON.stringify(b).length } }
const hub = async (sid, args) => text(await rpc(sid, 'tools/call', { name: 'load', arguments: args }))
const cat = async (sid) => text(await rpc(sid, 'tools/call', { name: 'catalog', arguments: {} }))

const sidA = await init('A')
const sidB = await init('B')
check('initialize ×2 拿到 session id', !!sidA && !!sidB && sidA !== sidB, (sidA || '').slice(0, 18))

// 1) tools/list 幂等（5 次）
const sigs = []
for (let i = 0; i < 5; i++) { const f = await face(sidA); sigs.push(f.names.join(',') + '|' + f.bytes) }
const base = sigs[0]
check('tools/list 幂等 ×5', new Set(sigs).size === 1, base)

// 2) 找一家有工具的下游
const overview = await cat(sidA)
const servers = [...overview.matchAll(/^- (\S+): (\d+) tools/gm)].map((m) => ({ name: m[1], n: Number(m[2]) })).filter((s) => s.n > 0)
check('catalog 拿到下游清单', servers.length > 0, servers.slice(0, 4).map((s) => s.name + ':' + s.n).join(' '))
const target = servers[0]

// 3) 工具面生命周期：promote -> 变多；unload -> 复原
let promotedCount = 0
if (target) {
  await hub(sidA, { server: target.name, full: true, promote: true })
  const mid = await face(sidA)
  promotedCount = mid.names.length - base.split('|')[0].split(',').length
  const midB = await face(sidB)
  check('promote 后工具面变大', promotedCount > 0, '+' + promotedCount + ' tools')
  check('会话隔离（B 不受 A 装载影响）', midB.names.join(',') === base.split('|')[0], 'B=' + midB.names.length + ' tools')
  const un = await hub(sidA, { unload: true, all: true })
  const after = await face(sidA)
  check('unload 后复原到基线', after.names.join(',') === base.split('|')[0], un.slice(0, 60))
} else {
  check('promote 后工具面变大', false, 'SKIP: 无可用下游')
}

// 4) batch：两个真调用 + 一个不存在的工具，验证错误隔离与顶层 isError
const candidates = [
  { tool: 'context7.resolve-library-id', arguments: { libraryName: 'react' } },
  { tool: 'lceda-tools.lceda_execute', arguments: { code: 'return JSON.stringify({ok:1})' } },
  { tool: 'fetch.fetch', arguments: { url: 'https://example.com' } },
]
const batchCalls = []
for (const c of candidates) { if (batchCalls.length >= 2) break; batchCalls.push({ ...c, label: c.tool }) }
batchCalls.push({ tool: 'no-such-server.no-such-tool', arguments: {}, label: 'bogus' })
if (batchCalls.length >= 2) {
  const b = await rpc(sidA, 'tools/call', { name: 'batch', arguments: { calls: batchCalls } })
  const t = text(b)
  check('batch 返回逐调用分段', /── \[\d+\]/.test(t), 'sections=' + (t.match(/── \[\d+\]/g) ?? []).length)
  check('batch 未因单个失败置顶层 isError', b.body.result?.isError !== true)
  check('batch 标注无法解析的调用', /UNRESOLVED|Unknown tool/.test(t), '')
} else {
  check('batch 返回逐调用分段', false, 'SKIP: 无可用的稳定探针工具')
}

// 5) 错误路径
const e1 = text(await rpc(sidA, 'tools/call', { name: 'call', arguments: { tool: 'nonexistent.thing' } }))
check('未知工具给出可行动错误', /Unknown tool/i.test(e1), e1.slice(0, 60))
const e2 = await hub(sidA, { preset: '__no_such_preset__' })
check('未知 preset 给出结构化提示', /\[preset\]|unknown preset/i.test(e2), e2.slice(0, 70))

// 收尾：确保不留下装载状态
try { await hub(sidA, { unload: true, all: true }) } catch {}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.info ? '  — ' + r.info : ''))
console.log(String.fromCharCode(10) + (results.length - failed.length) + '/' + results.length + ' passed')
process.exit(failed.length ? 1 : 0)
