# 客户端补丁：让支持"活的工具面"

聚合器侧的 `load({..., promote:true})` 只改**服务端**的 `tools/list`。客户端要看见，必须重新列工具。
规范路径是 `notifications/tools/list_changed`（本仓库已在 POST 响应流与 GET-SSE 上发出），但有些客户端
只实现 Streamable HTTP 的 POST 半边、也从不重新 `initialize`，于是需要一条兜底：**定期重列**。

## 文件

- `dsh-mcp-client-tools-poll.patch` —— 给 `@deepseek-ai/dsh-mcp-client` 的补丁（3 处、约 20 行）：
  声明 `pollTimer`、首次同步成功后按 `DSH_MCP_TOOLS_POLL_MS`（≥3000 才启用）打 `setInterval` → `refreshTools()`、
  `dispose()` 里清理。带 `isCurrent(generation)` 守卫（换代自清）与 `unref()`。

## 落到哪里（**两份副本，改错一份不生效**）

```bash
# 1) 全局包
D1=$(dirname "$(readlink -f "$(which dsh)")")/..//node_modules/@deepseek-ai/dsh-mcp-client
# 2) profile 私有包（运行时通常加载这一份）
D2=~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-mcp-client

for D in "$D1" "$D2"; do
  [ -f "$D/lib/index.js" ] || continue
  cp -a "$D/lib/index.js" "$D/lib/index.js.bak-before-poll"
  patch -p1 -d "$D" < patches/dsh-mcp-client-tools-poll.patch || echo "already patched? $D"
done
```

然后装 drop-in（`systemd/dsh-web.tools-poll.conf.example`）并重启 `dsh-web`。
**升级会覆盖补丁**（`npm i -g @deepseek-ai/dsh`）——升级后需重打。

## 验证

```bash
# 客户端确实在重列：每 N 秒一条
journalctl --user -u mcp-aggregator --since '2 min ago' | grep "http tools/list"
# 服务端工具面多了一个
curl -s http://127.0.0.1:8877/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list","params":{}}' | grep -o '"name":"[^"]*"' | tail -3
```

代价：工具面没变时轮询**零成本**（注册的定义字节相同，提示缓存仍命中）；变了就是一次整段 cache miss
（实测 19.5 万 tokens 全价）。所以用法是"一次装齐、只装反复要用的、用完 unload"。
