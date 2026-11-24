# mcp-aggregator

把 **18 个** MCP 服务器（kicad / kicad-gui / jlceda / lceda-tools / freecad / dshlink / playwright /
chrome-devtools / github / context7 / pdf / fetch / lceda-cli / jlceda-native / konnect / freeroute /
skills / hat-market）
的 **852 个**工具折叠成 **3 个**常驻工具，省掉每轮请求里成百 KB 的工具声明。

完整声明按需 describe；折叠后 `tools/list` 约 **2.9 KB**。当前 `batch` 与 `load` 关闭，入口是 `catalog / describe / call` 3 个；`hub.strictFlow` 默认关，
首次 `call` 会自动补发说明书（`hub.firstCallDecl=full`，预算 4096 B）。

| 工具 | 作用 |
|---|---|
| `catalog({query?, server?, limit?})` | 无参 = 每服务器工具**数量**概览；带 query = **场景词（可选）+ ≤4 个功能词**，按命中数排序，每行带 `[命中 k/N]`，默认列 **10 行**（详见 [docs/catalog-contract.md](docs/catalog-contract.md)） |
| `describe({tool})` | 该工具的完整描述 + 参数契约（多 op 按 op 拆表）；原始 JSON schema 只走 `describe({tool:"srv.tool#schema"})` |
| `call({tool, arguments?})` | 调用；结果原样返回（text/image 都透传）；**首次调用会在结果前附带该工具的声明** |
| `batch(...)` | 实验入口，当前配置关闭。恢复后用于跨 server 并发、同 server 串行调用。 |
| `load({server?/tools?/preset?/full?/promote?/unload?})` | hub：一行索引（≤6,000 B）/ 完整声明（≤12,288 B）/ `preset` 一次装齐；**只有 `promote:true` 会改工具面**（每次变更 = 一次整段 cache miss，只适合"本会话反复直调"的工具） |

工具引用写法：`server.tool`、`mcp__server__tool`，或唯一裸名。

## 安装与依赖

- 运行时依赖只有 1 个：`@modelcontextprotocol/client`，版本锁在 `package.json` 的 **2.2.0**（与 DSH 内置版本一致）。
- 首次安装：`npm install --omit=dev`（实测 13 个包 / 18 MB / 3 s，registry.npmjs.org 直连可用，无需代理）。
- 启动：`node index.mjs`；HTTP 模式默认 `127.0.0.1:8877`，用 `AGG_HTTP_PORT` 覆盖。
- 升级 SDK：改 `package.json` 版本号再重装。**不要**改用指向 DSH 安装目录的 `node_modules` 软链——DSH 或 node 版本一变就 `ERR_MODULE_NOT_FOUND`（历史踩过）。

## 检索契约（catalog）

完整契约见 [docs/catalog-contract.md](docs/catalog-contract.md)，要点：

- **查询构成**：`可选场景词 + 最多 4 个功能词`。场景词（立创 / easyeda / 嘉立创 / kicad / freecad /
  手机 / 浏览器 / github）**可省略**，写了就是**硬作用域**（只在对应下游里检索），且不计入关键词。
- **功能词之间是「或」**，按**命中个数**排序；同数时依次比：工具名命中 → 摘要命中 → 关键词稀有度
  → 字段加权分。每行带 `[命中 k/N]`，别名兜底标 `[别名]`。
- **窗口**：默认 10 行；第 10 名之后只剪「命中 1 个且分低」的长尾，前 10 名一律保留。
- **零命中兜底**：正常规则一条都没有时，按「整词字面出现」再查一次，命中则头行标注
  `（宽松匹配：整词未命中，按子串兜底）`。
- **关键词由调用方自己拆**：2–4 个短词，不投整句；词尽量用工具名里的英文片段或摘要里独立出现的中文名词。
- `hub.alias` / `hub.synonyms` / `hub.scenes` 仍是数据层，分别负责别名提权、查询扩展、场景路由。
- `discovery-eval.json` 保存发现回归用例（关键词形式）；`selftest.mjs` 检查 Top-5 命中与 Top-1 汇总。

## 说明书投递 + 参数预检（v2，2026-11-05）

折叠之后模型看不到工具说明，直接 `call` 会丢参数语义。两层补救：

- **参数预检**：派发前按该工具 schema 校验 —— 缺必填 / 未知键（schema 明确 `additionalProperties:false` 时）/ enum 越界 ⇒ **不派发**，返回 `[参数校验失败，未派发] …` + 该工具摘要与判据。挡住"猜参数直接打到下游"造成的脏数据。
- **首调补发（firstCallDecl）**：本会话没 `describe` 过该工具/op 就 `call` ⇒ 照常派发，并在 `content` **末尾单独一块**（固定前缀 `[说明书·自动补发]`）带回**与 `describe({tool})` 同一份产出**（同一个函数拼的，逐字相同）；每工具/op 每会话一次，与 `describe` 共用去重桶。`content[0]` 永远是下游真结果，可整段 `JSON.parse`。

`servers.json → hub` 开关：

| 键 | 默认 | 含义 |
|---|---|---|
| `firstCallDecl` | `"full"` | `full`=与 describe 同构 · `brief`=判据块+必填+按 op 参数表+指针 · `off`=关 |
| `firstCallDeclBudgetBytes` | 4096 | 单次补发上限（UTF-8 字节；超限自动降为 brief 形态，describe 指针保留） |
| `firstCallDeclBatchBytes` | 8192 | batch 内补发合计上限 |
| `preflight` | true | false=关闭参数预检 |
| `hub.<工具名>` | — | false = 该入口不进 `tools/list`（改一次 = 一次全价 cache miss）。现 `batch` 关闭、`load` 保留 |

依据（3 条件对照实验，`deepseek-v4.1-flash`、temp 0、各 1 次请求）：**选工具 20/20 = 20/20 = 20/20**
（一行摘要 / 加判据 / 完整声明打平 ⇒ 选择已到天花板）；**"怎么调"参数题：一行摘要 3/8 → 完整声明 8/8**。
⇒ 说明书的收益在"用对参数"，不在"选对"，因此按需回吐而非常驻。

## 其它

- 配置：servers.json（stdio 用 command/args/env/cwd；HTTP 用 url/headers；header 支持 env 与 file 两种占位符）
- eager server 启动即后台连接；lazy server 使用持久目录缓存，首次调用时启动，空闲 30 分钟回收。
- 资源也透传：`resources/list` / `resources/templates/list` / `resources/read` 扇出到所有下游（前缀 `server: resource`）
- `tools/list`、`resources/list`、`resources/templates/list` 都跟随 `nextCursor` 拉完全部分页。
- 图像结果原样透传（下游 image block 原封不动，实测 311 KB PNG 无损）；pdf 页面图像两路径 sha256 相同
- 会话隔离：promote 出来的工具按 `mcp-session-id` 分桶，DSH 与 Codex 共用一个进程也不会互相清掉
- 本地 HTTP 使用 Bearer token；`/health` 返回 server 状态、工具数、重试时间、活跃调用和 session 数。

自测：

- `node selftest.mjs`：当前服务契约与协议回归。
- `node tests/_hardening.mjs`：独立 mock 下游，验证鉴权、分页、重连、lazy、exclusive 锁、session/SSE 和异常退出。
- `node tests/_config-sync.mjs`：检查 README、SKILL 与运行中工具数量是否漂移。
- `node tests/_optable.mjs`：每 op 参数表的覆盖、sidecar 一致性、按 op 分必填和体积收益回归。
- `node tests/_strictflow.mjs`：严格流程回归（按「工具 + op」粒度门禁、load 禁用、工具面只三入口）。

## 严格流程（hub.strictFlow）

`hub.strictFlow=true` 时 `call` 前必须先 `describe` 过，粒度是**工具 + 功能/op**：

| describe 方式 | 解锁范围 |
|---|---|
| `describe({tool:"lceda_fp_pads"})` | 该工具**全部** op（参数表已逐 op 列全） |
| `describe({tool:"lceda_fp_pads#op:setOne"})` | **只**解锁 `setOne`，`read`/`set` 仍拦 |
| `describe({tool:"pdf.read_pdf"})` | 无 op 维度的工具，解锁它本身 |

多 op 工具的不同 op 可以各自 describe 一次后并行首调。被拦时返回本地错误（不派发、不往返下游），
并提示该 describe 哪个分支。`hub.strictFlow=false` 退回旧的建议性流程。

## 每 op 参数表（op-table）

带 `op`/`action`/`mode`/`kind` 枚举的工具，一套 schema 覆盖多个操作，`required` 只列公共项，
分 op 的必填散落在参数描述里（`set 必填：…`、`get/source/delete 必填`、孤立的`（必填）`）。
模型只拿到整份 schema 时，选对 op 之后仍要自己推测参数，猜错才会在下游报错。

- `op-table.mjs`：从 schema 结构（`required` + `allOf(if/then)`）与描述文字派生每 op 的
  `required`/`optional`/`weak`。`weak`（孤立`（必填）`）只作提示，**绝不进预检**——否则 `list`
  这类 op 会被别处的 `uuid（必填）` 假拦截。
- `hub-op-table.json`：人工权威口径（sidecar），只列派生不可靠的工具（二选一、批量确认、
  斜杠并列必填等）。sidecar 与派生冲突时启动日志打 `op-table warn`，由 `tests/_optable.mjs` 兜住。
- 三处消费点：`describe({tool:"s.t"})` 在整份 schema 前附参数表；`describe({tool:"s.t#op:setOne"})`
  随章节附该 op 一行的参数表（章节 id 大小写不敏感）；`call` 的参数预检按参数里的实际 op 判定必填。
- **参数说明**：窄分支（`#op:xxx`）内联本 op 用到参数的说明，一次就能开干；整表只补 schema
  没写的说明（`[参数]` 段），避免把已有 description 抄第二遍。没有 op 维度的工具用
  `hub-op-table.json` 的 `paramDocs` 段补说明（第三方 npm 包如 `jlceda-native` 无源码可改）。
- `servers.json` 的 `hub.opTable:"off"` 可整体退回旧行为（只给整份 schema）。
- **方案 A（章节正文随 describe 下发）**：`hub.descSections="auto"` + `hub.descSectionBudgetBytes`（默认 1600）。
  手册正文 ≤ 预算的工具，describe 直接给全文，之后 call 不再补发；超预算的
  （`lceda_batch` 5457 B、`lceda_doc` 1777 B 等 7 个）仍只给索引。窄分支 `#op:xxx`
  照旧直接给该章正文并登记进去重桶，避免重复。
- 2026-11-15 实测：27 个 op 工具参数表合计 9079 B，整份 schema 合计 21255 B，省 57%
  （带参数说明后的值；纯参数名版本 63%）；
  `describe` 是纯本地操作，并行取同一工具的 6 个 op 分支互不污染（实测 7 ms、0 跨 op 污染）。

## 加固配置（2026-11-08）

- `retry`：下游连接失败后的指数退避。默认 `1s / 2s / 4s / 8s / 16s / 32s / 60s`，带 20% 抖动；恢复后自动刷新目录。
- backoff 窗口内的调用会立即返回 `retrying in Ns`，不会绕过定时器重新 spawn 下游。
- `concurrency:"exclusive"`：按 server 建一条跨 session FIFO 通道，避免 Codex 与 DSH 同时改写同一 EDA/KiCad/FreeCAD 状态。
- `lockTimeoutMs`：等待 exclusive server 的上限；超时返回 `SERVER_BUSY`，不会继续派发。
- 连接建立只在 exclusive 锁外进行；锁内只取已 ready 的 client，连接超时不会占住写通道。
- 断链重连时旧 client 引用计数到零才关闭，不会误杀同 server 的其他在飞调用。
- `sessionTtlMs` / `sessionSweepMs`：session 空闲回收；同时清理 promoted tools、说明书去重桶和 SSE 连接。
- `enforceSession`：当前保留 `false` 作为兼容阶段；终端日志会提示缺失 session，确认两个客户端稳定后再切换为 `true`。
- SSE `tools/list_changed` 按 session 推送，不再广播给全部客户端。
- `uncaughtException` 记录后退出 1，由 systemd 的 `Restart=always` 重建整个工具面。
- `auth.token`：从 `~/.dsh/mcp-aggregator-token` 读取 Bearer token；Codex 与 DSH 都必须配置同一文件中的 token。
- `startup:"lazy"` + `idleMs`：`playwright / chrome-devtools / freecad / lceda-cli / jlceda-native`
  默认 cold；catalog/describe 使用 `catalog-cache.json`，首次 `call` 自动启动。
- `slowCallMs`：超过阈值的工具调用写入 journal，普通成功的快速请求不刷日志。

## 常驻 HTTP 模式（DSH 与 Codex 共用）

- `AGG_HTTP_PORT=8877 node index.mjs` 在 `127.0.0.1:8877/mcp` 起 Streamable HTTP 服务（stdio 仍可用）
- 已装成用户服务：`systemctl --user status|restart mcp-aggregator`（`Restart=always`）
- 客户端各连一份连接、共享同一批下游进程：进程数与会话/线程数无关
- 新增或修改下游：改 `servers.json` → `systemctl --user restart mcp-aggregator`（重启期间不可用约 8 s，工具声明不变 ⇒ 无 cache miss）
- 健康检查：

```bash
TOKEN=$(cat ~/.dsh/mcp-aggregator-token)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8877/health
```

回滚：删掉 `~/.dsh/cordis.patch.yml` 末尾的「MCP 聚合器」段即可（patch 热重载，无需重启）。
