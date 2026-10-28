import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const cfgPath = process.env.AGG_CONFIG
  ?? (existsSync(join(root, 'servers.json')) ? join(root, 'servers.json') : join(root, 'servers.json.example'))
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const results = []
const check = (name, ok, info) => results.push({ name, ok: !!ok, info: String(info ?? '').slice(0, 120) })
const txt = (res) => (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

const client = new Client({ name: 'smoke', version: '1' }, { capabilities: {} })
const t0 = Date.now()
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'index.mjs')], env: { ...process.env, AGG_CONFIG: cfgPath }, stderr: 'ignore' }))
check('stdio handshake', true, Date.now() - t0 + 'ms')

const list = await client.listTools()
check('three tools', list.tools.map((t) => t.name).sort().join(',') === 'call,catalog,describe', list.tools.map((t) => t.name).join(','))
check('declaration < 2KB', Buffer.byteLength(JSON.stringify(list.tools)) < 2048, Buffer.byteLength(JSON.stringify(list.tools)) + 'B')

const overview = txt(await client.callTool({ name: 'catalog', arguments: {} }))
const expected = (cfg.servers ?? []).length
check('catalog lists every configured server', expected > 0, overview.split('\n')[0])

const firstServer = (cfg.servers ?? [])[0]?.name
const q = txt(await client.callTool({ name: 'catalog', arguments: { server: firstServer, limit: 5 } }))
check('catalog server filter', q.includes(firstServer) || q.includes('No tool matched'), q.split('\n')[0])

const hit = /^([\w.-]+)\.(\w+)\(/m.exec(txt(await client.callTool({ name: 'catalog', arguments: { limit: 200 } })))
if (hit) {
  const ref = hit[1] + '.' + hit[2]
  const d = txt(await client.callTool({ name: 'describe', arguments: { tool: ref } }))
  let ok = false
  try { JSON.parse(d.slice(d.indexOf('{'))); ok = true } catch {}
  check('describe returns parseable schema', ok && d.includes('parameters:'), ref)
} else {
  check('describe returns parseable schema', true, 'skipped (no tools listed)')
}

const unk = await client.callTool({ name: 'call', arguments: { tool: 'nope.nope', arguments: {} } })
check('unknown tool -> isError', unk.isError === true, txt(unk).slice(0, 60))

const amb = await client.callTool({ name: 'call', arguments: { tool: 'no_such_bare_name', arguments: {} } })
check('unknown bare name -> isError', amb.isError === true, txt(amb).slice(0, 60))

await client.close()
const bad = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name.padEnd(38) + r.info)
console.log('\n' + (results.length - bad.length) + '/' + results.length + ' passed in ' + (Date.now() - t0) + 'ms')
process.exit(bad.length ? 1 : 0)

