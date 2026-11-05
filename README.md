# mcp-aggregator

**把十几个 MCP 服务器的工具面折叠成 4 个工具**，让 MCP 的上下文成本从"每轮几十上百 KB"
降到约 2 KB —— 工具本身一个不少，改为按需检索。

- 常驻工具：`catalog` / `describe` / `call` / `batch`（外加 `resources/*` 透传）
- 下游服务器：stdio（`command/args/env/cwd`）或 Streamable HTTP（`url/headers`）
- 传输：stdio **和** Streamable HTTP 二选一（HTTP 模式下可做共享常驻服务）
- 图像（image content block）原样透传，不重编码

## 为什么

一个 MCP 客户的工具声明是**每轮请求**都要付的成本。实测一台机器上 10 个 MCP 服务器
共 **489 个工具、152,991 B 的 schema**，占系统提示 245,587 B 的 **62%**。折叠后：

| 指标 | 折叠前 | 折叠后 |
|---|---|---|
| 工具数 | 489 | 4 |
| 声明体积 | 152,991 B | 2,211 B |
| 系统提示 | 245,587 B | 53,531 B（-78.2%） |

省下来的不是功能，只是"把每个工具的完整 JSON schema 常驻在提示里"这件事。

> 2,211 B 是加 `batch` 之后的实测值（`tools/list` 响应中 schema 部分的字节数）；
> 53,531 B 那行的系统提示实测发生在 3 工具版。

## 它怎么工作

```
模型 ──catalog(query)──▶ 服务器名.工具名(参数签名) — 一句描述   ← 按需检索
     ──describe(tool)──▶ 完整描述 + 精确 JSON 参数 schema      ← 参数复杂时才要
     ──call(tool,args)─▶ 原样转发到下游，结果（文本/图像）原样返回
```

下游的连接在启动后**后台建立**，`initialize` 立即返回；某个下游挂掉后，下一次调用会
自动重连一次。

## batch：一次调用，跨服务器并发

```
模型 ──batch([{tool,arguments,label?}…])──▶ 按所属 server 分组
                                            ├─ 组间 Promise.all 并发
                                            └─ 组内顺序执行（一家下游只有一条通道）
             ◀── 结果按提交顺序返回，每次调用前加 "── [n] label ──" 表头
```

设计判据：**跨 server 并行，同 server 串行**。同一个下游是单条 stdio 连接 / 单个编辑器桥，
并发写会踩对方"单 owner 单通道"的限制；不同下游之间互不相干，可以放心同时打。

- 逐调用错误只写进正文文本，**不置顶层 `isError`** —— 顶层 isError 会让客户端抛错，
  并把其它成功调用返回的 image block 一起丢掉
- 逐调用 `start/end` 偏移写入日志，并发与否直接读时间戳，不靠墙钟推断
  （实测：3 组同时 `+0ms` 起跑；同 server 的第 4 个调用等到前一个结束 `+96ms` 才起）
- 上限：并发度等于分组数，也就是涉及的 server 个数；单次 batch 的调用数由 `maxBatchCalls`（默认 64）
  截断，超了直接报错要求拆分。24 路以上给同一批下游压测时自己注意对方能力

## 动态工具面：下游中途长出工具

有些下游**在会话中途才长出工具**（按需 toolset、插件热加载、按项目加载的能力集）。快照只在连接时拍一次的话，
这些工具虽然存在，调用却会被判成 `Unknown tool`。两条路径解决：

1. **跟通知走（主路径）**：给 SDK 的 `Client` 传 `listChanged.tools.onChanged`，下游发
   `notifications/tools/list_changed` 时自动重列并重建快照 —— 对模型可见的工具面不变，只是这份内部缓存变新。
2. **未命中兜底（次路径）**：查找失败时对已连接的下游重列一次，再判「未知工具」，给**不**发通知的下游用；
   只在未命中路径触发，热路径零成本，并发未命中共享一次刷新。

实测（下游 = Konnect 0.12.1，226 个工具分 21 个按需 toolset）：

```
连上时                            22 tools   ← 只有 starter kit
load_toolset(sch_analysis) 之后   47 tools   ← [mcp-agg] catalog live-updated（通知路径）
未加载工具集的工具                 Unknown tool "konnect.add_schematic_component"（面仍然诚实）
```

## load：把折叠的工具按需装进工具面（第 5 个工具）

聚合器把几百个工具折成 4 个，代价是「直接用 `call` 时看不到工具的完整说明」（判据、字段语义、已知坑）。
`load` 补这一环，**三档代价差 100 倍量级**：

| 意图 | 调用 | 常驻成本 | 提示缓存 |
|---|---|---|---|
| 看索引（哪个工具干什么） | `load({server:"eda"})` | 0 | 不变 |
| 读完整声明（description + JSON schema） | `load({tools:["eda.draw_wire"]})` | 0 | 不变（只是往对话里追加文本） |
| 装成原生工具（schema 校验、按名字直调） | `load({tools:[…], promote:true})` | 每轮 schema tokens | **整段 cache miss 一次** |
| 装**预设工具集**（一次装齐，最省） | `load({preset:"eda", promote:true})` | 同上 | 多个工具**只付一次** miss |
| 卸载 | `load({unload:true, all:true})` | 归零 | 再一次 miss |

- 预算：索引 6000 B / 全量声明 12288 B（`hub` 段可调），超了会列 over-budget 清单让你分批。
- `hub.presets` 定义常用工具集，例如 `"presets": {"eda": ["eda.draw_wire","eda.audit"]}`；
  `load({preset:"eda", promote:true})` 一条调用装齐（**一次工具面变化**），未知 preset 会回可用清单。
- **一次装齐**：`load({tools:[a,b,c], promote:true})` 只触发一次工具面变化；分三次装 = 三次整段 miss。
- 已装集合**按 `mcp-session-id` 分桶**（上限 16 个会话，LRU），`initialize` 只清自己那份 ——
  多个客户端（如 DSH + Codex）共用一个聚合器时互不干扰。

### 客户端要求（重要）

装进工具面只是服务端的一半，**客户端必须重新列工具**，否则对它不可见。两条路：

1. `notifications/tools/list_changed`（主路径）：服务端在 `load` 那次 POST 的响应流里以 SSE 下发通知；
   `/mcp` 的 **GET 长连接**也支持 push（`accept: text/event-stream`）。
2. 客户端轮询（兜底）：定期 `tools/list` 后重建工具注册 —— 对「不消费通知」的客户端（例如
   `@deepseek-ai/dsh-mcp-client` 0.2.2-rc.1：不建 GET 通道、收到通知也不重列）只能走这条。
   参考实现见 [docs/dynamic-tool-face.md](docs/dynamic-tool-face.md)（约 12 行补丁，env 开关 `MCP_TOOLS_POLL_MS`）。

> 实测：工具面每变一次，那次请求的提示缓存整段失效（19.5 万 tokens 走全价）；不变时稳态命中 99.7–99.9%。

## 快速开始

```bash
git clone <this repo> && cd mcp-aggregator
cp servers.json.example servers.json     # 按需改
node index.mjs                            # stdio 模式（给单会话客户端用）
```

常驻 HTTP 模式（多客户端共享同一批下游进程）：

```bash
AGG_HTTP_PORT=8877 node index.mjs          # 监听 127.0.0.1:8877/mcp
```

装成用户服务：

```bash
mkdir -p ~/.config/systemd/user
cp systemd/mcp-aggregator.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now mcp-aggregator
```

## 配置 servers.json

```json
{
  "descWidth": 84,
  "callTimeoutMs": 240000,
  "catalogWaitMs": 20000,
  "hub": { "name": "load", "lineWidth": 96, "indexBudgetBytes": 6000, "fullBudgetBytes": 12288,
           "presets": { "eda": ["eda.draw_wire", "eda.audit"] } },
  "enforceSession": false,
  "servers": [
    { "name": "eda", "command": "node", "args": ["/opt/eda-mcp/dist/index.js"], "cwd": "/opt/eda-mcp" },
    { "name": "remote", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${file:~/.token}" } },
    { "name": "slowserver", "command": "uvx", "args": ["slow-mcp"], "callTimeoutMs": 180000 }
  ]
}
```

- `${env:NAME}` / `${file:~/path}` 两种占位符可用于 header（避免把 token 写进文件）
- 逐服务器 `callTimeoutMs` 覆盖全局值
- `hub`：第 5 个工具 `load` 的名字与预算（见上节）；`enforceSession`: `true` 时对未知/过期
  `mcp-session-id` 回 `404 -32001`（MCP 规范的"重新握手"信号）。注意：**有些客户端收到 404 不会重连、
  而是直接把错误抛给调用方**（实测 `dsh-mcp-client` 如此）⇒ 默认 `false`（只告警）
- 改完 `systemctl --user restart mcp-aggregator` 生效

## 接到客户端

**DSH**（`@deepseek-ai/dsh-mcp-client`，一行 patch 即可）：

```yaml
- insert:
    - id: mcp-aggregator
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tools
        transport: streamable-http      # 或 stdio + command/args
        url: http://127.0.0.1:8877/mcp
        toolCallTimeoutMs: 240000
```

**Codex CLI**（`~/.codex/config.toml`）：

```toml
[mcp_servers.tools]
url = "http://127.0.0.1:8877/mcp"
```

然后把已被代管的服务器在各自客户端里关掉（Codex 用 `enabled = false`），避免重复挂载。

## 已知限制

- **不向客户端透传 server→client 通知**：只做请求/响应。但 `notifications/tools/list_changed` 会在内部被
  消费掉，用来刷新工具快照（见「动态工具面」）
- **没有 OAuth 交互流程**：需要登录授权的 MCP 服务器请继续用客户端原生挂载
- 超时只是放弃等待，**不会取消**下游调用
- 单点：服务挂了所有下游都不可用（用 `Restart=always` 兜底）
- 资源名会加 `server: ` 前缀，URI 保持原样

## 测试

```bash
node tests/smoke.mjs                      # stdio 冒烟（自动发现 servers.json 里的服务器）
AGG_URL=http://127.0.0.1:8877/mcp node tests/http.mjs   # HTTP 边缘用例
AGG_URL=http://127.0.0.1:8877/mcp node tests/probe.mjs  # 核心语义回归：幂等 / 工具面生命周期 / 会话隔离 / batch 错误隔离 / 错误路径
```

`probe.mjs` 是**改完就复测**的那一条：11 项检查、约 5 s、只读为主（末尾必 `unload` 复原），
退出码非 0 即有用例失败。实测（2026-11-05，15 下游 / 400 工具）：`11/11 passed`。

## License

MIT

