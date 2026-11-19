// 按 op/action 派生参数表：把「一套 schema 多个 op」拆成每 op 一张 {必填, 可选}。
// 目的：模型只取当前 op 需要的那几行，而不是整份 schema 或散文里猜。
//
// 三级来源（合并顺序：schema 结构 → 描述文字 → sidecar 权威覆盖）
//   1) strong: schema.required 的公共项 + allOf(if/then) + 描述里明确的「<op> 必填」
//      —— 可安全用于参数预检拦截
//   2) optional: 描述头部列了「这些 op 会用到我」，如 `open/close 用：…`、`show/hide/only 用：…`
//      —— 只做提示，不拦截
//   3) weak: 描述里孤立的「（必填）」，可能只对部分 op 成立（如 lceda_fp_meta 的 uuid）
//      —— 只做提示，绝不进预检：误当强项会在 list 这类 op 上造成假拦截。
//   另: paramDocs（sidecar 专用）覆盖参数说明，用于没源码/下游没写 description 的第三方包。
const OP_KEYS = ['op', 'action', 'operation', 'kind', 'mode', 'cmd', 'command']
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function opKeyOf(schema) {
  const props = schema?.properties ?? {}
  for (const k of OP_KEYS) if (Array.isArray(props[k]?.enum) && props[k].enum.length) return k
  return null
}

// 顶层 oneOf/anyOf = zod 判别联合直接序列化的形态：没有 properties ⇒ op 表、参数块、预检
// 全都看不见参数（describe 印「无参数」，缺必填也照发下游）。这里摊平成
// 「flat properties + allOf(if/then) 条件必填」，与 schema 本来就有的 op 驱动必填同构，
// 下游 deriveOpTable / checkArgs / paramBlock 不必为联合特判。
// 同一 op 值挂多个分支时（action=read 再按 kind 分叉）取各分支必填的**交集**：
// 并集会把只在某一分支成立的参数写成必填，预检就会误拦合法调用。
const valSetOf = (pr) => {
  if (!pr || typeof pr !== 'object') return null
  const sets = []
  const walk = (p) => {
    if (!p || typeof p !== 'object') return
    if (Array.isArray(p.enum)) sets.push(p.enum.slice())
    if (p.const !== undefined) sets.push([p.const])
    for (const it of Array.isArray(p.allOf) ? p.allOf : []) walk(it)   // allOf = 交集
  }
  walk(pr)
  if (!sets.length) return null
  let acc = sets[0]
  for (const s of sets.slice(1)) acc = acc.filter((v) => s.includes(v))
  return acc
}
export function flattenUnion(schema) {
  const s = schema && typeof schema === 'object' ? schema : {}
  const branches = Array.isArray(s.oneOf) ? s.oneOf : (Array.isArray(s.anyOf) ? s.anyOf : null)
  if (!branches || !branches.length) return s
  if (s.properties && Object.keys(s.properties).length) return s
  const objs = branches.filter((b) => b && typeof b === 'object' && b.properties && typeof b.properties === 'object')
  if (objs.length !== branches.length) return s
  const reqOf = (b) => (Array.isArray(b.required) ? b.required : [])
  const inter = (lists) => (lists.length ? lists[0].filter((k) => lists.every((l) => l.includes(k))) : [])
  // 判别键：OP_KEYS 里第一个「每个分支都能定出字符串取值集合」的键
  let key = null
  let keySets = null
  for (const k of OP_KEYS) {
    const sets = objs.map((b) => valSetOf(b.properties[k]))
    if (sets.every((x) => Array.isArray(x) && x.length && x.every((v) => typeof v === 'string'))) { key = k; keySets = sets; break }
  }
  const props = {}
  const mergeProp = (k, pr) => {
    const cur = props[k]
    if (!cur) { props[k] = { ...pr }; return }
    if (!flat(cur.description) && flat(pr.description)) cur.description = pr.description
    if (!cur.type && pr.type) cur.type = pr.type
    const enumOf = (p) => (Array.isArray(p.enum) ? p.enum : (p.const !== undefined ? [p.const] : null))
    const e1 = enumOf(cur); const e2 = enumOf(pr)
    if (e1 || e2) { cur.enum = [...new Set([...(e1 ?? []), ...(e2 ?? [])])]; delete cur.const }
  }
  const allOf = [...(Array.isArray(s.allOf) ? s.allOf : [])]
  let opProp = null
  let opAnyOfOut = null
  if (key) {
    const vals = [...new Set(keySets.flat())]
    const opAnyOf = {}
    for (const v of vals) {
      const cov = objs.filter((_, i) => keySets[i].includes(v))
      const reqs = cov.map(reqOf).map((l) => l.filter((k) => k !== key))
      const req = inter(reqs)
      if (req.length) allOf.push({ if: { properties: { [key]: { const: v } } }, then: { required: req } })
      // 同一 op 挂多分支、且各自的必填集不同（rebuild 的 primitiveId|all、create 的坐标|polygonSource）：
      // 交集是安全下限，剩下的「二选一」交给组判，否则整组必填在参数表里消失。
      // 组按**原始分支**保留、不做去重/合并：line 与 arc 只差一个 arcAngle，合并成一组
      // 会让「只传坐标」的合法调用被误判（组判是「至少满足一组」，不是「全满足」）。
      // 只要有一支「除必填交集外别无所求」的分支（如 pcb_text_manage 的 action=read 全读），
      // 裸调就是合法的 ⇒ 不挂组、预检不拦。组判只在所有分支都另有要求时才成立。
      const groups = reqs.map((l) => l.filter((k) => !req.includes(k)))
      if (groups.length > 1 && groups.every((g) => g.length)) opAnyOf[v] = groups
    }
    if (Object.keys(opAnyOf).length) opAnyOfOut = opAnyOf
    const desc = objs.map((b) => flat(b.properties[key]?.description)).find(Boolean) ?? ''
    opProp = { type: 'string', enum: vals }
    if (desc) opProp.description = desc
  }
  for (const b of objs) for (const [k, pr] of Object.entries(b.properties)) if (k !== key) mergeProp(k, pr)
  const common = inter(objs.map(reqOf)).filter((k) => k !== key)
  const rawGroups = objs.map((b) => reqOf(b).filter((k) => k !== key && !common.includes(k)))
  // 同一把尺：任一分支「别无所求」⇒ 裸调合法，不挂整份二选一
  const groups = rawGroups.some((g) => !g.length) ? [] : [...new Set(rawGroups.map((g) => JSON.stringify(g)))].map((x) => JSON.parse(x))
  const out = {
    ...s,
    properties: key ? { [key]: opProp, ...props } : props,
    required: [...new Set([...(Array.isArray(s.required) ? s.required : []), ...common])],
  }
  delete out.oneOf; delete out.anyOf
  if (allOf.length) out.allOf = allOf
  if (objs.every((b) => b.additionalProperties === false)) out.additionalProperties = false
  // 无判别键且各分支必填不同（keyword 与 properties 二选一这类）：预检按「至少满足一组」判
  if (!key && groups.length > 1) out.__anyOfReq = groups
  // 同一 op 多分支的「二选一」（如 rebuild 的 primitiveId|all）：按 op 值挂组，预检逐 op 判
  if (opAnyOfOut) out.__opAnyOfReq = { [key]: opAnyOfOut }
  return out
}

// 描述头部常被用来声明「这些 op 会用到我」：`open/close 用：…`、`setMask/setPaste 写 PAD…`
function headOf(desc) {
  const d = flat(desc)
  const m = d.match(/^(.{0,60}?)(?:时)?[：:]/)
  return m ? m[1] : d.slice(0, 32)
}

export function deriveOpTable(schema, sidecar) {
  const props = schema?.properties ?? {}
  const key = opKeyOf(schema)
  if (!key) return null
  const ops = props[key].enum
  const rows = new Map(ops.map((o) => [o, { required: [], weak: [], optional: [] }]))
  const base = (schema.required ?? []).filter((k) => k !== key)
  const fromSchema = new Map(ops.map((o) => [o, new Set()]))

  // allOf(if/then)：op 驱动的条件必填
  for (const it of schema.allOf ?? []) {
    const c = it?.if?.properties?.[key]
    const then = it?.then?.required
    if (!c || !Array.isArray(then)) continue
    const vals = c.const !== undefined ? [c.const] : (Array.isArray(c.enum) ? c.enum : [])
    for (const v of vals) {
      const r = rows.get(v)
      if (!r) continue
      for (const k of then) if (k !== key && !r.required.includes(k)) { r.required.push(k); fromSchema.get(v).add(k) }
    }
  }

  for (const [k, pr] of Object.entries(props)) {
    if (k === key) continue
    const d = flat(pr?.description)
    const head = headOf(d)
    // 斜杠并列的强约束：`get/source/delete 必填`、`(read/set 必填)` 这类一次点名多个 op
    const slashReq = []
    for (const m of d.matchAll(/([A-Za-z0-9_]+(?:\s*\/\s*[A-Za-z0-9_]+)+)\s*(?:时)?必填/g)) {
      for (const o of m[1].split('/').map((x) => x.trim())) if (ops.includes(o)) slashReq.push(o)
    }
    for (const o of ops) {
      const strong = slashReq.includes(o) || new RegExp('(^|[；;，,/\\s])' + esc(o) + '\\s*(?:时)?必填').test(d)
      // 头部里出现该 op 名（词边界只对 ASCII 生效，中文 op 名不会误切）
      const mention = new RegExp('(^|[；;，,/\\s|])' + esc(o) + '(?![A-Za-z0-9_])').test(head)
      const r = rows.get(o)
      if (strong) { if (!r.required.includes(k)) { r.required.push(k); fromSchema.get(o).add(k) } }
      else if (mention) { if (!r.optional.includes(k)) r.optional.push(k) }
      else if (/（必填）|\(必填\)/.test(d)) { if (!r.weak.includes(k)) r.weak.push(k) }
    }
  }

  // 公共必填排最前，便于与 schema.required 对照；同一参数不得同时出现在必填/可选/提示里
  const normRow = (r) => {
    r.required = [...base.filter((k) => !r.required.includes(k)), ...r.required]
    r.optional = r.optional.filter((k) => !r.required.includes(k) && !base.includes(k))
    r.weak = r.weak.filter((k) => !r.required.includes(k) && !r.optional.includes(k) && !base.includes(k))
  }
  for (const o of ops) normRow(rows.get(o))

  // sidecar 是权威口径：覆盖派生结果；sidecar 漏列的强项只告警，不自动合并（否则可能假拦截）
  const warnings = []
  if (sidecar && typeof sidecar === 'object') {
    if (sidecar.opKey && sidecar.opKey !== key) warnings.push('sidecar opKey=' + sidecar.opKey + ' 但 schema 是 ' + key)
    for (const [o, spec] of Object.entries(sidecar.ops ?? {})) {
      const r = rows.get(o)
      if (!r) { warnings.push('sidecar 有未知 op "' + o + '"'); continue }
      const derived = [...fromSchema.get(o)]
      if (Array.isArray(spec.required)) r.required = [...new Set([...base, ...spec.required])]
      if (Array.isArray(spec.optional)) r.optional = spec.optional.filter((k) => !r.required.includes(k))
      if (Array.isArray(spec.weak)) r.weak = spec.weak.filter((k) => !r.required.includes(k))
      for (const k of derived) if (!r.required.includes(k)) warnings.push(o + ': sidecar 未列 ' + k + '（schema 认为必填）')
      // sidecar 覆盖后必须再归一：派生阶段把某个参数算进 optional/weak（描述里点名/带「（必填）」），
      // sidecar 又把它列进 required ⇒ 同一参数会同时印在「必填」和「可选/提示必填」里。
      normRow(r)
    }
  }
  const paramDocs = (sidecar && typeof sidecar.paramDocs === 'object' && sidecar.paramDocs) ? sidecar.paramDocs : null
  // 其余参数：拓扑上合法、但没被任何 op 的描述点名（也没进 schema.required）的参数。
  // 以前它们直接掉出表外 ⇒ "有参数表"并不等于"参数全在这"，模型照样得回头看 schema。
  const covered = new Set([key])
  for (const r of rows.values()) for (const k of [...r.required, ...r.optional, ...r.weak]) covered.add(k)
  const rest = Object.keys(props).filter((k) => !covered.has(k))
  // 同一 op 多分支的「二选一」必填组（摊平判别联合时产生，见 flattenUnion）
  const opAnyOf = (schema?.__opAnyOfReq && key && schema.__opAnyOfReq[key]) ? schema.__opAnyOfReq[key] : null
  return { key, ops, rows, warnings, paramDocs, rest, opAnyOf }
}

const TYPES = (pr) => {
  const bits = []
  if (pr?.type) bits.push(pr.type)
  if (pr?.enum) bits.push('∈' + pr.enum.join('|'))
  const m = flat(pr?.description).match(/\[\{[^}]*\}\]/)
  if (pr?.type === 'array' && m) bits.push(m[0])
  return bits.join(' ')
}

// 参数说明可以来自下游 schema 的 description，也可以来自 sidecar 的 paramDocs（给没有源码、
// 又写不出 description 的第三方包补用法，如 jlceda-native）。截断按字节，避免中文撑爆预算。
const clipBytes = (s, max) => {
  s = String(s ?? '')
  if (Buffer.byteLength(s) <= max) return s
  let lo = 0, hi = s.length
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (Buffer.byteLength(s.slice(0, mid)) <= max - 3) lo = mid; else hi = mid - 1 }
  return s.slice(0, lo) + '…'
}
const OP_DOC_MAX = 92
// shadowed=false 时只输出「schema 里没有」的补充说明（sidecar 覆盖），
// 避免整表把 schema 已经有的 description 再抄一遍 —— 那样等于把 schema 讲了两遍。
const docFor = (schema, table, k, shadowed) => {
  const own = flat(table?.paramDocs?.[k])
  const fromSchema = flat(schema?.properties?.[k]?.description)
  const d = shadowed ? (own || fromSchema) : (own && own !== fromSchema ? own : '')
  return d ? clipBytes(d, OP_DOC_MAX) : ''
}

// 单 op：`op=set 必填: uuid(string), pads(array [{...}])` + `可选: …`
// inlineDocs=true 时（窄分支 #op:xxx）额外附本 op 用到参数的说明；
// 整表输出时改为末尾一次性给 [参数] 段，避免 6 个 op 把同一段说明印 6 遍。
const fmtKey = (schema, k) => { const t = TYPES(schema?.properties?.[k]); return t ? k + '(' + t + ')' : k }
export function opRowText(schema, table, op, inlineDocs) {
  const r = table?.rows?.get(op)
  if (!r) return ''
  const fmt = (k) => fmtKey(schema, k)
  const req = r.required.length ? r.required.map(fmt).join(', ') : '(无)'
  const weak = r.weak.length ? '（提示必填: ' + r.weak.join(',') + '）' : ''
  const anyOf = Array.isArray(table?.opAnyOf?.[op]) && table.opAnyOf[op].length
    ? '（另需满足一组: ' + table.opAnyOf[op].map((g) => g.map(fmt).join('+')).join(' | ') + '）'
    : ''
  const out = [table.key + '=' + op + ' 必填: ' + req + weak + anyOf]
  if (r.optional.length) out.push('  可选: ' + r.optional.map(fmt).join(', '))
  if (inlineDocs && Array.isArray(table.rest) && table.rest.length) out.push('  其余参数: ' + table.rest.map((k) => fmtKey(schema, k)).join(', '))
  if (inlineDocs) {
    const docs = [...r.required, ...r.optional, ...r.weak, ...(Array.isArray(table.rest) ? table.rest : [])]
      .map((k) => ({ k, d: docFor(schema, table, k, true) }))
      .filter((x) => x.d)
    if (docs.length) { out.push('  参数说明:'); for (const { k, d } of docs) out.push('    ' + k + ': ' + d) }
  }
  return out.join('\n')
}

export function opTableText(ref, schema, table, ops) {
  const list = (ops && ops.length ? ops : table.ops).filter((o) => table.rows.has(o))
  const head = '[参数表] ' + ref + '  ' + table.key + '=' + table.ops.join('|')
  const lines = list.map((o) => '  ' + opRowText(schema, table, o, false).replace(/\n/g, '\n  '))
  // 参数说明去重：整张表里每个参数只解释一次（多个 op 共用同一参数时不再重复）
  const used = new Set()
  for (const o of list) { const r = table.rows.get(o); for (const k of [...r.required, ...r.optional, ...r.weak]) used.add(k) }
  if (Array.isArray(table.rest) && table.rest.length) {
    lines.push('  [其余参数] ' + table.rest.map((k) => fmtKey(schema, k)).join(', '))
    for (const k of table.rest) used.add(k)
  }
  const docs = [...used].map((k) => ({ k, d: docFor(schema, table, k) })).filter((x) => x.d)
  if (docs.length) { lines.push('  [参数]'); for (const { k, d } of docs) lines.push('    ' + k + ': ' + d) }
  return [head, ...lines].join('\n')
}

// 没有 op 维度的工具也能补参数说明（第三方包 schema 光秃秃时用）：
// sidecar 里写 { "paramDocs": { "server.tool": { "<param>": "说明" } } }，只影响展示，不参与预检。
export function paramDocsFor(ref, schema, docs) {
  const own = docs?.[ref]
  if (!own || typeof own !== 'object') return ''
  const props = schema?.properties ?? {}
  const lines = []
  for (const [k, d] of Object.entries(own)) {
    if (!(k in props)) continue
    const t = TYPES(props[k])
    lines.push('  ' + k + (t ? '(' + t + ')' : '') + ': ' + clipBytes(flat(d), OP_DOC_MAX))
  }
  return lines.length ? '[参数说明] ' + ref + '\n' + lines.join('\n') : ''
}
