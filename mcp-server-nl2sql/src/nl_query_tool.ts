/**
 * NL Query Tool - Natural Language to SQL
 *
 * Main orchestration layer that:
 * 1. Receives natural language question
 * 2. Calls Python sidecar for SQL generation
 * 3. Validates generated SQL
 * 4. Executes on Postgres
 * 5. Returns results with metadata
 *
 * This eliminates the LibreChat executor agent layer entirely.
 */

import { Pool, PoolClient } from "pg"
import { v4 as uuidv4 } from "uuid"
import { validateSQL, ValidationResult, lintSQL, LintResult, lintIssuesToValidatorIssues, formatLintIssuesForRepair, attemptAutocorrect, AutocorrectResult, pgNormalize, type PgNormalizeResult, parseUndefinedColumn } from "./sql_validation.js"
import { getPythonClient, PythonClient } from "./python_client.js"
import {
	MCPTEST_CONFIG,
	ENTERPRISE_ERP_CONFIG,
	ACTIVE_DATABASE,
	getDatabaseConfig,
	usesSchemaRAG,
	DEFAULTS,
	NLQueryRequest,
	NLQueryResponse,
	NL2SQLError,
	AuditLogEntry,
	RepairSQLRequest,
	ValidatorIssue,
	PostgresErrorContext,
	PythonSidecarResponse,
	REPAIR_CONFIG,
	isFailFastError,
	isRepairableError,
	isInfrastructureError,
	isTimeoutError,
	classifyExecutionError,
	getSQLSTATEHint,
	EXAM_MODE,
	ExecutionErrorClass,
	SCHEMA_GLOSSES_ENABLED,
	SCHEMA_LINKER_ENABLED,
	JOIN_PLANNER_ENABLED,
	PG_NORMALIZE_ENABLED,
	MODULE_ROUTER_ENABLED,
	BM25_SEARCH_ENABLED,
} from "./config.js"
import {
	SchemaRetriever,
	getSchemaRetriever,
	getAllowedTables,
	routeToModules,
	type ModuleRouteResult,
} from "./schema_retriever.js"
import {
	SURGICAL_WHITELIST_CONFIG,
	processSurgicalWhitelist,
	evaluateStrictGating,
	evaluateActiveGating,
	WhitelistTelemetry,
	WhitelistShadowObservation,
	ActiveGatingResult,
} from "./surgical_whitelist.js"
import { SchemaContextPacket, RetrievalMetrics } from "./schema_types.js"
import {
	MULTI_CANDIDATE_CONFIG,
	evaluateCandidates,
	classifyDifficulty,
	getKForDifficulty,
	buildCandidateExamLog,
	MultiCandidateResult,
	CandidateExamLog,
} from "./multi_candidate.js"
import { generateGlosses, type SchemaGlosses, linkSchema, formatSchemaLinkForPrompt, type SchemaLinkBundle } from "./schema_grounding.js"
import { planJoins, formatJoinPlanForPrompt, type JoinPlan } from "./join_planner.js"
import {
	CANDIDATE_RERANKER_ENABLED,
	getReranker,
	type RerankerResult,
	type RerankerDetail,
} from "./candidate_reranker.js"
import fs from "fs"
import path from "path"

export interface NLQueryToolInput {
	question: string
	max_rows?: number
	timeout_seconds?: number
	explain?: boolean
	trace?: boolean
}

export interface NLQueryToolContext {
	pool: Pool
	logger: {
		info: Function
		error: Function
		warn: Function
		debug: Function
	}
}

/**
 * Execute natural language query with validation loop
 *
 * This is the main entry point for the nl_query tool.
 * Implements bounded retry with EXPLAIN-first strategy.
 */
export async function executeNLQuery(
	input: NLQueryToolInput,
	context: NLQueryToolContext,
): Promise<NLQueryResponse> {
	const startTime = Date.now()
	const queryId = uuidv4()

	const {
		question,
		max_rows = DEFAULTS.maxRows,
		timeout_seconds = DEFAULTS.timeoutSeconds,
		explain = false,
		trace = false,
	} = input

	const { pool, logger } = context
	const pythonClient = getPythonClient()
	const maxAttempts = REPAIR_CONFIG.maxAttempts

	// Determine which database to use
	const databaseId = ACTIVE_DATABASE
	const dbConfig = getDatabaseConfig(databaseId)
	const useRAG = usesSchemaRAG(databaseId)

	logger.info("NL Query received", {
		query_id: queryId,
		question,
		max_rows,
		max_attempts: maxAttempts,
		database_id: databaseId,
		use_schema_rag: useRAG,
	})

	// Initialize exam entry if in exam mode
	initExamEntry(queryId, question)

	// Track latencies across attempts
	let totalPythonLatency = 0
	let totalValidationLatency = 0
	let totalPostgresLatency = 0
	let totalRetrievalLatency = 0

	// Per-stage latency profiling (exam mode) — written to currentExamEntry incrementally
	if (EXAM_MODE && currentExamEntry) {
		currentExamEntry.stage_latencies = {}
	}

	// Track state across attempts
	let currentSQL = ""
	let currentConfidence = 0
	let tablesUsed: string[] = []
	let validationWarnings: string[] = []
	let notes: string | undefined
	let pythonTrace: any

	// Schema context (for RAG-based databases)
	let schemaContext: SchemaContextPacket | null = null
	let allowedTables: string[] = []
	let moduleRouteResult: ModuleRouteResult | undefined

	// Repair loop state
	let attempt = 0
	let lastValidatorIssues: ValidatorIssue[] = []
	let lastPostgresError: PostgresErrorContext | undefined

	try {
		// === SCHEMA RETRIEVAL (for RAG-based databases) ===
		if (useRAG) {
			const retrievalStart = Date.now()

			logger.info("Using Schema RAG for table selection", {
				query_id: queryId,
				database_id: databaseId,
			})

			{
				const retriever = getSchemaRetriever(pool, logger)

				// Phase 1: Module routing (before retrieval)
				let moduleFilter: string[] | undefined
				if (MODULE_ROUTER_ENABLED) {
					try {
						const routeClient = await pool.connect()
						try {
							const embedding = await getPythonClient().embedText(question)
							moduleRouteResult = await routeToModules(
								routeClient,
								question,
								embedding,
								3,
								logger,
							)
							// Only apply filter if router returned specific modules
							if (moduleRouteResult.modules.length > 0) {
								moduleFilter = moduleRouteResult.modules
							}
							logger.info("Module routing complete", {
								query_id: queryId,
								modules: moduleRouteResult.modules,
								method: moduleRouteResult.method,
								confidences: moduleRouteResult.confidences.map(c => c.toFixed(3)),
							})
						} finally {
							routeClient.release()
						}
					} catch (routeErr) {
						logger.warn("Module routing failed, proceeding without filter", { error: String(routeErr) })
					}
				}

				// Note: schemaLinkBundle not yet available at retrieval time for pruning.
				// It will be passed on a second call if needed, but for now we prune inside retriever
				// using whatever link bundle is available (none on first call).
				schemaContext = await retriever.retrieveSchemaContext(
					question,
					databaseId,
					{ moduleFilter },
				)
				allowedTables = getAllowedTables(schemaContext)

				// Always allow common utility tables (present in every division schema)
				const UTILITY_TABLES = ["lookup_codes", "audit_log", "document_attachments"]
				for (const ut of UTILITY_TABLES) {
					if (!allowedTables.includes(ut)) {
						allowedTables.push(ut)
					}
				}

				// V1: Record retrieval tables for exam logging
				if (EXAM_MODE && currentExamEntry && schemaContext) {
					currentExamEntry.retriever_version = "V1"
					currentExamEntry.tables_retrieved = schemaContext.tables.map(t => t.table_name)
					currentExamEntry.total_retrieval_latency_ms = Date.now() - retrievalStart

					// Record Phase 1 diagnostics
					const enriched = schemaContext as any
					if (moduleRouteResult) {
						currentExamEntry.module_route = {
							modules: moduleRouteResult.modules,
							confidences: moduleRouteResult.confidences,
							method: moduleRouteResult.method,
						}
					}
					if (enriched._bm25Tables) {
						currentExamEntry.bm25_tables = enriched._bm25Tables
					}
					if (enriched._fusionMethod) {
						currentExamEntry.fusion_method = enriched._fusionMethod
					}
				}
			}

			totalRetrievalLatency = Date.now() - retrievalStart
			if (EXAM_MODE && currentExamEntry?.stage_latencies) {
				currentExamEntry.stage_latencies.retrieval_ms = totalRetrievalLatency
			}

			logger.info("Schema retrieval complete", {
				query_id: queryId,
				retriever_version: "V1",
				tables_selected: schemaContext.tables.length,
				table_names: schemaContext.tables.map(t => t.table_name),
				modules: schemaContext.modules,
				retrieval_latency_ms: totalRetrievalLatency,
			})
		} else {
			// Use hardcoded tables for non-RAG databases
			allowedTables = (dbConfig as typeof MCPTEST_CONFIG).allowedTables || []
		}

		// === SCHEMA GROUNDING PIPELINE (Phase 1 + Phase 2) ===
		let schemaLinkBundle: SchemaLinkBundle | null = null
		let joinPlan: JoinPlan | null = null
		let schemaLinkText: string | undefined
		let joinPlanText: string | undefined

		if (schemaContext) {
			// Phase 1A: Generate column glosses
			let glosses: SchemaGlosses | undefined
			if (SCHEMA_GLOSSES_ENABLED) {
				const glossStart = Date.now()
				glosses = generateGlosses(schemaContext)
				if (EXAM_MODE && currentExamEntry?.stage_latencies) currentExamEntry.stage_latencies.glosses_ms = Date.now() - glossStart
				logger.debug("Schema glosses generated", {
					query_id: queryId,
					column_count: glosses.size,
				})
			}

			// Phase 1B: Schema linking
			if (SCHEMA_LINKER_ENABLED) {
				const linkerStart = Date.now()
				schemaLinkBundle = linkSchema(question, schemaContext, glosses)
				schemaLinkText = glosses
					? formatSchemaLinkForPrompt(schemaLinkBundle, glosses)
					: undefined
				if (EXAM_MODE && currentExamEntry?.stage_latencies) currentExamEntry.stage_latencies.linker_ms = Date.now() - linkerStart

				logger.info("Schema linking complete", {
					query_id: queryId,
					tables_linked: schemaLinkBundle.linkedTables.length,
					columns_linked: Object.values(schemaLinkBundle.linkedColumns).flat().length,
					unsupported_concepts: schemaLinkBundle.unsupportedConcepts,
				})

				// Record for exam
				if (EXAM_MODE) {
					recordExamSchemaLink(schemaLinkBundle)
				}
			}

			// Phase 2: Join planning
			if (JOIN_PLANNER_ENABLED) {
				const plannerStart = Date.now()
				joinPlan = planJoins(schemaContext, schemaLinkBundle, undefined, {
					moduleRouteResult,
				})
				if (joinPlan.skeletons.length > 0) {
					joinPlanText = formatJoinPlanForPrompt(joinPlan)
				}
				if (EXAM_MODE && currentExamEntry?.stage_latencies) currentExamEntry.stage_latencies.planner_ms = Date.now() - plannerStart

				logger.info("Join planning complete", {
					query_id: queryId,
					skeletons: joinPlan.skeletons.length,
					graph_nodes: joinPlan.graphStats.nodes,
					graph_edges: joinPlan.graphStats.edges,
				})

				// Record for exam
				if (EXAM_MODE) {
					recordExamJoinPlan(joinPlan)
				}
			}
		}

		// === BOUNDED REPAIR LOOP ===
		while (attempt < maxAttempts) {
			attempt++

			logger.info("Validation loop attempt", {
				query_id: queryId,
				attempt,
				max_attempts: maxAttempts,
				has_previous_issues: lastValidatorIssues.length > 0,
				has_postgres_error: !!lastPostgresError,
			})

			// --- Step 1: Generate or Repair SQL ---
			const pythonStart = Date.now()
			let pythonResponse: PythonSidecarResponse

			if (attempt === 1) {
				// === SQL GENERATION (multi-candidate) ===
				const useMultiCandidate = MULTI_CANDIDATE_CONFIG.enabled
				const difficulty = useMultiCandidate ? classifyDifficulty(question, schemaContext) : "medium"
				const kValue = useMultiCandidate ? getKForDifficulty(difficulty) : 1

				const pythonRequest: NLQueryRequest = {
					question,
					database_id: databaseId,
					max_rows,
					timeout_seconds,
					explain,
					trace,
					// Include schema context for RAG-based databases
					schema_context: schemaContext || undefined,
					// Multi-candidate parameters
					multi_candidate_k: useMultiCandidate ? kValue : undefined,
					multi_candidate_delimiter: useMultiCandidate ? MULTI_CANDIDATE_CONFIG.sql_delimiter : undefined,
					// Schema grounding (Phase 1+2)
					schema_link_text: schemaLinkText,
					join_plan_text: joinPlanText,
				}

				pythonResponse = await pythonClient.generateSQL(pythonRequest)

				// Multi-candidate evaluation and selection
				// Support both sql_candidates (list from parallel generation) and sql_candidates_raw (delimited string)
				const hasCandidates = pythonResponse.sql_candidates && pythonResponse.sql_candidates.length > 0
				const hasRawCandidates = pythonResponse.sql_candidates_raw && pythonResponse.sql_candidates_raw.length > 0

				if (useMultiCandidate && (hasCandidates || hasRawCandidates)) {
					// Build raw string for evaluateCandidates - join list with delimiter if we have list
					const rawForEval = hasCandidates
						? pythonResponse.sql_candidates!.join(`\n${MULTI_CANDIDATE_CONFIG.sql_delimiter}\n`)
						: pythonResponse.sql_candidates_raw!

					logger.info("Multi-candidate generation enabled", {
						query_id: queryId,
						k: kValue,
						difficulty,
						candidates_count: hasCandidates ? pythonResponse.sql_candidates!.length : "raw",
						raw_length: rawForEval.length,
					})

					// Evaluate candidates and select best
					const multiResult = await evaluateCandidates(
						rawForEval,
						question,
						allowedTables,
						pool,
						schemaContext,
						dbConfig.maxLimit,
						dbConfig.requireLimit,
						logger,
					)

					// Record multi-candidate evaluation for exam mode
					if (EXAM_MODE) {
						recordExamMultiCandidate(multiResult)
					}

					// Phase 3: Rerank candidates with schema adherence, join match, result shape
					if (CANDIDATE_RERANKER_ENABLED && multiResult.allCandidates.length > 1) {
						const rerankerStart = Date.now()
						const reranker = getReranker()
						const rerankerResult = await reranker.rerank(multiResult.allCandidates, {
							question,
							schemaLinkBundle,
							joinPlan,
							schemaContext,
							pool,
						})
						const rerankerLatency = Date.now() - rerankerStart

						// Update candidates with reranked order
						multiResult.allCandidates = rerankerResult.candidates
						const bestCandidate = rerankerResult.candidates.find(c => !c.rejected) || null
						if (bestCandidate) {
							multiResult.selectedCandidate = bestCandidate
						}

						// Log reranker results
						logger.info("Reranker applied", {
							query_id: queryId,
							latency_ms: rerankerLatency,
							candidates_reranked: rerankerResult.candidates.length,
							top_bonuses: rerankerResult.rerankDetails.slice(0, 3).map(d => ({
								idx: d.index,
								bonus: d.totalBonus.toFixed(1),
								adherence: d.schemaAdherence.combined.toFixed(2),
								joinMatch: d.joinMatch.score.toFixed(2),
								shape: d.resultShape.score.toFixed(2),
							})),
						})

						// Record for exam
						if (EXAM_MODE && currentExamEntry) {
							currentExamEntry.reranker = rerankerResult.rerankDetails
							if (currentExamEntry.stage_latencies) {
								currentExamEntry.stage_latencies.reranker_ms = rerankerLatency
							}
						}
					}

					// Use the selected candidate
					if (multiResult.selectedCandidate) {
						pythonResponse = {
							...pythonResponse,
							sql_generated: multiResult.selectedCandidate.sql,
						}

						logger.info("Multi-candidate: selected best candidate", {
							query_id: queryId,
							selected_index: multiResult.selectedCandidate.index,
							selected_score: multiResult.selectedCandidate.score,
							explain_passed: multiResult.selectedCandidate.explainPassed,
							candidates_generated: multiResult.candidatesGenerated,
							candidates_passed_explain: multiResult.candidatesPassedExplain,
						})
					} else {
						logger.warn("Multi-candidate: no valid candidate found, using first generated", {
							query_id: queryId,
							candidates_generated: multiResult.candidatesGenerated,
							candidates_rejected: multiResult.candidatesRejected,
						})
					}
				}
			} else {
				// Repair attempt: send previous SQL with error context
				// IMPORTANT: Same schema context across retries (stateless)

				const repairRequest: RepairSQLRequest = {
					question,
					database_id: databaseId,
					previous_sql: currentSQL,
					attempt,
					max_attempts: maxAttempts,
					validator_issues: lastValidatorIssues.length > 0 ? lastValidatorIssues : undefined,
					postgres_error: lastPostgresError,
					trace,
					// Include schema context for RAG-based databases
					schema_context: schemaContext || undefined,
					// Minimal whitelist is passed via postgres_error.minimal_whitelist for 42703 repairs
					// Schema grounding (Phase 1+2) — same as initial generation
					schema_link_text: schemaLinkText,
					join_plan_text: joinPlanText,
				}

				logger.debug("Sending repair request", {
					query_id: queryId,
					attempt,
					previous_sql: currentSQL,
					validator_issues: lastValidatorIssues.map(i => i.code),
					postgres_error: lastPostgresError?.sqlstate,
				})

				pythonResponse = await pythonClient.repairSQL(repairRequest)
			}

			const pythonLatencyThisAttempt = Date.now() - pythonStart
			totalPythonLatency += pythonLatencyThisAttempt

			// Capture first generation timing and token counts for exam
			if (attempt === 1) {
				if (EXAM_MODE && currentExamEntry?.stage_latencies) currentExamEntry.stage_latencies.first_generation_ms = pythonLatencyThisAttempt
				if (EXAM_MODE && currentExamEntry && pythonResponse.prompt_tokens) {
					currentExamEntry.prompt_tokens = pythonResponse.prompt_tokens
					currentExamEntry.completion_tokens = pythonResponse.completion_tokens
				}
			}

			// Update state from Python response
			currentSQL = pythonResponse.sql_generated
			currentConfidence = pythonResponse.confidence_score - (REPAIR_CONFIG.confidencePenaltyPerAttempt * (attempt - 1))
			tablesUsed = pythonResponse.tables_used_in_sql || []
			notes = pythonResponse.notes
			pythonTrace = pythonResponse.trace

			logger.debug("Received SQL from Python", {
				query_id: queryId,
				attempt,
				sql: currentSQL,
				confidence: currentConfidence,
				tables_selected: pythonResponse.tables_selected,
			})

			// Record SQL for exam logging
			recordExamSQL(currentSQL, tablesUsed, attempt)

			// --- Step 1.5: PG Dialect Normalization ---
			if (PG_NORMALIZE_ENABLED && currentSQL) {
				const normalizeResult = pgNormalize(currentSQL)
				if (normalizeResult.changed) {
					logger.info("PG normalization applied", {
						query_id: queryId,
						attempt,
						transforms: normalizeResult.applied,
					})
					currentSQL = normalizeResult.sql

					// Record for exam
					if (EXAM_MODE) {
						recordExamPgNormalize(normalizeResult)
					}
				}
			}

			// If Python returned an error, propagate it
			if (pythonResponse.error) {
				throw new NL2SQLError(
					pythonResponse.error.type,
					pythonResponse.error.message,
					pythonResponse.error.recoverable,
					{ python_response: pythonResponse, attempt }
				)
			}

			// Reset error state for this attempt
			lastValidatorIssues = []
			lastPostgresError = undefined

			// --- Step 2: Structural Validation (TypeScript) ---
			const validationStart = Date.now()

			const validationResult = validateSQL(currentSQL, {
				allowedTables: allowedTables,
				maxLimit: dbConfig.maxLimit,
				requireLimit: dbConfig.requireLimit,
			})

			const validationThisAttempt = Date.now() - validationStart
			totalValidationLatency += validationThisAttempt
			if (attempt === 1 && EXAM_MODE && currentExamEntry?.stage_latencies) {
				currentExamEntry.stage_latencies.validation_ms = validationThisAttempt
			}

			// Check for fail-fast errors (security violations)
			if (!validationResult.valid && validationResult.issues) {
				const failFastIssues = validationResult.issues.filter(i => i.action === "fail_fast")

				if (failFastIssues.length > 0) {
					logger.error("Validation fail-fast triggered", {
						query_id: queryId,
						attempt,
						sql: currentSQL,
						fail_fast_issues: failFastIssues.map(i => i.code),
					})

					// Security violation - do NOT retry
					return buildErrorResponse({
						queryId,
						question,
						databaseId,
						sql: currentSQL,
						confidence: currentConfidence,
						tablesUsed,
						errorType: "validation",
						errorMessage: failFastIssues.map(i => i.message).join("; "),
						recoverable: false,
						trace,
						pythonLatency: totalPythonLatency,
						validationLatency: totalValidationLatency,
						postgresLatency: totalPostgresLatency,
						startTime,
						pythonTrace,
						attempt,
						context: { fail_fast_issues: failFastIssues },
					}, logger)
				}

				// Repairable validation errors - collect for retry
				const repairableIssues = validationResult.issues.filter(i => i.action === "rewrite")

				if (repairableIssues.length > 0) {
					lastValidatorIssues = repairableIssues.map(i => ({
						code: i.code,
						severity: i.severity as "error" | "warning" | "info",
						message: i.message,
						suggestion: i.suggestion,
					}))

					logger.warn("Validation errors found, will retry", {
						query_id: queryId,
						attempt,
						issues: repairableIssues.map(i => i.code),
					})

					// Continue to next attempt
					continue
				}
			}

			// Use auto-fixed SQL if applicable
			const finalSQL = validationResult.sql || currentSQL
			// Extract warnings from issues
			validationWarnings = validationResult.issues
				.filter(i => i.severity === "warning" || i.severity === "info")
				.map(i => i.message)

			if (validationResult.autoFixed) {
				logger.debug("SQL auto-fixed by validator", {
					query_id: queryId,
					original: currentSQL,
					fixed: finalSQL,
				})
			}

			// --- Step 2.5: SQL Lint Check (deterministic structural analysis) ---
			const lintResult = lintSQL(finalSQL)

			if (lintResult.hasErrors) {
				logger.warn("SQL lint errors detected", {
					query_id: queryId,
					attempt,
					issues: lintResult.issues.map(i => ({ code: i.code, severity: i.severity })),
				})

				// Skip EXPLAIN and directly trigger repair with lint issues
				if (attempt < maxAttempts) {
					// Convert lint issues to validator issues format
					const lintValidatorIssues = lintIssuesToValidatorIssues(lintResult.issues)
					lastValidatorIssues = [
						...lastValidatorIssues,
						...lintValidatorIssues.map(i => ({
							code: i.code,
							severity: i.severity as "error" | "warning" | "info",
							message: i.message,
							suggestion: i.suggestion,
						})),
					]

					logger.info("Lint errors found, skipping EXPLAIN and triggering repair", {
						query_id: queryId,
						attempt,
						lint_errors: lintResult.issues.filter(i => i.severity === "error").length,
					})

					currentSQL = finalSQL // Update for repair
					continue
				}
			}

			// Add lint warnings to validation warnings
			const lintWarnings = lintResult.issues
				.filter(i => i.severity === "warn")
				.map(i => `LINT: ${i.message}`)
			validationWarnings.push(...lintWarnings)

			// --- Step 3: EXPLAIN-First Safety Check ---
			const explainStart = Date.now()
			let client: PoolClient | null = null
			let autocorrectExplainPassed = false
			let autocorrectSQL: string | null = null
			let autocorrectAttempted = false

			try {
				client = await pool.connect()

				// Set short timeout for EXPLAIN
				await client.query(`SET statement_timeout = ${REPAIR_CONFIG.explainTimeout}`)

				// Run EXPLAIN (safe - no execution)
				logger.debug("Running EXPLAIN check", { query_id: queryId, sql: finalSQL })
				await client.query(`EXPLAIN (FORMAT JSON) ${finalSQL}`)

				// EXPLAIN succeeded - SQL is safe to execute
				logger.debug("EXPLAIN check passed", { query_id: queryId })
				recordExamExplainResult(true)

			} catch (explainError) {
				const explainLatency = Date.now() - explainStart
				totalPostgresLatency += explainLatency

				// Parse PostgreSQL error
				let pgError = parsePostgresError(explainError)

				logger.warn("EXPLAIN check failed", {
					query_id: queryId,
					attempt,
					sql: finalSQL,
					sqlstate: pgError.sqlstate,
					message: pgError.message,
				})

				// Record EXPLAIN failure for exam
				recordExamExplainResult(false, pgError.sqlstate, pgError.message)

				// --- SURGICAL WHITELIST: Deterministic fix for 42703 errors ---
				// ACTIVE MODE ONLY — requires enabled + active + active gating
				if (schemaContext && pgError.sqlstate === "42703"
					&& SURGICAL_WHITELIST_CONFIG.enabled
					&& SURGICAL_WHITELIST_CONFIG.mode === "active") {
					const surgicalResult = processSurgicalWhitelist(
						finalSQL,
						pgError.message,
						schemaContext,
						SURGICAL_WHITELIST_CONFIG,
					)

					// Record telemetry for exam
					recordExamSurgicalWhitelist(surgicalResult.telemetry)

					const activeResult = evaluateActiveGating(
						surgicalResult,
						autocorrectAttempted,
						autocorrectExplainPassed,
						finalSQL,
						pgError.message,
						SURGICAL_WHITELIST_CONFIG,
					)

					if (activeResult.passed && activeResult.correctedSQL) {
						const correctedSQL = activeResult.correctedSQL

						logger.info("Surgical whitelist: active gating passed, rewrite applied", {
							query_id: queryId,
							attempt,
							top_candidate: activeResult.topCandidate,
							best_score: activeResult.bestScore,
							dominance: activeResult.dominance,
						})

						// Re-run EXPLAIN with corrected SQL
						try {
							const retryClient = await pool.connect()
							try {
								await retryClient.query(`SET statement_timeout = ${REPAIR_CONFIG.explainTimeout}`)
								await retryClient.query(`EXPLAIN (FORMAT JSON) ${correctedSQL}`)
								logger.info("Surgical whitelist: EXPLAIN passed after rewrite", { query_id: queryId })
								recordExamExplainResult(true)
								autocorrectExplainPassed = true
								autocorrectSQL = correctedSQL
								recordExamSQL(correctedSQL, tablesUsed, attempt)
							} finally {
								retryClient.release()
							}
						} catch (retryError) {
							logger.warn("Surgical whitelist: EXPLAIN still failed after rewrite", {
								query_id: queryId,
								error: String(retryError),
							})
							currentSQL = correctedSQL
						}
					} else if (surgicalResult.repairPromptDelta) {
						// Active gating failed, fall back to compact whitelist repair prompt
						logger.debug("Surgical whitelist: active gating failed, using compact repair prompt", {
							query_id: queryId,
							active_failures: activeResult.failures,
							whitelist_tables: surgicalResult.whitelistResult.primaryTables,
							prompt_size: surgicalResult.telemetry.whitelist_prompt_size,
						})

						// Update pgError with surgical whitelist for repair
						pgError = {
							...pgError,
							minimal_whitelist: {
								alias: surgicalResult.whitelistResult.debug.alias_resolved,
								resolved_table: surgicalResult.whitelistResult.primaryTables[0] || null,
								failing_column: surgicalResult.whitelistResult.debug.failing_reference?.split(".")[1] || null,
								whitelist: surgicalResult.whitelistResult.tables,
								neighbor_tables: surgicalResult.whitelistResult.neighborTables,
								formatted_text: surgicalResult.repairPromptDelta,
							},
						}
					}
				}
				// --- FALLBACK AUTOCORRECT: For 42P01 and non-surgical 42703 ---
				else if (schemaContext && (pgError.sqlstate === "42703" || pgError.sqlstate === "42P01")) {
					autocorrectAttempted = true
					const autocorrectResult = attemptAutocorrect(
						finalSQL,
						pgError.sqlstate,
						pgError.message,
						schemaContext,
					)

					recordExamAutocorrect(autocorrectResult)

					if (autocorrectResult.success && autocorrectResult.sql !== finalSQL) {
						const correctedSQL = autocorrectResult.sql
						logger.info("Autocorrect succeeded", {
							query_id: queryId,
							attempt,
							sqlstate: pgError.sqlstate,
							correction: autocorrectResult.correction,
							candidate: autocorrectResult.selected_candidate?.qualified_name,
						})

						try {
							const retryClient = await pool.connect()
							try {
								await retryClient.query(`SET statement_timeout = ${REPAIR_CONFIG.explainTimeout}`)
								await retryClient.query(`EXPLAIN (FORMAT JSON) ${correctedSQL}`)
								logger.info("Autocorrect EXPLAIN passed", { query_id: queryId })
								recordExamExplainResult(true)
								autocorrectExplainPassed = true
								autocorrectSQL = correctedSQL
								recordExamSQL(correctedSQL, tablesUsed, attempt)
							} finally {
								retryClient.release()
							}
						} catch (retryError) {
							logger.warn("Autocorrect EXPLAIN still failed", {
								query_id: queryId,
								error: String(retryError),
							})
							currentSQL = correctedSQL
						}
					} else if (autocorrectResult.attempted) {
						logger.debug("Autocorrect did not fix issue", {
							query_id: queryId,
							reason: autocorrectResult.failure_reason,
							candidates: autocorrectResult.candidates?.length || 0,
						})
					}
				}

				// --- SHADOW OBSERVATION: Surgical whitelist precision measurement ---
				// NEVER modifies SQL, control flow, or repair behavior.
				// Only computes and logs what the whitelist WOULD have done.
				const shouldObserve = SURGICAL_WHITELIST_CONFIG.enabled
					&& (SURGICAL_WHITELIST_CONFIG.mode === "observe" || SURGICAL_WHITELIST_CONFIG.mode === "active")
					&& (!SURGICAL_WHITELIST_CONFIG.observeInExamOnly || EXAM_MODE)

				if (shouldObserve && schemaContext && pgError.sqlstate === "42703") {
					try {
						const shadowResult = processSurgicalWhitelist(finalSQL, pgError.message, schemaContext)
						const gating = evaluateStrictGating(
							shadowResult,
							autocorrectAttempted,
							autocorrectExplainPassed,
							SURGICAL_WHITELIST_CONFIG,
						)
						const activeGating = evaluateActiveGating(
							shadowResult,
							autocorrectAttempted,
							autocorrectExplainPassed,
							finalSQL,
							pgError.message,
							SURGICAL_WHITELIST_CONFIG,
						)
						const rewrite = shadowResult.telemetry.deterministic_rewrites[0]
						shadowObservations.push({
							attempt,
							failing_reference: shadowResult.whitelistResult.debug.failing_reference,
							alias_resolved: shadowResult.whitelistResult.debug.alias_resolved,
							alias_ambiguous: shadowResult.telemetry.alias_resolution.ambiguity,
							would_rewrite: shadowResult.success,
							rewrite_to_column: rewrite?.to_column,
							rewrite_confidence: rewrite?.confidence,
							rewrite_rejection_reason: rewrite?.rejection_reason,
							candidate_count: shadowResult.telemetry.deterministic_rewrites.length,
							strict_gating_passed: gating.passed,
							strict_gating_failures: gating.failures,
							autocorrect_attempted: autocorrectAttempted,
							autocorrect_succeeded: autocorrectExplainPassed,
							// Composite scoring detail
							lexical_score: gating.bestLexicalScore,
							containment_bonus: gating.bestContainmentBonus,
							has_containment: gating.hasContainment,
							dominance_delta: gating.dominance,
							is_keyword: gating.isKeyword,
							top_candidates: gating.topCandidates,
							// Active gating (action tier)
							active_gating_passed: activeGating.passed,
							active_gating_failures: activeGating.failures,
							rewrite_would_fire_in_active_mode: activeGating.passed,
							// Top-2 score info
							top1_score: activeGating.bestScore,
							top2_score: activeGating.top2Score,
							score_delta: activeGating.scoreDelta,
							score_ratio: activeGating.scoreRatio,
							// Risk blacklist info
							risk_blacklist_hit: activeGating.riskBlacklistHit,
							risk_blacklist_action: activeGating.riskBlacklistAction,
							// Candidate counts
							raw_candidate_count: activeGating.rawCandidateCount,
							eligible_candidate_count: activeGating.eligibleCandidateCount,
						})
					} catch (e) {
						logger.debug("Shadow whitelist observation failed", { error: String(e) })
					}
				}

				// If autocorrect fixed the issue and EXPLAIN passed, skip all error handling
				// and let the code proceed to execution after the finally block
				if (!autocorrectExplainPassed) {
					// Classify the execution error for retry gating
					const errorClassification = classifyExecutionError(
						pgError.sqlstate,
						pgError.message,
						false, // Not a validation failure
					)

					logger.info("EXPLAIN error classified", {
						query_id: queryId,
						attempt,
						sqlstate: pgError.sqlstate,
						error_class: errorClassification.errorClass,
						should_retry: errorClassification.shouldRetry,
						reason: errorClassification.reason,
					})

					// Infrastructure errors - fail immediately without wasting retry attempts
					if (errorClassification.errorClass === "infra_failure") {
						logger.error("EXPLAIN infrastructure failure - not retrying", {
							query_id: queryId,
							sqlstate: pgError.sqlstate,
							error_class: errorClassification.errorClass,
						})

						return buildErrorResponse({
							queryId,
							question,
							databaseId,
							sql: finalSQL,
							confidence: currentConfidence,
							tablesUsed,
							errorType: "execution",
							errorMessage: `Infrastructure error: ${errorClassification.reason}`,
							recoverable: false,
							trace,
							pythonLatency: totalPythonLatency,
							validationLatency: totalValidationLatency,
							postgresLatency: totalPostgresLatency,
							startTime,
							pythonTrace,
							attempt,
							context: {
								postgres_error: pgError,
								error_class: errorClassification.errorClass,
							},
						}, logger)
					}

					// Timeout errors - may retry but note in logs
					if (errorClassification.errorClass === "query_timeout") {
						logger.warn("EXPLAIN query timeout", {
							query_id: queryId,
							attempt,
							sqlstate: pgError.sqlstate,
							error_class: errorClassification.errorClass,
						})

						// Allow retry if attempts remain (LLM should simplify)
						if (attempt < maxAttempts) {
							lastPostgresError = pgError
							continue
						}

						return buildErrorResponse({
							queryId,
							question,
							databaseId,
							sql: finalSQL,
							confidence: currentConfidence,
							tablesUsed,
							errorType: "timeout",
							errorMessage: `Query timeout after ${attempt} attempts: ${pgError.message}`,
							recoverable: false,
							trace,
							pythonLatency: totalPythonLatency,
							validationLatency: totalValidationLatency,
							postgresLatency: totalPostgresLatency,
							startTime,
							pythonTrace,
							attempt,
							context: {
								postgres_error: pgError,
								error_class: errorClassification.errorClass,
							},
						}, logger)
					}

					// Check if fail-fast error (validation_block)
					if (isFailFastError(pgError.sqlstate)) {
						logger.error("EXPLAIN fail-fast error", {
							query_id: queryId,
							sqlstate: pgError.sqlstate,
							error_class: "validation_block",
						})

						return buildErrorResponse({
							queryId,
							question,
							databaseId,
							sql: finalSQL,
							confidence: currentConfidence,
							tablesUsed,
							errorType: "execution",
							errorMessage: `Database error: ${pgError.message}`,
							recoverable: false,
							trace,
							pythonLatency: totalPythonLatency,
							validationLatency: totalValidationLatency,
							postgresLatency: totalPostgresLatency,
							startTime,
							pythonTrace,
							attempt,
							context: {
								postgres_error: pgError,
								error_class: "validation_block",
							},
						}, logger)
					}

					// Check if repairable (sql_error)
					if (errorClassification.shouldRetry && attempt < maxAttempts) {
						lastPostgresError = pgError

						logger.info("EXPLAIN error is repairable, will retry", {
							query_id: queryId,
							attempt,
							sqlstate: pgError.sqlstate,
							error_class: errorClassification.errorClass,
							hint: getSQLSTATEHint(pgError.sqlstate),
						})

						// Continue to next attempt
						continue
					}

					// Max attempts reached or unknown error
					return buildErrorResponse({
						queryId,
						question,
						databaseId,
						sql: finalSQL,
						confidence: currentConfidence,
						tablesUsed,
						errorType: "execution",
						errorMessage: `Database error after ${attempt} attempts: ${pgError.message}`,
						recoverable: false,
						trace,
						pythonLatency: totalPythonLatency,
						validationLatency: totalValidationLatency,
						postgresLatency: totalPostgresLatency,
						startTime,
						pythonTrace,
						attempt,
						context: {
							postgres_error: pgError,
							error_class: errorClassification.errorClass,
							max_attempts_reached: true,
						},
					}, logger)
				}
				// autocorrectExplainPassed is true - will proceed to execution after finally

			} finally {
				if (client) {
					client.release()
				}
			}

			totalPostgresLatency += Date.now() - explainStart

			// Determine the SQL to execute (use autocorrected SQL if available)
			const sqlToExecute = autocorrectExplainPassed && autocorrectSQL ? autocorrectSQL : finalSQL

			// --- Step 4: Execute Query ---
			const executeStart = Date.now()
			client = await pool.connect()

			try {
				// Set statement timeout for actual execution
				await client.query(`SET statement_timeout = ${timeout_seconds * 1000}`)

				// Execute query
				const queryResult = await client.query(sqlToExecute)
				const executeLatency = Date.now() - executeStart
				totalPostgresLatency += executeLatency

				logger.info("Query executed successfully", {
					query_id: queryId,
					attempt,
					rows_returned: queryResult.rows.length,
					execution_time_ms: executeLatency,
				})

				// Capture execution latency for stage profiling
				if (EXAM_MODE && currentExamEntry?.stage_latencies) currentExamEntry.stage_latencies.execution_ms = executeLatency

				// Record success for exam
				recordExamExecutionResult(true, queryResult.rows.length, Date.now() - startTime)
				recordExamRetrySuccess(attempt)
				finalizeShadowObservations("success")

				// === SUCCESS - Build and return response ===
				const autocorrectNote = autocorrectExplainPassed ? " [Autocorrect applied]" : ""
				const response: NLQueryResponse = {
					query_id: queryId,
					question,
					database_id: databaseId,
					sql_generated: sqlToExecute,
					sql_valid: true,
					validation_warnings: validationWarnings,
					executed: true,
					execution_time_ms: executeLatency,
					rows_returned: queryResult.rows.length,
					rows: queryResult.rows,
					confidence_score: Math.max(0, currentConfidence),
					notes: attempt > 1 ? `${notes || ""}${autocorrectNote} [Repaired after ${attempt} attempts]`.trim() : (autocorrectNote ? `${notes || ""}${autocorrectNote}`.trim() : notes),
					tables_used: tablesUsed,
					trace: trace
						? {
								python_latency_ms: totalPythonLatency,
								validation_latency_ms: totalValidationLatency,
								postgres_latency_ms: totalPostgresLatency,
								retrieval_latency_ms: totalRetrievalLatency,
								total_latency_ms: Date.now() - startTime,
								tables_selected: schemaContext?.tables.length,
								modules: schemaContext?.modules,
								...pythonTrace,
						  }
						: undefined,
				}

				// Audit log
				logAudit({
					query_id: queryId,
					timestamp: new Date(),
					database_id: databaseId,
					question,
					sql_generated: sqlToExecute,
					sql_valid: true,
					executed: true,
					rows_returned: queryResult.rows.length,
					execution_time_ms: executeLatency,
					python_latency_ms: totalPythonLatency,
					confidence_score: currentConfidence,
				}, logger)

				// Record final stage latencies for exam
				if (EXAM_MODE && currentExamEntry?.stage_latencies) {
					currentExamEntry.stage_latencies.retrieval_ms = totalRetrievalLatency
					currentExamEntry.stage_latencies.total_ms = Date.now() - startTime
				}

				// Finalize exam entry
				finalizeExamEntry(logger)

				return response

			} catch (executeError) {
				totalPostgresLatency += Date.now() - executeStart

				// Parse PostgreSQL error
				const pgError = parsePostgresError(executeError)

				// Classify the execution error
				const errorClassification = classifyExecutionError(
					pgError.sqlstate,
					pgError.message,
					false,
				)

				logger.error("Query execution failed", {
					query_id: queryId,
					attempt,
					sql: sqlToExecute,
					sqlstate: pgError.sqlstate,
					message: pgError.message,
					error_class: errorClassification.errorClass,
					should_retry: errorClassification.shouldRetry,
				})

				// Infrastructure errors - fail immediately
				if (errorClassification.errorClass === "infra_failure") {
					return buildErrorResponse({
						queryId,
						question,
						databaseId,
						sql: sqlToExecute,
						confidence: currentConfidence,
						tablesUsed,
						errorType: "execution",
						errorMessage: `Infrastructure error: ${errorClassification.reason}`,
						recoverable: false,
						trace,
						pythonLatency: totalPythonLatency,
						validationLatency: totalValidationLatency,
						postgresLatency: totalPostgresLatency,
						startTime,
						pythonTrace,
						attempt,
						context: {
							postgres_error: pgError,
							error_class: errorClassification.errorClass,
						},
					}, logger)
				}

				// Timeout errors
				if (errorClassification.errorClass === "query_timeout") {
					// Allow retry if attempts remain
					if (attempt < maxAttempts) {
						lastPostgresError = pgError
						logger.warn("Query timeout, will retry with simpler query", {
							query_id: queryId,
							attempt,
							error_class: errorClassification.errorClass,
						})
						continue
					}

					return buildErrorResponse({
						queryId,
						question,
						databaseId,
						sql: sqlToExecute,
						confidence: currentConfidence,
						tablesUsed,
						errorType: "timeout",
						errorMessage: `Query timeout: ${pgError.message}`,
						recoverable: false,
						trace,
						pythonLatency: totalPythonLatency,
						validationLatency: totalValidationLatency,
						postgresLatency: totalPostgresLatency,
						startTime,
						pythonTrace,
						attempt,
						context: {
							postgres_error: pgError,
							error_class: errorClassification.errorClass,
						},
					}, logger)
				}

				// Check if fail-fast (validation_block)
				if (isFailFastError(pgError.sqlstate)) {
					return buildErrorResponse({
						queryId,
						question,
						databaseId,
						sql: sqlToExecute,
						confidence: currentConfidence,
						tablesUsed,
						errorType: "execution",
						errorMessage: `Database error: ${pgError.message}`,
						recoverable: false,
						trace,
						pythonLatency: totalPythonLatency,
						validationLatency: totalValidationLatency,
						postgresLatency: totalPostgresLatency,
						startTime,
						pythonTrace,
						attempt,
						context: {
							postgres_error: pgError,
							error_class: "validation_block",
						},
					}, logger)
				}

				// Check if repairable and more attempts available
				if (errorClassification.shouldRetry && attempt < maxAttempts) {
					lastPostgresError = pgError

					logger.info("Execution error is repairable, will retry", {
						query_id: queryId,
						attempt,
						sqlstate: pgError.sqlstate,
						error_class: errorClassification.errorClass,
					})

					continue
				}

				// Return error
				return buildErrorResponse({
					queryId,
					question,
					databaseId,
					sql: sqlToExecute,
					confidence: currentConfidence,
					tablesUsed,
					errorType: "execution",
					errorMessage: `Database error: ${pgError.message}`,
					recoverable: false,
					trace,
					pythonLatency: totalPythonLatency,
					validationLatency: totalValidationLatency,
					postgresLatency: totalPostgresLatency,
					startTime,
					pythonTrace,
					attempt,
					context: {
						postgres_error: pgError,
						error_class: errorClassification.errorClass,
					},
				}, logger)

			} finally {
				client.release()
			}
		}

		// Max attempts reached without success
		logger.error("Max repair attempts exceeded", {
			query_id: queryId,
			attempts: attempt,
			last_sql: currentSQL,
			last_validator_issues: lastValidatorIssues.map(i => i.code),
			last_postgres_error: lastPostgresError?.sqlstate,
		})

		return buildErrorResponse({
			queryId,
			question,
			databaseId,
			sql: currentSQL,
			confidence: currentConfidence,
			tablesUsed,
			errorType: "validation",
			errorMessage: `Failed to generate valid SQL after ${maxAttempts} attempts`,
			recoverable: false,
			trace,
			pythonLatency: totalPythonLatency,
			validationLatency: totalValidationLatency,
			postgresLatency: totalPostgresLatency,
			startTime,
			pythonTrace,
			attempt,
			context: {
				max_attempts_reached: true,
				last_validator_issues: lastValidatorIssues,
				last_postgres_error: lastPostgresError,
			},
		}, logger)

	} catch (error) {
		// Handle NL2SQLError
		if (error instanceof NL2SQLError) {
			logger.error("NL2SQL error", {
				query_id: queryId,
				error_type: error.type,
				error_message: error.message,
				recoverable: error.recoverable,
			})

			return buildErrorResponse({
				queryId,
				question,
				databaseId,
				sql: currentSQL,
				confidence: currentConfidence,
				tablesUsed,
				errorType: error.type,
				errorMessage: error.message,
				recoverable: error.recoverable,
				trace,
				pythonLatency: totalPythonLatency,
				validationLatency: totalValidationLatency,
				postgresLatency: totalPostgresLatency,
				startTime,
				pythonTrace,
				attempt,
				context: error.context,
			}, logger)
		}

		// Handle unknown errors
		logger.error("Unknown error in nl_query", {
			query_id: queryId,
			error: String(error),
		})

		return buildErrorResponse({
			queryId,
			question,
			databaseId,
			sql: currentSQL,
			confidence: 0,
			tablesUsed: [],
			errorType: "execution",
			errorMessage: `Unexpected error: ${String(error)}`,
			recoverable: false,
			trace,
			pythonLatency: totalPythonLatency,
			validationLatency: totalValidationLatency,
			postgresLatency: totalPostgresLatency,
			startTime,
			pythonTrace,
			attempt,
		}, logger)
	}
}

/**
 * Parse PostgreSQL error into structured format
 */
function parsePostgresError(error: unknown): PostgresErrorContext {
	if (error && typeof error === "object") {
		const pgError = error as {
			code?: string
			message?: string
			hint?: string
			detail?: string
			position?: number
		}

		return {
			sqlstate: pgError.code || "UNKNOWN",
			message: pgError.message || String(error),
			hint: pgError.hint,
			detail: pgError.detail,
			position: pgError.position,
		}
	}

	return {
		sqlstate: "UNKNOWN",
		message: String(error),
	}
}

/**
 * Build error response helper
 */
interface ErrorResponseParams {
	queryId: string
	question: string
	databaseId: string
	sql: string
	confidence: number
	tablesUsed: string[]
	errorType: "generation" | "validation" | "execution" | "timeout"
	errorMessage: string
	recoverable: boolean
	trace: boolean
	pythonLatency: number
	validationLatency: number
	postgresLatency: number
	startTime: number
	pythonTrace?: any
	attempt: number
	context?: Record<string, any>
}

function buildErrorResponse(params: ErrorResponseParams, logger: any): NLQueryResponse {
	const {
		queryId,
		question,
		databaseId,
		sql,
		confidence,
		tablesUsed,
		errorType,
		errorMessage,
		recoverable,
		trace,
		pythonLatency,
		validationLatency,
		postgresLatency,
		startTime,
		pythonTrace,
		attempt,
		context,
	} = params

	const response: NLQueryResponse = {
		query_id: queryId,
		question,
		database_id: databaseId,
		sql_generated: sql,
		sql_valid: false,
		executed: false,
		confidence_score: Math.max(0, confidence),
		tables_used: tablesUsed,
		trace: trace
			? {
					python_latency_ms: pythonLatency,
					validation_latency_ms: validationLatency,
					postgres_latency_ms: postgresLatency,
					total_latency_ms: Date.now() - startTime,
					...pythonTrace,
			  }
			: undefined,
		error: {
			type: errorType,
			message: errorMessage,
			recoverable,
			context: { ...context, attempt },
		},
	}

	// Classify failure for exam mode
	if (EXAM_MODE) {
		const sqlstate = context?.postgres_error?.sqlstate || context?.sqlstate
		const errorClass = context?.error_class as ExecutionErrorClass | undefined
		let failureType: FullExamLogEntry["failure_type"] = "execution_error"
		let failureDetails = errorMessage

		// Use error_class if available (from new classification)
		if (errorClass === "infra_failure") {
			failureType = "infra_failure"
			failureDetails = `Infrastructure failure: ${errorMessage}`
		} else if (errorClass === "query_timeout" || errorType === "timeout") {
			failureType = "query_timeout"
			failureDetails = `Query timeout: ${errorMessage}`
		} else if (errorClass === "validation_block") {
			failureType = "validation_block"
			failureDetails = `Validation blocked: ${errorMessage}`
		} else if (sqlstate === "42703") {
			failureType = "column_miss"
			failureDetails = `Undefined column: ${parseUndefinedColumn(errorMessage)?.column || errorMessage}`
		} else if (sqlstate === "42P01") {
			failureType = "join_path_miss"
		} else if (errorMessage.includes("MISSING_ENTITY") || errorMessage.includes("HALLUCINATED_VALUE")) {
			failureType = "value_miss"
		} else if (sqlstate && sqlstate.startsWith("42")) {
			failureType = "llm_reasoning"
			failureDetails = `SQL error ${sqlstate}: ${errorMessage}`
		} else if (errorType === "validation") {
			failureType = "llm_reasoning"
		}

		recordExamExecutionResult(false, undefined, Date.now() - startTime)
		finalizeShadowObservations("failure")
		recordExamFailure(failureType, failureDetails, errorClass)
		// Record total timing in stage_latencies (other stages already recorded incrementally)
		if (currentExamEntry?.stage_latencies) {
			currentExamEntry.stage_latencies.total_ms = Date.now() - params.startTime
		}
		finalizeExamEntry(logger)
	}

	// Audit log
	logAudit({
		query_id: queryId,
		timestamp: new Date(),
		database_id: databaseId,
		question,
		sql_generated: sql,
		sql_valid: false,
		executed: false,
		error: errorMessage,
		python_latency_ms: pythonLatency,
		confidence_score: confidence,
	}, logger)

	return response
}

/**
 * Log audit entry
 *
 * MVP: Logs to console (structured JSON)
 * Phase 5: Will log to database or Elasticsearch
 */
function logAudit(entry: AuditLogEntry, logger: any): void {
	logger.info("AUDIT_LOG", entry)
}

// ============================================================================
// Exam Instrumentation
// ============================================================================

/**
 * Full exam log entry for end-to-end diagnostics
 */
interface FullExamLogEntry {
	timestamp: string
	query_id: string
	question: string
	retriever_version: "V1"

	// Retrieval results
	tables_retrieved: string[]
	tables_from_table_retrieval: number
	tables_from_column_only: number
	tables_from_fk_expansion: number

	// Score details
	table_scores: Array<{ table: string; similarity: number }>
	column_hits_per_table: Record<string, number>
	top_columns_per_table?: Record<string, Array<{ column: string; similarity: number }>>
	fused_scores?: Array<{ table: string; fused: number; table_sim: number; col_score: number }>

	// FK expansion
	fk_expansion_candidates: number
	fk_expansion_added: number
	fk_expansion_blocked_count: number
	fk_expansion_blocked: Array<{ table: string; reason: string }>

	// Thresholds used
	config: {
		table_threshold: number
		column_threshold: number
		table_weight: number
		column_weight: number
	}

	// SQL generation
	sql_generated: string
	tables_used_in_sql: string[]

	// Execution result
	explain_result: "success" | "fail"
	sqlstate?: string
	error_message?: string
	execution_success: boolean
	rows_returned?: number

	// Failure classification
	failure_type?: "retrieval_miss" | "join_path_miss" | "column_miss" | "value_miss" | "llm_reasoning" | "execution_error" | "infra_failure" | "query_timeout" | "validation_block"
	failure_details?: string

	// Execution error classification (V2)
	error_class?: ExecutionErrorClass

	// Repair loop
	attempt_count: number
	retry_succeeded: boolean

	// Autocorrect
	autocorrect_attempted?: boolean
	autocorrect_success?: boolean
	autocorrect_correction?: string
	autocorrect_candidates?: number
	autocorrect_failure_reason?: string

	// Lint
	lint_errors?: number
	lint_warnings?: number
	lint_issues?: Array<{ code: string; severity: string }>

	// Multi-candidate evaluation
	multi_candidate?: {
		enabled: boolean
		k_used: number
		difficulty: string
		candidates_generated: number
		candidates_passed_explain: number
		candidates_rejected: number
		selected_candidate_index: number | null
		evaluation_time_ms: number
		timed_out: boolean
		candidate_scores: Array<{
			index: number
			score: number
			explain_result: string
			lint_errors: number
			rejected: boolean
			rejection_reason: string | null
		}>
	}

	// Pre-execution column validation
	pre_exec_column_validation?: {
		valid: boolean
		missing_columns: Array<{
			alias: string
			column: string
			resolved_table: string | null
			suggested_columns: string[]
		}>
		unresolved_aliases: string[]
	}

	// Surgical whitelist telemetry
	surgical_whitelist?: {
		whitelist_triggered: boolean
		whitelist_tables_count: number
		whitelist_columns_total: number
		alias_resolution: {
			success: boolean
			alias: string | null
			resolved_table: string | null
			ambiguity: boolean
		}
		deterministic_rewrites: Array<{
			from_column: string
			to_column: string
			table: string
			confidence: number
			applied: boolean
			rejection_reason?: string
		}>
		repair_used_whitelist: boolean
		whitelist_prompt_size?: number
	}

	// Shadow whitelist observations (one per 42703 attempt)
	shadow_whitelist_observations?: WhitelistShadowObservation[]

	// Schema linking (Phase 1)
	schema_link?: {
		tables_linked: number
		columns_linked: number
		unsupported_concepts: string[]
		top_linked: Array<{ table: string; column: string; concept: string; score: number }>
	}

	// Join planning (Phase 2)
	join_plan?: {
		used: boolean
		candidate_count: number
		selected_tables: string[]
		skeleton_sql: string | null
		cross_module_detected?: boolean
		bridge_tables?: string[]
		modules_used?: string[]
		score_details?: {
			hopCount: number
			semanticAlignment: number
			columnCoverage: number
			combined: number
		}
	}

	// PG normalization
	pg_normalize?: {
		applied: boolean
		transforms: string[]
		changed: boolean
	}

	// Phase 1: Retrieval upgrades
	module_route?: { modules: string[]; confidences: number[]; method: string }
	bm25_tables?: string[]
	fusion_method?: string
	columns_pruned?: number

	// Pre-SQL (Phase 3.1)
	pre_sql?: {
		sketch_sql: string
		referenced_tables: string[]
		missing_tables: string[]
		additional_tables: string[]
		latency_ms: number
	}

	// Reranker (Phase 3)
	reranker?: RerankerDetail[]

	// Token counts (from Ollama via sidecar)
	prompt_tokens?: number
	completion_tokens?: number

	// Per-stage latency profiling
	stage_latencies?: {
		retrieval_ms?: number
		glosses_ms?: number
		linker_ms?: number
		pruning_ms?: number
		planner_ms?: number
		pre_sql_ms?: number
		reranker_ms?: number
		first_generation_ms?: number
		validation_ms?: number
		execution_ms?: number
		total_ms?: number
	}

	// Timing
	embedding_latency_ms: number
	total_retrieval_latency_ms: number
	total_latency_ms: number
}

// Module-level state for exam logging (populated during query execution)
let currentExamEntry: Partial<FullExamLogEntry> | null = null

// Shadow observation state for surgical whitelist precision measurement
let shadowObservations: WhitelistShadowObservation[] = []

/**
 * Initialize exam entry at start of query
 */
function initExamEntry(queryId: string, question: string): void {
	if (!EXAM_MODE) return
	shadowObservations = []
	currentExamEntry = {
		timestamp: new Date().toISOString(),
		query_id: queryId,
		question,
		attempt_count: 0,
		retry_succeeded: false,
		execution_success: false,
	}
}

/**
 * Record retrieval metrics to exam entry
 */
function recordExamRetrievalMetrics(metrics: RetrievalMetrics): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.retriever_version = "V2"
	currentExamEntry.tables_retrieved = metrics.final_tables
	currentExamEntry.tables_from_table_retrieval = metrics.tables_from_table_retrieval
	currentExamEntry.tables_from_column_only = metrics.tables_from_column_only
	currentExamEntry.tables_from_fk_expansion = metrics.fk_expansion_added
	currentExamEntry.table_scores = metrics.table_similarities
	currentExamEntry.column_hits_per_table = metrics.column_hits_per_table
	currentExamEntry.top_columns_per_table = metrics.top_columns_per_table
	currentExamEntry.fused_scores = metrics.fused_scores
	currentExamEntry.fk_expansion_candidates = metrics.fk_expansion_candidates
	currentExamEntry.fk_expansion_added = metrics.fk_expansion_added
	currentExamEntry.fk_expansion_blocked_count = metrics.fk_expansion_blocked_no_evidence
	currentExamEntry.fk_expansion_blocked = metrics.fk_expansion_blocked || []
	currentExamEntry.config = {
		table_threshold: metrics.table_threshold_used,
		column_threshold: metrics.column_threshold_used,
		table_weight: metrics.fusion_weights.table,
		column_weight: metrics.fusion_weights.column,
	}
	currentExamEntry.embedding_latency_ms = metrics.embedding_latency_ms
	currentExamEntry.total_retrieval_latency_ms = metrics.total_latency_ms
}

/**
 * Record SQL generation to exam entry
 */
function recordExamSQL(sql: string, tablesUsed: string[], attempt: number): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.sql_generated = sql
	currentExamEntry.tables_used_in_sql = tablesUsed
	currentExamEntry.attempt_count = attempt
}

/**
 * Record EXPLAIN result to exam entry
 */
function recordExamExplainResult(success: boolean, sqlstate?: string, message?: string): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.explain_result = success ? "success" : "fail"
	if (!success) {
		currentExamEntry.sqlstate = sqlstate
		currentExamEntry.error_message = message
	}
}

/**
 * Record autocorrect attempt to exam entry
 */
function recordExamAutocorrect(result: AutocorrectResult): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.autocorrect_attempted = result.attempted
	currentExamEntry.autocorrect_success = result.success
	if (result.correction) {
		currentExamEntry.autocorrect_correction = result.correction
	}
	if (result.candidates) {
		currentExamEntry.autocorrect_candidates = result.candidates.length
	}
	if (result.failure_reason) {
		currentExamEntry.autocorrect_failure_reason = result.failure_reason
	}
}

/**
 * Record surgical whitelist telemetry to exam entry
 */
function recordExamSurgicalWhitelist(telemetry: WhitelistTelemetry): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.surgical_whitelist = {
		whitelist_triggered: telemetry.whitelist_triggered,
		whitelist_tables_count: telemetry.whitelist_tables_count,
		whitelist_columns_total: telemetry.whitelist_columns_total,
		alias_resolution: telemetry.alias_resolution,
		deterministic_rewrites: telemetry.deterministic_rewrites,
		repair_used_whitelist: telemetry.repair_used_whitelist,
		whitelist_prompt_size: telemetry.whitelist_prompt_size,
	}
}

/**
 * Record schema link bundle to exam entry
 */
function recordExamSchemaLink(bundle: SchemaLinkBundle): void {
	if (!EXAM_MODE || !currentExamEntry) return

	const topLinked: Array<{ table: string; column: string; concept: string; score: number }> = []
	for (const [table, cols] of Object.entries(bundle.linkedColumns)) {
		for (const col of cols) {
			topLinked.push({ table, column: col.column, concept: col.concept, score: col.relevance })
		}
	}
	topLinked.sort((a, b) => b.score - a.score)

	currentExamEntry.schema_link = {
		tables_linked: bundle.linkedTables.length,
		columns_linked: Object.values(bundle.linkedColumns).flat().length,
		unsupported_concepts: bundle.unsupportedConcepts,
		top_linked: topLinked.slice(0, 10),
	}
}

/**
 * Record join plan to exam entry
 */
function recordExamJoinPlan(plan: JoinPlan): void {
	if (!EXAM_MODE || !currentExamEntry) return

	const skeleton = plan.skeletons[0] || null
	currentExamEntry.join_plan = {
		used: plan.skeletons.length > 0,
		candidate_count: plan.skeletons.length,
		selected_tables: skeleton?.tables || [],
		skeleton_sql: skeleton?.sqlFragment || null,
		cross_module_detected: plan.crossModuleDetected,
		bridge_tables: plan.bridgeTables,
		modules_used: plan.modulesUsed,
		score_details: skeleton?.scoreDetails,
	}
}

/**
 * Record PG normalization result to exam entry
 */
function recordExamPgNormalize(result: PgNormalizeResult): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.pg_normalize = {
		applied: result.changed,
		transforms: result.applied,
		changed: result.changed,
	}
}

/**
 * Record shadow whitelist observations to exam entry
 */
function recordExamShadowObservations(obs: WhitelistShadowObservation[]): void {
	if (!EXAM_MODE || !currentExamEntry) return
	currentExamEntry.shadow_whitelist_observations = obs
}

/**
 * Finalize shadow observations with pipeline outcome and precision labels.
 * Called at success/failure paths before exam entry is written.
 */
function finalizeShadowObservations(pipelineOutcome: "success" | "failure"): void {
	for (const obs of shadowObservations) {
		obs.pipeline_outcome = pipelineOutcome
		// Use active gate (stricter tier) for precision labels
		const wouldAct = obs.active_gating_passed ?? (obs.would_rewrite && obs.strict_gating_passed)
		obs.would_have_helped = pipelineOutcome === "failure" && wouldAct
		obs.would_have_been_redundant = pipelineOutcome === "success" && wouldAct
		obs.would_have_acted_on_success = pipelineOutcome === "success" && wouldAct
	}
	if (shadowObservations.length > 0) {
		recordExamShadowObservations(shadowObservations)
	}
	shadowObservations = []
}

/**
 * Record multi-candidate evaluation result to exam entry
 */
function recordExamMultiCandidate(result: MultiCandidateResult): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.multi_candidate = {
		enabled: true,
		k_used: result.kUsed,
		difficulty: result.difficulty,
		candidates_generated: result.candidatesGenerated,
		candidates_passed_explain: result.candidatesPassedExplain,
		candidates_rejected: result.candidatesRejected,
		selected_candidate_index: result.selectedCandidate?.index || null,
		evaluation_time_ms: result.evaluationTimeMs,
		timed_out: result.timedOut,
		candidate_scores: result.allCandidates.map(c => ({
			index: c.index,
			score: c.score,
			explain_result: c.explainPassed === true ? "pass" : c.explainPassed === false ? "fail" : "skipped",
			lint_errors: c.scoreBreakdown.lintErrors,
			rejected: c.rejected,
			rejection_reason: c.rejectionReason,
		})),
	}
}

/**
 * Record execution result to exam entry
 */
function recordExamExecutionResult(success: boolean, rowsReturned?: number, totalLatencyMs?: number): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.execution_success = success
	if (success) {
		currentExamEntry.rows_returned = rowsReturned
	}
	if (totalLatencyMs) {
		currentExamEntry.total_latency_ms = totalLatencyMs
	}
}

/**
 * Record failure classification to exam entry
 */
function recordExamFailure(
	failureType: FullExamLogEntry["failure_type"],
	details?: string,
	errorClass?: ExecutionErrorClass,
): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.failure_type = failureType
	currentExamEntry.failure_details = details
	if (errorClass) {
		currentExamEntry.error_class = errorClass
	}
}

/**
 * Record retry success to exam entry
 */
function recordExamRetrySuccess(attempt: number): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.retry_succeeded = attempt > 1
	currentExamEntry.attempt_count = attempt
}

/**
 * Finalize and write exam entry to JSONL
 */
function finalizeExamEntry(logger: any): void {
	if (!EXAM_MODE || !currentExamEntry) return

	const entry = currentExamEntry as FullExamLogEntry

	// Log concise console prefix
	const status = entry.execution_success ? "✓" : `✗ ${entry.failure_type || "unknown"}`
	logger.info(`EXAM_RETRIEVAL [${status}] tables=${entry.tables_retrieved?.length || 0} attempt=${entry.attempt_count}`, {
		query_id: entry.query_id,
		question: entry.question?.substring(0, 60),
	})

	// Write to JSONL
	writeExamLog(entry)

	// Reset for next query
	currentExamEntry = null
}

/**
 * Write exam log entry to JSONL file
 */
function writeExamLog(entry: FullExamLogEntry): void {
	const logDir = process.env.EXAM_LOG_DIR || "./exam_logs"
	const logFile = path.join(logDir, `exam_retrieval_${new Date().toISOString().split("T")[0]}.jsonl`)

	try {
		// Ensure directory exists
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true })
		}

		// Append entry as JSONL
		fs.appendFileSync(logFile, JSON.stringify(entry) + "\n")
	} catch (err) {
		// Don't fail the query if logging fails
		console.error("Failed to write exam log:", err)
	}
}

/**
 * Legacy function for backward compatibility
 */
function logExamRetrievalMetrics(
	queryId: string,
	question: string,
	metrics: RetrievalMetrics,
	logger: any,
): void {
	// Just record metrics, don't write yet (will be written at end)
	recordExamRetrievalMetrics(metrics)
}

/**
 * Exam result classification
 *
 * Call this after query execution to classify the failure type.
 */
export interface ExamResultClassification {
	query_id: string
	question: string
	success: boolean
	failure_type?: "retrieval_miss" | "join_path_miss" | "column_miss" | "value_miss" | "llm_reasoning" | "execution_error" | "infra_failure" | "query_timeout" | "validation_block"
	failure_details?: string

	// For diagnosis
	expected_tables?: string[]
	retrieved_tables: string[]
	missing_tables?: string[]
	extra_tables?: string[]

	sql_generated: string
	error_message?: string
	sqlstate?: string

	// Error classification (V2)
	error_class?: ExecutionErrorClass
}

/**
 * Classify exam result failure type
 *
 * Call with expected tables (from ground truth) to diagnose failures.
 */
export function classifyExamFailure(
	queryId: string,
	question: string,
	retrievedTables: string[],
	expectedTables: string[] | undefined,
	sqlGenerated: string,
	error?: { type: string; message: string; sqlstate?: string },
): ExamResultClassification {
	const result: ExamResultClassification = {
		query_id: queryId,
		question,
		success: !error,
		retrieved_tables: retrievedTables,
		sql_generated: sqlGenerated,
	}

	if (!error) {
		return result
	}

	result.error_message = error.message
	result.sqlstate = error.sqlstate

	// Classify execution error using the new classification system
	if (error.sqlstate) {
		const errorClassification = classifyExecutionError(
			error.sqlstate,
			error.message,
			false,
		)
		result.error_class = errorClassification.errorClass

		// Infrastructure failure - don't waste time diagnosing SQL issues
		if (errorClassification.errorClass === "infra_failure") {
			result.failure_type = "infra_failure"
			result.failure_details = `Infrastructure: ${errorClassification.reason}`
			return result
		}

		// Query timeout
		if (errorClassification.errorClass === "query_timeout") {
			result.failure_type = "query_timeout"
			result.failure_details = `Timeout: ${error.message}`
			return result
		}

		// Validation block
		if (errorClassification.errorClass === "validation_block") {
			result.failure_type = "validation_block"
			result.failure_details = `Blocked: ${error.message}`
			return result
		}
	}

	// Check for retrieval miss
	if (expectedTables) {
		result.expected_tables = expectedTables
		result.missing_tables = expectedTables.filter(t => !retrievedTables.includes(t))
		result.extra_tables = retrievedTables.filter(t => !expectedTables.includes(t))

		if (result.missing_tables.length > 0) {
			result.failure_type = "retrieval_miss"
			result.failure_details = `Missing tables: ${result.missing_tables.join(", ")}`
			return result
		}
	}

	// Check for column miss (42703)
	if (error.sqlstate === "42703") {
		result.failure_type = "column_miss"
		const col = parseUndefinedColumn(error.message)?.column
		result.failure_details = `Undefined column: ${col || error.message}`
		return result
	}

	// Check for join path miss (42P01 on a table that should have been retrieved via FK)
	if (error.sqlstate === "42P01") {
		result.failure_type = "join_path_miss"
		result.failure_details = error.message
		return result
	}

	// Check for value miss (semantic error - wrong entity referenced)
	if (error.message.includes("MISSING_ENTITY") || error.message.includes("HALLUCINATED_VALUE")) {
		result.failure_type = "value_miss"
		result.failure_details = error.message
		return result
	}

	// Check for execution errors
	if (error.sqlstate && error.sqlstate.startsWith("42")) {
		result.failure_type = "llm_reasoning"
		result.failure_details = `SQL error ${error.sqlstate}: ${error.message}`
		return result
	}

	// Default to execution error
	result.failure_type = "execution_error"
	result.failure_details = error.message
	return result
}
