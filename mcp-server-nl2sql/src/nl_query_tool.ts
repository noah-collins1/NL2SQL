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
import { validateSQL, ValidationResult } from "./sql_validator.js"
import { lintSQL, LintResult, lintIssuesToValidatorIssues, formatLintIssuesForRepair } from "./sql_lint.js"
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
	USE_SCHEMA_RAG_V2,
	EXAM_MODE,
	ExecutionErrorClass,
} from "./config.js"
import {
	SchemaRetriever,
	getSchemaRetriever,
	getAllowedTables,
} from "./schema_retriever.js"
import {
	SchemaRetrieverV2,
	getSchemaRetrieverV2,
	getAllowedTablesV2,
} from "./schema_retriever_v2.js"
import {
	getColumnCandidateFinder,
	formatCandidatesForPrompt,
	extractUndefinedColumn,
	generateColumnWhitelistBlock,
	buildColumnWhitelist,
	buildMinimalWhitelist,
	formatMinimalWhitelistForRepair,
	validateSQLColumns,
	formatColumnValidationErrors,
	ColumnValidationResult,
	MinimalWhitelistResult,
} from "./column_candidates.js"
import { SchemaContextPacket, RetrievalMetrics, renderSchemaBlock } from "./schema_types.js"
import { attemptAutocorrect, AutocorrectResult } from "./sql_autocorrect.js"
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
	let retrievalMetrics: RetrievalMetrics | null = null

	// Repair loop state
	let attempt = 0
	let lastValidatorIssues: ValidatorIssue[] = []
	let lastPostgresError: PostgresErrorContext | undefined

	try {
		// === SCHEMA RETRIEVAL (for RAG-based databases) ===
		if (useRAG) {
			const retrievalStart = Date.now()

			const useV2 = USE_SCHEMA_RAG_V2

			logger.info("Using Schema RAG for table selection", {
				query_id: queryId,
				database_id: databaseId,
				retriever_version: useV2 ? "V2" : "V1",
			})

			if (useV2) {
				// V2: Dual retrieval + score fusion
				const retrieverV2 = getSchemaRetrieverV2(pool, logger)
				const result = await retrieverV2.retrieveSchemaContext(
					question,
					databaseId,
				)
				schemaContext = result.packet
				retrievalMetrics = result.metrics
				allowedTables = getAllowedTablesV2(schemaContext)

				// Exam mode: log detailed retrieval metrics
				if (EXAM_MODE) {
					logExamRetrievalMetrics(queryId, question, retrievalMetrics, logger)
				}
			} else {
				// V1: Original retrieval
				const retriever = getSchemaRetriever(pool, logger)
				schemaContext = await retriever.retrieveSchemaContext(
					question,
					databaseId,
				)
				allowedTables = getAllowedTables(schemaContext)
			}

			totalRetrievalLatency = Date.now() - retrievalStart

			logger.info("Schema retrieval complete", {
				query_id: queryId,
				retriever_version: useV2 ? "V2" : "V1",
				tables_selected: schemaContext.tables.length,
				table_names: schemaContext.tables.map(t => t.table_name),
				modules: schemaContext.modules,
				retrieval_latency_ms: totalRetrievalLatency,
			})
		} else {
			// Use hardcoded tables for non-RAG databases
			allowedTables = (dbConfig as typeof MCPTEST_CONFIG).allowedTables || []
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
				// First attempt: generate fresh SQL
				const pythonRequest: NLQueryRequest = {
					question,
					database_id: databaseId,
					max_rows,
					timeout_seconds,
					explain,
					trace,
					// Include schema context for RAG-based databases
					schema_context: schemaContext || undefined,
				}

				pythonResponse = await pythonClient.generateSQL(pythonRequest)
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

			totalPythonLatency += Date.now() - pythonStart

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

			totalValidationLatency += Date.now() - validationStart

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

			// --- Step 2.6: Pre-Execution Column Validation (DISABLED) ---
			// Pre-execution validation was too aggressive and caused false positives.
			// We now rely solely on post-EXPLAIN 42703 error repair with minimal whitelist.
			// This preserves baseline behavior while still providing targeted repair guidance.
			let columnWhitelist: Record<string, string[]> | undefined
			const PRE_EXECUTION_VALIDATION_ENABLED = false  // Disabled due to false positives
			if (schemaContext && PRE_EXECUTION_VALIDATION_ENABLED) {
				columnWhitelist = buildColumnWhitelist(schemaContext)
				const columnValidation = validateSQLColumns(finalSQL, columnWhitelist)

				if (!columnValidation.valid) {
					logger.warn("Column validation failed (pre-execution)", {
						query_id: queryId,
						attempt,
						missing_columns: columnValidation.missingColumns.map(
							m => `${m.alias}.${m.column} (table: ${m.resolvedTable})`
						),
					})

					// Record for exam logging
					recordExamColumnValidation(columnValidation)

					// Skip EXPLAIN and trigger repair with column validation errors
					if (attempt < maxAttempts) {
						// Create validator issues from column validation
						const columnIssues: ValidatorIssue[] = columnValidation.missingColumns.map(m => ({
							code: "COLUMN_NOT_EXISTS",
							severity: "error" as const,
							message: `Column '${m.column}' does not exist in table '${m.resolvedTable}'`,
							suggestion: m.availableColumns.length > 0
								? `Available columns: ${m.availableColumns.slice(0, 5).join(", ")}`
								: undefined,
						}))

						lastValidatorIssues = [...lastValidatorIssues, ...columnIssues]

						// Build minimal whitelist for the first missing column
						const firstMissing = columnValidation.missingColumns[0]
						const minimalWhitelistText = firstMissing && firstMissing.resolvedTable
							? formatMinimalWhitelistForRepair({
								alias: firstMissing.alias,
								resolvedTable: firstMissing.resolvedTable,
								failingColumn: firstMissing.column,
								whitelist: columnWhitelist, // This is already built above
								neighborTables: [],
							})
							: ""

						// Set as postgres-like error to trigger minimal whitelist in repair
						lastPostgresError = {
							sqlstate: "42703",
							message: `Pre-execution check: Column '${firstMissing?.column || "unknown"}' does not exist in table '${firstMissing?.resolvedTable || "unknown"}'`,
							minimal_whitelist: firstMissing && firstMissing.resolvedTable ? {
								alias: firstMissing.alias,
								resolved_table: firstMissing.resolvedTable,
								failing_column: firstMissing.column,
								whitelist: { [firstMissing.resolvedTable]: firstMissing.availableColumns },
								formatted_text: minimalWhitelistText,
							} : undefined,
						}

						logger.info("Column validation failed, skipping EXPLAIN and triggering repair", {
							query_id: queryId,
							attempt,
							missing_count: columnValidation.missingColumns.length,
							first_missing: firstMissing ? `${firstMissing.alias}.${firstMissing.column} -> ${firstMissing.resolvedTable}` : null,
						})

						currentSQL = finalSQL
						continue
					}
				}
			}

			// --- Step 3: EXPLAIN-First Safety Check ---
			const explainStart = Date.now()
			let client: PoolClient | null = null
			let autocorrectExplainPassed = false
			let autocorrectSQL: string | null = null

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

				// Enrich 42703 (undefined column) errors with column candidates and MINIMAL whitelist
				// Note: Works with both V1 and V2 retrievers - only needs schemaContext
				if (pgError.sqlstate === "42703" && schemaContext) {
					try {
						const candidateFinder = getColumnCandidateFinder(pool, logger)
						const enrichedError = await candidateFinder.enrichErrorWithCandidates(
							pgError,
							databaseId,
							schemaContext,
							finalSQL, // Pass the failed SQL for table context extraction
						)

						// Build MINIMAL whitelist (only the relevant table + FK neighbors)
						const minimalResult = buildMinimalWhitelist(
							pgError.message,
							finalSQL,
							schemaContext,
							true, // Include 1-hop FK neighbors
						)

						// Format the minimal whitelist for the repair prompt
						const minimalWhitelistText = formatMinimalWhitelistForRepair(minimalResult)

						pgError = {
							...enrichedError,
							// Include minimal whitelist data for Python sidecar
							minimal_whitelist: {
								alias: minimalResult.alias,
								resolved_table: minimalResult.resolvedTable,
								failing_column: minimalResult.failingColumn,
								whitelist: minimalResult.whitelist,
								neighbor_tables: minimalResult.neighborTables,
								formatted_text: minimalWhitelistText,
							},
						}

						logger.debug("Enriched 42703 error with minimal whitelist", {
							query_id: queryId,
							undefined_column: enrichedError.undefined_column,
							resolved_table: minimalResult.resolvedTable,
							alias: minimalResult.alias,
							whitelist_tables: Object.keys(minimalResult.whitelist),
							neighbor_tables: minimalResult.neighborTables,
						})
					} catch (candidateError) {
						logger.warn("Failed to enrich error with column candidates", {
							query_id: queryId,
							error: String(candidateError),
						})
					}
				}

				logger.warn("EXPLAIN check failed", {
					query_id: queryId,
					attempt,
					sql: finalSQL,
					sqlstate: pgError.sqlstate,
					message: pgError.message,
				})

				// Record EXPLAIN failure for exam
				recordExamExplainResult(false, pgError.sqlstate, pgError.message)

				// --- AUTOCORRECT: Try deterministic fix before LLM repair ---
				if (schemaContext && (pgError.sqlstate === "42703" || pgError.sqlstate === "42P01")) {
					const autocorrectResult = attemptAutocorrect(
						finalSQL,
						pgError.sqlstate,
						pgError.message,
						schemaContext,
					)

					// Log autocorrect attempt for exam
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

						// Re-run EXPLAIN with corrected SQL
						try {
							const retryClient = await pool.connect()
							try {
								await retryClient.query(`SET statement_timeout = ${REPAIR_CONFIG.explainTimeout}`)
								await retryClient.query(`EXPLAIN (FORMAT JSON) ${correctedSQL}`)
								logger.info("Autocorrect EXPLAIN passed", { query_id: queryId })
								recordExamExplainResult(true)
								// Set flag to skip to execution with corrected SQL
								autocorrectExplainPassed = true
								autocorrectSQL = correctedSQL
								// Update exam SQL with corrected version
								recordExamSQL(correctedSQL, tablesUsed, attempt)
							} finally {
								retryClient.release()
							}
						} catch (retryError) {
							// Autocorrect didn't fully fix the issue
							logger.warn("Autocorrect EXPLAIN still failed", {
								query_id: queryId,
								error: String(retryError),
							})
							// Update currentSQL for subsequent LLM repair attempts
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

				// Record success for exam
				recordExamExecutionResult(true, queryResult.rows.length, Date.now() - startTime)
				recordExamRetrySuccess(attempt)

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
			failureDetails = `Undefined column: ${extractUndefinedColumn(errorMessage) || errorMessage}`
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
		recordExamFailure(failureType, failureDetails, errorClass)
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
	retriever_version: "V1" | "V2"

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

	// Timing
	embedding_latency_ms: number
	total_retrieval_latency_ms: number
	total_latency_ms: number
}

// Module-level state for exam logging (populated during query execution)
let currentExamEntry: Partial<FullExamLogEntry> | null = null

/**
 * Initialize exam entry at start of query
 */
function initExamEntry(queryId: string, question: string): void {
	if (!EXAM_MODE) return
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
 * Record pre-execution column validation result to exam entry
 */
function recordExamColumnValidation(result: ColumnValidationResult): void {
	if (!EXAM_MODE || !currentExamEntry) return

	currentExamEntry.pre_exec_column_validation = {
		valid: result.valid,
		missing_columns: result.missingColumns.map(m => ({
			alias: m.alias,
			column: m.column,
			resolved_table: m.resolvedTable,
			suggested_columns: m.availableColumns.slice(0, 3),
		})),
		unresolved_aliases: result.unresolvedAliases,
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
		const col = extractUndefinedColumn(error.message)
		result.failure_details = `Undefined column: ${col}`
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
