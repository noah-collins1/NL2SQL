import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { loadConfig, resetConfig, getConfig, type NL2SQLConfig } from "./loadConfig.js"

/**
 * Tests for the unified config loader.
 *
 * Strategy: create a temp directory with config/config.yaml (and optionally
 * config.local.yaml), chdir into it, and verify loadConfig() reads the right
 * values. Env-var overrides are tested by setting process.env before loading.
 */

let tmpDir: string
let originalCwd: string
let savedEnv: Record<string, string | undefined> = {}

// Env vars that the loader reads — we save/restore these between tests
const ENV_VARS = [
	"DB_HOST", "DB_PORT", "ACTIVE_DATABASE", "DB_NAME", "DB_USER", "DB_PASSWORD",
	"OLLAMA_MODEL", "EMBEDDING_MODEL", "OLLAMA_BASE_URL", "OLLAMA_TIMEOUT",
	"OLLAMA_NUM_CTX", "SQL_SYSTEM_PROMPT",
	"TEMPERATURE", "SEQUENTIAL_CANDIDATES",
	"MULTI_CANDIDATE_ENABLED", "MULTI_CANDIDATE_K", "MULTI_CANDIDATE_K_EASY",
	"MULTI_CANDIDATE_K_HARD", "MULTI_CANDIDATE_MAX_EXPLAIN",
	"MULTI_CANDIDATE_MAX_EXECUTE", "MULTI_CANDIDATE_TIME_BUDGET_MS",
	"MULTI_CANDIDATE_EXPLAIN_TIMEOUT_MS",
	"SCHEMA_GLOSSES_ENABLED", "PG_NORMALIZE_ENABLED", "SCHEMA_LINKER_ENABLED",
	"JOIN_PLANNER_ENABLED", "JOIN_PLANNER_TOP_K",
	"FK_SUBGRAPH_CACHE_ENABLED", "DYNAMIC_HUB_CAP_ENABLED",
	"JOIN_PATH_SCORING_ENABLED", "CROSS_MODULE_JOIN_ENABLED",
	"BM25_SEARCH_ENABLED", "MODULE_ROUTER_ENABLED", "COLUMN_PRUNING_ENABLED",
	"CANDIDATE_RERANKER_ENABLED", "PRE_SQL_ENABLED", "VALUE_VERIFICATION_ENABLED",
	"PYTHON_SIDECAR_URL", "JOIN_HINT_FORMAT",
	"EXAM_MODE", "LOG_LEVEL",
]

function writeYaml(dir: string, filename: string, content: string) {
	const configDir = path.join(dir, "config")
	fs.mkdirSync(configDir, { recursive: true })
	fs.writeFileSync(path.join(configDir, filename), content)
}

beforeEach(() => {
	resetConfig()
	// Save and clear all env vars
	for (const v of ENV_VARS) {
		savedEnv[v] = process.env[v]
		delete process.env[v]
	}
	// Create temp dir and chdir
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nl2sql-config-test-"))
	originalCwd = process.cwd()
	process.chdir(tmpDir)
})

afterEach(() => {
	process.chdir(originalCwd)
	fs.rmSync(tmpDir, { recursive: true, force: true })
	// Restore env vars
	for (const v of ENV_VARS) {
		if (savedEnv[v] === undefined) {
			delete process.env[v]
		} else {
			process.env[v] = savedEnv[v]
		}
	}
	resetConfig()
})

// ── Basic Loading ─────────────────────────────────────────────────────

describe("loadConfig — basic YAML loading", () => {
	it("loads values from config/config.yaml", () => {
		writeYaml(tmpDir, "config.yaml", `
database:
  host: myhost
  port: 5433
  name: testdb
  user: testuser
  password: secret123
model:
  llm: "llama3.1:8b"
  embedding: "nomic-embed-text"
  provider: ollama
  ollama_url: "http://localhost:11434"
  timeout: 60
  num_ctx: 4096
  sql_system_prompt: "Generate SQL."
generation:
  temperature: 0.5
  max_tokens: 256
  sequential: true
  candidates:
    enabled: false
    k_default: 2
    k_easy: 1
    k_hard: 3
    max_explain: 2
    max_execute: 1
    time_budget_ms: 5000
    explain_timeout_ms: 1000
retrieval:
  top_k: 10
  threshold: 0.3
  max_tables: 8
  fk_expansion_limit: 2
  hub_fk_cap: 3
features:
  glosses: false
  pg_normalize: false
  schema_linker: true
  join_planner: true
  join_planner_top_k: 5
  fk_subgraph_cache: false
  dynamic_hub_cap: false
  join_path_scoring: false
  cross_module_join: false
  bm25: false
  module_router: false
  column_pruning: true
  reranker: false
  pre_sql: true
  value_verification: true
repair:
  max_attempts: 5
  confidence_penalty: 0.2
  explain_timeout: 3000
  surgical_whitelist:
    enabled: false
    mode: active
    observe_in_exam_only: false
    include_fk_neighbors: false
    max_neighbor_tables: 5
    max_tables_total: 6
    max_columns_per_table: 80
    rewrite_min_confidence: 0.9
    rewrite_ambiguity_delta: 0.2
    active_rewrite_gate:
      min_score: 0.9
      min_dominance: 0.7
      require_containment_or_exact: false
      require_score_separation: false
      min_score_delta: 0.2
      min_score_ratio: 1.5
    risk_blacklist:
      enabled: false
      pairs:
        - ["foo", "bar"]
      action: penalize
      apply_to_observe: true
validation:
  max_limit: 500
  require_limit: false
  max_joins: 5
sidecar:
  url: "http://localhost:9999"
  timeout_ms: 60000
  join_hint_format: paths
exam:
  mode: true
  log_dir: my_logs
logging:
  level: DEBUG
`)
		const cfg = loadConfig()

		// database
		expect(cfg.database.host).toBe("myhost")
		expect(cfg.database.port).toBe(5433)
		expect(cfg.database.name).toBe("testdb")
		expect(cfg.database.user).toBe("testuser")
		expect(cfg.database.password).toBe("secret123")

		// model
		expect(cfg.model.llm).toBe("llama3.1:8b")
		expect(cfg.model.timeout).toBe(60)
		expect(cfg.model.num_ctx).toBe(4096)

		// generation
		expect(cfg.generation.temperature).toBe(0.5)
		expect(cfg.generation.sequential).toBe(true)
		expect(cfg.generation.candidates.enabled).toBe(false)
		expect(cfg.generation.candidates.k_default).toBe(2)

		// retrieval
		expect(cfg.retrieval.top_k).toBe(10)
		expect(cfg.retrieval.threshold).toBe(0.3)

		// features
		expect(cfg.features.glosses).toBe(false)
		expect(cfg.features.schema_linker).toBe(true)
		expect(cfg.features.column_pruning).toBe(true)
		expect(cfg.features.reranker).toBe(false)
		expect(cfg.features.pre_sql).toBe(true)

		// repair
		expect(cfg.repair.max_attempts).toBe(5)
		expect(cfg.repair.surgical_whitelist.enabled).toBe(false)
		expect(cfg.repair.surgical_whitelist.mode).toBe("active")
		expect(cfg.repair.surgical_whitelist.active_rewrite_gate.min_score).toBe(0.9)
		expect(cfg.repair.surgical_whitelist.risk_blacklist.pairs).toEqual([["foo", "bar"]])
		expect(cfg.repair.surgical_whitelist.risk_blacklist.action).toBe("penalize")

		// validation
		expect(cfg.validation.max_limit).toBe(500)
		expect(cfg.validation.require_limit).toBe(false)

		// sidecar
		expect(cfg.sidecar.url).toBe("http://localhost:9999")
		expect(cfg.sidecar.join_hint_format).toBe("paths")

		// exam
		expect(cfg.exam.mode).toBe(true)

		// logging
		expect(cfg.logging.level).toBe("DEBUG")
	})

	it("returns empty-ish config when no config directory exists", () => {
		// tmpDir has no config/ subdirectory
		const cfg = loadConfig()
		// Should not crash — returns a config built only from env defaults
		expect(cfg).toBeDefined()
	})

	it("is a singleton — second call returns same object", () => {
		writeYaml(tmpDir, "config.yaml", "database:\n  host: host1\n")
		const a = loadConfig()
		const b = loadConfig()
		expect(a).toBe(b)
	})

	it("resetConfig clears the singleton", () => {
		writeYaml(tmpDir, "config.yaml", "database:\n  host: host1\n")
		const a = loadConfig()
		resetConfig()
		writeYaml(tmpDir, "config.yaml", "database:\n  host: host2\n")
		const b = loadConfig()
		expect(a.database.host).toBe("host1")
		expect(b.database.host).toBe("host2")
	})

	it("getConfig() auto-loads if not loaded", () => {
		writeYaml(tmpDir, "config.yaml", "database:\n  host: autoload\n")
		const cfg = getConfig()
		expect(cfg.database.host).toBe("autoload")
	})
})

// ── Deep Merge (config.local.yaml overrides) ──────────────────────────

describe("loadConfig — config.local.yaml overlay", () => {
	it("local YAML overrides base YAML values", () => {
		writeYaml(tmpDir, "config.yaml", `
database:
  host: basehost
  port: 5432
  name: basedb
model:
  llm: "base-model"
`)
		writeYaml(tmpDir, "config.local.yaml", `
database:
  host: localhost
  name: localdb
`)
		const cfg = loadConfig()
		expect(cfg.database.host).toBe("localhost")
		expect(cfg.database.name).toBe("localdb")
		// port not in local — should keep base value
		expect(cfg.database.port).toBe(5432)
		// model not in local — should keep base value
		expect(cfg.model.llm).toBe("base-model")
	})

	it("local YAML can override nested values without clobbering siblings", () => {
		writeYaml(tmpDir, "config.yaml", `
features:
  glosses: true
  pg_normalize: true
  schema_linker: false
  bm25: true
`)
		writeYaml(tmpDir, "config.local.yaml", `
features:
  schema_linker: true
`)
		const cfg = loadConfig()
		expect(cfg.features.glosses).toBe(true)       // kept from base
		expect(cfg.features.pg_normalize).toBe(true)   // kept from base
		expect(cfg.features.schema_linker).toBe(true)  // overridden by local
		expect(cfg.features.bm25).toBe(true)           // kept from base
	})

	it("local YAML can override deeply nested values", () => {
		writeYaml(tmpDir, "config.yaml", `
repair:
  max_attempts: 3
  surgical_whitelist:
    enabled: true
    mode: observe
    active_rewrite_gate:
      min_score: 0.80
      min_dominance: 0.60
`)
		writeYaml(tmpDir, "config.local.yaml", `
repair:
  surgical_whitelist:
    mode: active
    active_rewrite_gate:
      min_score: 0.95
`)
		const cfg = loadConfig()
		expect(cfg.repair.max_attempts).toBe(3)                                // base
		expect(cfg.repair.surgical_whitelist.enabled).toBe(true)                // base
		expect(cfg.repair.surgical_whitelist.mode).toBe("active")               // local
		expect(cfg.repair.surgical_whitelist.active_rewrite_gate.min_score).toBe(0.95)     // local
		expect(cfg.repair.surgical_whitelist.active_rewrite_gate.min_dominance).toBe(0.60) // base
	})

	it("missing config.local.yaml is fine — only base is used", () => {
		writeYaml(tmpDir, "config.yaml", `
database:
  host: onlybase
`)
		// no config.local.yaml
		const cfg = loadConfig()
		expect(cfg.database.host).toBe("onlybase")
	})
})

// ── Env-Var Overrides ─────────────────────────────────────────────────

describe("loadConfig — env-var overrides", () => {
	it("env vars override YAML values", () => {
		writeYaml(tmpDir, "config.yaml", `
database:
  host: yamlhost
  port: 5432
  name: yamldb
  password: yamlpass
model:
  llm: "yaml-model"
`)
		process.env.DB_HOST = "envhost"
		process.env.DB_PASSWORD = "envpass"
		process.env.OLLAMA_MODEL = "env-model"

		const cfg = loadConfig()
		expect(cfg.database.host).toBe("envhost")
		expect(cfg.database.password).toBe("envpass")
		expect(cfg.database.port).toBe(5432)  // no env override
		expect(cfg.model.llm).toBe("env-model")
	})

	it("ACTIVE_DATABASE overrides database.name", () => {
		writeYaml(tmpDir, "config.yaml", "database:\n  name: yamldb\n")
		process.env.ACTIVE_DATABASE = "env_active_db"
		const cfg = loadConfig()
		expect(cfg.database.name).toBe("env_active_db")
	})

	it("DB_NAME also overrides database.name", () => {
		writeYaml(tmpDir, "config.yaml", "database:\n  name: yamldb\n")
		process.env.DB_NAME = "env_db_name"
		const cfg = loadConfig()
		expect(cfg.database.name).toBe("env_db_name")
	})

	it("ACTIVE_DATABASE takes precedence over DB_NAME", () => {
		writeYaml(tmpDir, "config.yaml", "database:\n  name: yamldb\n")
		process.env.DB_NAME = "from_db_name"
		process.env.ACTIVE_DATABASE = "from_active_db"
		const cfg = loadConfig()
		expect(cfg.database.name).toBe("from_active_db")
	})

	it("numeric env vars are parsed correctly", () => {
		writeYaml(tmpDir, "config.yaml", `
database:
  port: 5432
model:
  timeout: 60
  num_ctx: 0
generation:
  temperature: 0.3
  candidates:
    k_default: 4
`)
		process.env.DB_PORT = "5555"
		process.env.OLLAMA_TIMEOUT = "120"
		process.env.OLLAMA_NUM_CTX = "8192"
		process.env.TEMPERATURE = "0.7"
		process.env.MULTI_CANDIDATE_K = "8"

		const cfg = loadConfig()
		expect(cfg.database.port).toBe(5555)
		expect(cfg.model.timeout).toBe(120)
		expect(cfg.model.num_ctx).toBe(8192)
		expect(cfg.generation.temperature).toBe(0.7)
		expect(cfg.generation.candidates.k_default).toBe(8)
	})

	it("boolean env vars (OFF-by-default) parse correctly", () => {
		writeYaml(tmpDir, "config.yaml", `
features:
  schema_linker: false
  join_planner: false
  column_pruning: false
  pre_sql: false
exam:
  mode: false
`)
		process.env.SCHEMA_LINKER_ENABLED = "true"
		process.env.JOIN_PLANNER_ENABLED = "1"
		process.env.COLUMN_PRUNING_ENABLED = "false"
		process.env.PRE_SQL_ENABLED = "0"
		process.env.EXAM_MODE = "true"

		const cfg = loadConfig()
		expect(cfg.features.schema_linker).toBe(true)
		expect(cfg.features.join_planner).toBe(true)
		expect(cfg.features.column_pruning).toBe(false)
		expect(cfg.features.pre_sql).toBe(false)
		expect(cfg.exam.mode).toBe(true)
	})

	it("boolean env vars (ON-by-default) parse correctly", () => {
		writeYaml(tmpDir, "config.yaml", `
features:
  glosses: true
  pg_normalize: true
  bm25: true
  reranker: true
`)
		// "false" should turn them off
		process.env.SCHEMA_GLOSSES_ENABLED = "false"
		process.env.BM25_SEARCH_ENABLED = "0"
		// "true" or anything non-false should keep them on
		process.env.PG_NORMALIZE_ENABLED = "true"
		process.env.CANDIDATE_RERANKER_ENABLED = "yes"

		const cfg = loadConfig()
		expect(cfg.features.glosses).toBe(false)
		expect(cfg.features.bm25).toBe(false)
		expect(cfg.features.pg_normalize).toBe(true)
		expect(cfg.features.reranker).toBe(true)
	})

	it("SEQUENTIAL_CANDIDATES env var works", () => {
		writeYaml(tmpDir, "config.yaml", "generation:\n  sequential: false\n")
		process.env.SEQUENTIAL_CANDIDATES = "true"
		const cfg = loadConfig()
		expect(cfg.generation.sequential).toBe(true)
	})

	it("env vars override local YAML which overrides base YAML", () => {
		writeYaml(tmpDir, "config.yaml", "database:\n  host: base\n  name: basedb\n")
		writeYaml(tmpDir, "config.local.yaml", "database:\n  host: local\n")
		process.env.DB_HOST = "fromenv"

		const cfg = loadConfig()
		expect(cfg.database.host).toBe("fromenv")   // env wins over local
		expect(cfg.database.name).toBe("basedb")     // base (no local or env override)
	})

	it("unset env vars do not clobber YAML values", () => {
		writeYaml(tmpDir, "config.yaml", `
database:
  host: yamlhost
  password: yamlpass
model:
  llm: "yaml-model"
features:
  glosses: true
`)
		// All env vars are already deleted in beforeEach
		const cfg = loadConfig()
		expect(cfg.database.host).toBe("yamlhost")
		expect(cfg.database.password).toBe("yamlpass")
		expect(cfg.model.llm).toBe("yaml-model")
		expect(cfg.features.glosses).toBe(true)
	})

	it("invalid numeric env vars are ignored (YAML value kept)", () => {
		writeYaml(tmpDir, "config.yaml", "database:\n  port: 5432\n")
		process.env.DB_PORT = "not_a_number"
		const cfg = loadConfig()
		expect(cfg.database.port).toBe(5432)
	})
})

// ── Integration with real config.yaml ─────────────────────────────────

describe("loadConfig — integration with real config/config.yaml", () => {
	it("can load the actual project config.yaml", () => {
		// Point to the real config
		process.chdir(path.resolve(__dirname, "../../.."))
		const cfg = loadConfig()

		// Verify key defaults from the committed config.yaml
		expect(cfg.database.host).toBe("localhost")
		expect(cfg.database.port).toBe(5432)
		expect(cfg.database.name).toBe("enterprise_erp")
		expect(cfg.model.llm).toBe("qwen2.5-coder:7b")
		expect(cfg.model.embedding).toBe("nomic-embed-text")
		expect(cfg.generation.temperature).toBe(0.3)
		expect(cfg.generation.candidates.enabled).toBe(true)
		expect(cfg.generation.candidates.k_default).toBe(4)
		expect(cfg.features.glosses).toBe(true)
		expect(cfg.features.pg_normalize).toBe(true)
		expect(cfg.features.schema_linker).toBe(false)
		expect(cfg.features.column_pruning).toBe(false)
		expect(cfg.features.reranker).toBe(true)
		expect(cfg.repair.max_attempts).toBe(3)
		expect(cfg.repair.surgical_whitelist.mode).toBe("observe")
		expect(cfg.validation.max_limit).toBe(1000)
		expect(cfg.sidecar.url).toBe("http://localhost:8001")
		expect(cfg.sidecar.join_hint_format).toBe("edges")
	})
})
