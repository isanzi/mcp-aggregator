const B = process.env.AGG_URL ?? 'http://127.0.0.1:8877/mcp'
const post = async (body, raw) => {
  const r = await fetch(B, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) })
  return { status: r.status, sid: r.headers.get('mcp-session-id'), text: (await r.text()).slice(0, 120) }
}
const out = {}
out.initialize = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } })
out.notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
out.toolsList = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
out.batch = await post([{ jsonrpc: '2.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', id: 4, method: 'tools/list' }])
out.badJson = await post(null, '{not json')
out.unknownMethod = await post({ jsonrpc: '2.0', id: 5, method: 'no/such' })
const g = await fetch(B, { method: 'GET' }); out.get = { status: g.status, allow: g.headers.get('allow') }
const d = await fetch(B, { method: 'DELETE' }); out.delete = { status: d.status }
const r404 = await fetch(B.replace(/\/mcp$/, '/nope'), { method: 'POST' }); out.wrongPath = { status: r404.status }
const t0 = Date.now()
const conc = await Promise.all(Array.from({ length: 5 }, (_, i) => post({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'catalog', arguments: { limit: 2 } } })))
out.concurrent = { allOk: conc.every((c) => c.status === 200), ms: Date.now() - t0 }

const expect = { initialize: 200, notification: 202, toolsList: 200, batch: 200, badJson: 400, unknownMethod: 200, delete: 200, wrongPath: 404 }
let bad = 0
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(14), JSON.stringify(v).slice(0, 110))
for (const [k, want] of Object.entries(expect)) if (out[k].status !== want) { console.log('EXPECTED ' + k + ' -> ' + want); bad++ }
if (out.get.status !== 405) { console.log('EXPECTED get -> 405'); bad++ }
if (!out.concurrent.allOk) { console.log('EXPECTED concurrent ok'); bad++ }
console.log(bad ? '\nFAILED: ' + bad : '\nALL HTTP CHECKS PASSED')
process.exit(bad ? 1 : 0)

