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
- 上限：并发度等于分组数，也就是涉及的 server 个数；没有额外的并发上限保护，
  24 路以上给同一批下游压测时自己注意对方能力

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
  "servers": [
    { "name": "eda", "command": "node", "args": ["/opt/eda-mcp/dist/index.js"], "cwd": "/opt/eda-mcp" },
    { "name": "remote", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${file:~/.token}" } },
    { "name": "slowserver", "command": "uvx", "args": ["slow-mcp"], "callTimeoutMs": 180000 }
  ]
}
```

- `${env:NAME}` / `${file:~/path}` 两种占位符可用于 header（避免把 token 写进文件）
- 逐服务器 `callTimeoutMs` 覆盖全局值
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

- **不支持 SSE 推送**（server→client 通知），只做请求/响应
- **没有 OAuth 交互流程**：需要登录授权的 MCP 服务器请继续用客户端原生挂载
- 超时只是放弃等待，**不会取消**下游调用
- 单点：服务挂了所有下游都不可用（用 `Restart=always` 兜底）
- 资源名会加 `server: ` 前缀，URI 保持原样

## 测试

```bash
node tests/smoke.mjs                      # stdio 冒烟（自动发现 servers.json 里的服务器）
AGG_URL=http://127.0.0.1:8877/mcp node tests/http.mjs   # HTTP 边缘用例
```

## License

MIT

