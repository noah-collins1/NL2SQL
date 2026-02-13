# MCP Integration

NL2SQL is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server. It can be connected to any MCP-compatible client application, including open-source tools like LibreChat, Anthropic's Claude Desktop, or your own internal applications.

## What is MCP?

The Model Context Protocol is an open standard that lets AI assistants connect to external tools and data sources. An MCP server exposes "tools" (functions the AI can call) and "resources" (data the AI can read). The NL2SQL server exposes:

**Tools:**

| Tool | Description | Parameters |
|------|-------------|------------|
| `nl_query` | Convert a natural language question to SQL, execute it, and return results | `question` (required), `max_rows`, `timeout_seconds`, `explain`, `trace` |
| `query` | Execute a raw SQL query directly (role-gated permissions) | `sql` (required) |
| `checkpoint` | Manage database checkpoints for undo/redo | `action` ("start", "list", "rollback", "commit", "discard") |

**Resources:**

| Resource | URI | Description |
|----------|-----|-------------|
| Table list | `postgres://tables` | Lists all tables in the public schema |
| Table schema | `postgres://tables/{name}/schema` | Returns column definitions for a specific table |

**Permission Roles:** `read` (SELECT only), `insert` (append-only), `write` (full DML), `admin` (DDL included).

## Connecting to LibreChat

[LibreChat](https://www.librechat.ai/) is an open-source AI chat interface that supports MCP servers.

### Setup

1. Ensure the NL2SQL prerequisites are installed and the sidecar is running:
   ```bash
   ./scripts/setup-deps.sh
   ./demo/setup-db.sh
   ./scripts/start-sidecar.sh --bg
   ```

2. Add the server to your `librechat.yaml`:

   ```yaml
   mcpServers:
     nl2sql:
       type: stdio
       command: npx
       args:
         - tsx
         - /absolute/path/to/nl2sql-project/mcp-server-nl2sql/src/stdio.ts
       env:
         DB_PASSWORD: "your_password"
         OLLAMA_MODEL: "qwen2.5-coder:7b"
         PYTHON_SIDECAR_URL: "http://localhost:8001"
       timeout: 60000
   ```

3. Restart LibreChat. The NL2SQL tools will appear in the tool picker.

### LibreChat MCP Configuration Options

- **`type: stdio`** — Runs the server as a local child process (recommended for single-user)
- **`type: streamable-http`** — Connect to a remote server over HTTP (recommended for multi-user/production)
- **`timeout`** — Request timeout in ms. Set higher (60000+) because SQL generation involves LLM calls

For complete LibreChat MCP configuration reference:
- [Feature overview](https://www.librechat.ai/docs/features/mcp)
- [YAML configuration](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_servers)
- [Security settings](https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/mcp_settings)

## Connecting to Claude Desktop

[Claude Desktop](https://claude.ai/download) supports MCP servers natively.

### Setup

Add to your MCP configuration (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "nl2sql": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/nl2sql-project/mcp-server-nl2sql/src/stdio.ts"],
      "env": {
        "DB_PASSWORD": "your_password",
        "OLLAMA_MODEL": "qwen2.5-coder:7b"
      }
    }
  }
}
```

Restart Claude Desktop. You can then ask Claude to query your database in natural language.

## Connecting to a Custom Application

The MCP server communicates over **stdio** (stdin/stdout). To integrate it into your own application:

1. **Spawn the process:**
   ```bash
   npx tsx /path/to/mcp-server-nl2sql/src/stdio.ts
   ```

2. **Communicate via MCP protocol** — Send JSON-RPC messages over stdin, read responses from stdout. The [MCP SDK](https://github.com/modelcontextprotocol/sdk) provides client libraries in TypeScript and Python.

3. **Example (TypeScript client):**
   ```typescript
   import { Client } from "@modelcontextprotocol/sdk/client/index.js"
   import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

   const transport = new StdioClientTransport({
     command: "npx",
     args: ["tsx", "/path/to/mcp-server-nl2sql/src/stdio.ts"],
     env: { DB_PASSWORD: "your_password" },
   })

   const client = new Client({ name: "my-app", version: "1.0.0" })
   await client.connect(transport)

   const result = await client.callTool({
     name: "nl_query",
     arguments: { question: "How many employees do we have?" },
   })
   ```

## Environment Variables

The MCP server reads configuration from `config/config.yaml` and environment variables. When connecting from a client, you can pass environment variables via the client config:

| Variable | Purpose |
|----------|---------|
| `DB_PASSWORD` | PostgreSQL password |
| `OLLAMA_MODEL` | LLM model tag (default: `qwen2.5-coder:7b`) |
| `PYTHON_SIDECAR_URL` | Sidecar URL (default: `http://localhost:8001`) |
| `ACTIVE_DATABASE` | Database name (default: `enterprise_erp`) |
| `EXAM_MODE` | Enable diagnostic logging (`true`/`false`) |

See [CONFIG.md](CONFIG.md) for the full list.

## Production Considerations

- **Sidecar must be running** — The MCP server depends on the Python sidecar for LLM calls. Start it before connecting clients.
- **Ollama must be running** — The sidecar depends on Ollama for model inference.
- **Read-only by default** — The `nl_query` tool only executes SELECT queries. The `query` tool is role-gated.
- **Multi-user** — For production deployments with multiple users, run the MCP server with `streamable-http` transport behind a reverse proxy.
- **Statement timeout** — All generated queries execute with a PostgreSQL `statement_timeout` to prevent runaway queries.
