/**
 * Unified config loader for NL2SQL.
 *
 * Precedence: ENV > config/config.local.yaml > config/config.yaml
 *
 * All existing env-var names remain supported for backward compatibility.
 */

import * as fs from "fs"
import * as path from "path"
import * as yaml from "js-yaml"

// ── Types ────────────────────────────────────────────────────────────

export interface NL2SQLConfig {
	database: {
		host: string
		port: number
		name: string
		user: string
		password: string
	}
	model: {
		llm: string
		embedding: string
		provider: string
		ollama_url: string
		timeout: number
		num_ctx: number
		sql_system_prompt: string
	}
	generation: {
		temperature: number
		max_tokens: number
		sequential: boolean
		candidates: {
			enabled: boolean
			k_default: number
			k_easy: number
			k_hard: number
			max_explain: number
			max_execute: number
			time_budget_ms: number
			explain_timeout_ms: number
		}
	}
	retrieval: {
		top_k: number
		threshold: number
		max_tables: number
		fk_expansion_limit: number
		hub_fk_cap: number
	}
	features: {
		glosses: boolean
		pg_normalize: boolean
		schema_linker: boolean
		join_planner: boolean
		join_planner_top_k: number
		fk_subgraph_cache: boolean
		dynamic_hub_cap: boolean
		join_path_scoring: boolean
		cross_module_join: boolean
		bm25: boolean
		module_router: boolean
		column_pruning: boolean
		reranker: boolean
		pre_sql: boolean
		value_verification: boolean
	}
	repair: {
		max_attempts: number
		confidence_penalty: number
		explain_timeout: number
		surgical_whitelist: {
			enabled: boolean
			mode: "observe" | "active"
			observe_in_exam_only: boolean
			include_fk_neighbors: boolean
			max_neighbor_tables: number
			max_tables_total: number
			max_columns_per_table: number
			rewrite_min_confidence: number
			rewrite_ambiguity_delta: number
			active_rewrite_gate: {
				min_score: number
				min_dominance: number
				require_containment_or_exact: boolean
				require_score_separation: boolean
				min_score_delta: number
				min_score_ratio: number
			}
			risk_blacklist: {
				enabled: boolean
				pairs: [string, string][]
				action: "block" | "penalize"
				apply_to_observe: boolean
			}
		}
	}
	validation: {
		max_limit: number
		require_limit: boolean
		max_joins: number
	}
	sidecar: {
		url: string
		timeout_ms: number
		join_hint_format: "edges" | "paths" | "both" | "none"
	}
	exam: {
		mode: boolean
		log_dir: string
	}
	logging: {
		level: string
	}
}

// ── YAML Loading ─────────────────────────────────────────────────────

function findConfigDir(): string | null {
	// Walk up from cwd looking for config/config.yaml
	let dir = process.cwd()
	for (let i = 0; i < 10; i++) {
		const candidate = path.join(dir, "config", "config.yaml")
		if (fs.existsSync(candidate)) return path.join(dir, "config")
		const parent = path.dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return null
}

function loadYaml(filePath: string): Record<string, any> {
	if (!fs.existsSync(filePath)) return {}
	const raw = fs.readFileSync(filePath, "utf-8")
	return (yaml.load(raw) as Record<string, any>) || {}
}

/** Deep merge b into a (b wins on conflicts). */
function deepMerge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
	const result = { ...a }
	for (const key of Object.keys(b)) {
		if (
			b[key] !== null &&
			typeof b[key] === "object" &&
			!Array.isArray(b[key]) &&
			typeof a[key] === "object" &&
			!Array.isArray(a[key])
		) {
			result[key] = deepMerge(a[key] || {}, b[key])
		} else {
			result[key] = b[key]
		}
	}
	return result
}

// ── Env Overlay ──────────────────────────────────────────────────────

/** Read env var, returning undefined if not set. */
function env(name: string): string | undefined {
	return process.env[name]
}
function envBool(name: string): boolean | undefined {
	const v = env(name)
	if (v === undefined) return undefined
	return v === "true" || v === "1"
}
function envBoolDefaultOn(name: string): boolean | undefined {
	const v = env(name)
	if (v === undefined) return undefined
	return v !== "false" && v !== "0"
}
function envInt(name: string): number | undefined {
	const v = env(name)
	if (v === undefined) return undefined
	const n = parseInt(v, 10)
	return isNaN(n) ? undefined : n
}
function envFloat(name: string): number | undefined {
	const v = env(name)
	if (v === undefined) return undefined
	const n = parseFloat(v)
	return isNaN(n) ? undefined : n
}

/** Apply env-var overrides on top of merged YAML. Uses same var names as before. */
function applyEnvOverrides(cfg: Record<string, any>): void {
	// database
	const db = cfg.database ??= {}
	db.host = env("DB_HOST") ?? db.host
	db.port = envInt("DB_PORT") ?? db.port
	db.name = env("ACTIVE_DATABASE") ?? env("DB_NAME") ?? db.name
	db.user = env("DB_USER") ?? db.user
	db.password = env("DB_PASSWORD") ?? db.password

	// model
	const m = cfg.model ??= {}
	m.llm = env("OLLAMA_MODEL") ?? m.llm
	m.embedding = env("EMBEDDING_MODEL") ?? m.embedding
	m.ollama_url = env("OLLAMA_BASE_URL") ?? m.ollama_url
	m.timeout = envInt("OLLAMA_TIMEOUT") ?? m.timeout
	m.num_ctx = envInt("OLLAMA_NUM_CTX") ?? m.num_ctx
	m.sql_system_prompt = env("SQL_SYSTEM_PROMPT") ?? m.sql_system_prompt

	// generation
	const g = cfg.generation ??= {}
	g.temperature = envFloat("TEMPERATURE") ?? g.temperature
	g.sequential = envBool("SEQUENTIAL_CANDIDATES") ?? g.sequential
	const c = g.candidates ??= {}
	c.enabled = envBoolDefaultOn("MULTI_CANDIDATE_ENABLED") ?? c.enabled
	c.k_default = envInt("MULTI_CANDIDATE_K") ?? c.k_default
	c.k_easy = envInt("MULTI_CANDIDATE_K_EASY") ?? c.k_easy
	c.k_hard = envInt("MULTI_CANDIDATE_K_HARD") ?? c.k_hard
	c.max_explain = envInt("MULTI_CANDIDATE_MAX_EXPLAIN") ?? c.max_explain
	c.max_execute = envInt("MULTI_CANDIDATE_MAX_EXECUTE") ?? c.max_execute
	c.time_budget_ms = envInt("MULTI_CANDIDATE_TIME_BUDGET_MS") ?? c.time_budget_ms
	c.explain_timeout_ms = envInt("MULTI_CANDIDATE_EXPLAIN_TIMEOUT_MS") ?? c.explain_timeout_ms

	// features  (ON-by-default flags use envBoolDefaultOn)
	const f = cfg.features ??= {}
	f.glosses = envBoolDefaultOn("SCHEMA_GLOSSES_ENABLED") ?? f.glosses
	f.pg_normalize = envBoolDefaultOn("PG_NORMALIZE_ENABLED") ?? f.pg_normalize
	f.schema_linker = envBool("SCHEMA_LINKER_ENABLED") ?? f.schema_linker
	f.join_planner = envBool("JOIN_PLANNER_ENABLED") ?? f.join_planner
	f.join_planner_top_k = envInt("JOIN_PLANNER_TOP_K") ?? f.join_planner_top_k
	f.fk_subgraph_cache = envBoolDefaultOn("FK_SUBGRAPH_CACHE_ENABLED") ?? f.fk_subgraph_cache
	f.dynamic_hub_cap = envBoolDefaultOn("DYNAMIC_HUB_CAP_ENABLED") ?? f.dynamic_hub_cap
	f.join_path_scoring = envBoolDefaultOn("JOIN_PATH_SCORING_ENABLED") ?? f.join_path_scoring
	f.cross_module_join = envBoolDefaultOn("CROSS_MODULE_JOIN_ENABLED") ?? f.cross_module_join
	f.bm25 = envBoolDefaultOn("BM25_SEARCH_ENABLED") ?? f.bm25
	f.module_router = envBoolDefaultOn("MODULE_ROUTER_ENABLED") ?? f.module_router
	f.column_pruning = envBool("COLUMN_PRUNING_ENABLED") ?? f.column_pruning
	f.reranker = envBoolDefaultOn("CANDIDATE_RERANKER_ENABLED") ?? f.reranker
	f.pre_sql = envBool("PRE_SQL_ENABLED") ?? f.pre_sql
	f.value_verification = envBool("VALUE_VERIFICATION_ENABLED") ?? f.value_verification

	// sidecar
	const s = cfg.sidecar ??= {}
	s.url = env("PYTHON_SIDECAR_URL") ?? s.url
	s.join_hint_format = env("JOIN_HINT_FORMAT") ?? s.join_hint_format

	// exam
	const e = cfg.exam ??= {}
	e.mode = envBool("EXAM_MODE") ?? e.mode

	// logging
	const l = cfg.logging ??= {}
	l.level = env("LOG_LEVEL") ?? l.level
}

// ── Singleton ────────────────────────────────────────────────────────

let _config: NL2SQLConfig | null = null

export function loadConfig(): NL2SQLConfig {
	if (_config) return _config

	const configDir = findConfigDir()
	let merged: Record<string, any> = {}

	if (configDir) {
		const base = loadYaml(path.join(configDir, "config.yaml"))
		const local = loadYaml(path.join(configDir, "config.local.yaml"))
		merged = deepMerge(base, local)
	}

	applyEnvOverrides(merged)
	_config = merged as NL2SQLConfig
	return _config
}

export function getConfig(): NL2SQLConfig {
	return _config ?? loadConfig()
}

/** Reset singleton (for tests). */
export function resetConfig(): void {
	_config = null
}
