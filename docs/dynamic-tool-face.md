# 让客户端消费"活的工具面"（12 行补丁）

聚合器的 `load({..., promote:true})` 只在**服务端**把工具加进 `tools/list`。客户端要看见它，
必须重新列工具。规范路径是 `notifications/tools/list_changed`，但不少 MCP 客户端只实现了
Streamable HTTP 的 POST 半边，于是需要一条兜底：**定期重列**。

## 两种客户端缺陷（实测，不是推测）

以 `@deepseek-ai/dsh-mcp-client` 0.2.1-rc.2 / 0.2.2-rc.1（两者该处代码相同）为例：

1. **不建 GET 长连接** —— 服务端日志里 `GET sse` 计数为 0，服务端无法主动推送；
2. **收到 `404 / -32001 session expired` 不重新握手**，直接把错误抛给调用方
   （`Error POSTing to endpoint: session expired…`）⇒ 服务端重启后客户端的能力快照永远是旧的。

MCP SDK 本身是支持的（`method:"GET"` + `accept: text/event-stream` + `_onnotification` 里对
`list_changed` 做缓存失效），所以这是客户端**用法**问题，不是 SDK 能力问题。

## 补丁（3 处，env 开关，默认关闭）

文件：`<dsh 安装目录>/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js`
（注意：运行时可能加载的是 **profile 私有副本** `<profile>/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js`，
两份不同步时改哪份都不生效 —— 用 `/proc/<pid>/maps` 或对比文件 inode 确认。）

```js
// ① 声明（与 connectedAt 同一作用域）
let pollTimer;

// ② 首次同步成功之后（serverInstructions = instructions; 附近）
const pollMs = Number(process.env.MCP_TOOLS_POLL_MS ?? 0);
if (pollMs >= 3000 && pollTimer === void 0) {
  pollTimer = setInterval(() => {
    if (!isCurrent(generation)) {            // 换代会自清，避免旧定时器悬挂
      clearInterval(pollTimer);
      pollTimer = void 0;
      return;
    }
    refreshTools();                          // → syncTools() → listTools({cacheMode:"refresh"})
  }, pollMs);
  pollTimer.unref?.();
}

// ③ dispose() 里清理
if (pollTimer !== void 0) { clearInterval(pollTimer); pollTimer = void 0; }
```

服务端（systemd drop-in）：

```ini
[Service]
Environment=MCP_TOOLS_POLL_MS=30000
```

`syncTools()` 本来就会 `dispose()` 旧注册再 `ctx.tools.register()` 新定义，所以**工具面热更新是现成能力**，
只差一个触发点。轮询**不改工具面时不产生任何提示缓存代价**（注册的定义字节相同）。

## 验证（缺一不可）

```bash
# 1) 客户端确实在重列（每 N 秒一条）
journalctl --user -u mcp-aggregator --since '2 min ago' | grep "http tools/list"

# 2) 服务端：promote 之后工具面多一个
curl -s http://127.0.0.1:8877/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list","params":{}}' | jq -r '.result.tools[].name'

# 3) 客户端：工具真的变成可调用的原生工具（同一进程内不会变，要在**新的一步/新程序**里看）
```

## 代价（实测）

| 事件 | 提示缓存 | 常驻 |
|---|---|---|
| 轮询（工具面没变） | 0（命中率仍 99.7–99.9%） | 0 |
| 工具面变了（promote/unload） | **整段 miss 一次**（实测 19.5 万 tokens 全价） | 每个已装工具每轮 ≈0.4–3k tokens |

⇒ 用法：**一次装齐、只装反复要用的、用完 unload**。
