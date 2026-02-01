# NL2SQL Project Status

**Last Updated:** 2026-01-13
**Phase:** Setup Complete, Ready for MVP Development

## Project Structure

```
nl2sql-project/
├── roadmap.md                    # Complete architectural roadmap
├── STATUS.md                     # This file
│
├── mcp-server-nl2sql/           # TypeScript MCP Server (forked)
│   ├── src/
│   │   └── index.ts             # Original Smithery Postgres MCP server
│   ├── package.json              # Updated with nl2sql metadata
│   └── README.md                 # Server documentation
│
├── python-sidecar/              # Python AI service
│   ├── requirements.txt          # FastAPI, requests dependencies
│   ├── README.md                 # Python service documentation
│   └── .gitignore               # Python ignore rules
│
└── mcp-servers/                 # Original Smithery repo (reference)
    └── postgres/                # Source for our fork
```

## ✅ Completed

- [x] Clone Smithery MCP servers repository
- [x] Fork Postgres MCP server to `mcp-server-nl2sql/`
- [x] Create Python sidecar directory structure
- [x] Write comprehensive architectural roadmap
- [x] Document both TypeScript and Python components
- [x] Set up project tracking (todo list)

## 🚧 Next Steps (MVP - Week 1)

### Day 1-2: TypeScript MCP Server Extensions
1. Create `src/nl_query_tool.ts` - nl_query tool implementation
2. Create `src/sql_validator.ts` - 5 core validation rules:
   - SELECT-only enforcement
   - Single statement check
   - Table existence validation
   - LIMIT enforcement
   - Dangerous keyword blocking
3. Create `src/python_client.ts` - HTTP client to Python sidecar
4. Create `src/config.ts` - Configuration types and constants
5. Update `src/index.ts` - Register nl_query tool

### Day 3-4: Python Sidecar Implementation
1. Create `config.py` - Hardcoded MCPtest schema + Hrida prompt
2. Create `hrida_client.py` - Ollama API client (temperature=0.0)
3. Create `keyword_filter.py` - Stage 1 table selection logic
4. Create `app.py` - FastAPI server with `/generate_sql` endpoint

### Day 5: Integration & Basic Testing
1. Start Python sidecar: `uvicorn app:app --port 8001`
2. Test Python standalone: `curl -X POST /generate_sql`
3. Start TypeScript MCP server: `npm run dev`
4. Test end-to-end: nl_query("How many companies?")
5. Verify: Question → Python → Ollama → SQL → Postgres → Results

### Day 6-7: Test Suite
1. Run Test 3 questions (all 27)
2. Fix failures (prompt iteration, validation tuning)
3. Document success rate
4. **Target:** 85%+ success rate

## 🎯 Success Criteria

**MVP (Phase 1) Complete When:**
- ✅ nl_query tool works end-to-end
- ✅ Zero quote escaping bugs (vs LibreChat executor)
- ✅ Zero tool simulation issues
- ✅ Zero result hallucinations
- ✅ 85%+ success on Test 3 questions (23+/27)
- ✅ <3 second P95 latency

## 📊 Current Architecture

```
┌─────────────────────────────────────────┐
│ LibreChat / Any Chat Interface          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ TypeScript MCP Server                   │
│ (mcp-server-nl2sql)                     │
│                                          │
│  Tool: nl_query(question: string)       │
│  ├─ 1. HTTP POST to Python sidecar     │
│  ├─ 2. Validate returned SQL            │
│  ├─ 3. Execute on Postgres              │
│  └─ 4. Return results                   │
└──────────────┬──────────────────────────┘
               │ HTTP POST /generate_sql
               ▼
┌─────────────────────────────────────────┐
│ Python Sidecar (FastAPI)                │
│ (python-sidecar)                        │
│                                          │
│  ├─ Stage 1: Keyword filtering          │
│  ├─ Build Hrida prompt                  │
│  ├─ Call Ollama (temp=0.0)              │
│  └─ Return SQL + confidence             │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ Ollama                                   │
│ Model: HridaAI/hrida-t2sql:v1.2.3      │
│ Port: 11434                              │
└──────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Postgres (MCPtest)                      │
│ User: nl_query_readonly                 │
│ Permissions: SELECT only                │
└──────────────────────────────────────────┘
```

## 🔗 Key Documents

- **Roadmap:** `roadmap.md` - Full 6-phase implementation plan
- **TS Server:** `mcp-server-nl2sql/README.md` - TypeScript MCP server docs
- **Python Sidecar:** `python-sidecar/README.md` - Python service docs
- **Test Results:** `../LibreChat-Local/TEST_3_RESULTS.md` - Baseline (66.7% with agent chain)

## 🎓 Design Decisions

### Why This Architecture?
1. **Eliminates executor bugs** - No LibreChat agent chain
2. **Stateless** - Every query is fresh context
3. **Clean separation** - TS owns DB, Python owns AI
4. **Security** - Read-only DB user, multi-layer SQL validation
5. **Scalable** - Designed for enterprise (1000+ tables) from day 1

### What We're Proving
1. TS ↔ Python ↔ Ollama pipeline works
2. Hrida generates correct SQL with clean context
3. Success rate >85% (vs 66.7% with agent chain)
4. Zero executor-class bugs (quote escaping, tool simulation, hallucination)

## 📝 Notes

- **Original Smithery repo** preserved in `mcp-servers/` for reference
- **Fork is independent** - modifications in `mcp-server-nl2sql/` only
- **Python is stateless** - no database access, no state storage
- **Hardcoded schema** for MVP - dynamic loading in Phase 2
- **Temperature=0.0** for Hrida - deterministic SQL generation

## 🚀 Ready to Start

All setup complete. Begin MVP implementation with TypeScript MCP server extensions.

**First file to create:** `mcp-server-nl2sql/src/sql_validator.ts`
