/**
 * Python Sidecar HTTP Client
 *
 * Handles communication with the Python AI sidecar service.
 *
 * Responsibilities:
 * - Send NL questions to Python /generate_sql endpoint
 * - Handle timeouts and retries
 * - Health checks and circuit breaker (Phase 5)
 * - Cache invalidation (Phase 2)
 */

import {
	PYTHON_SIDECAR_CONFIG,
	NLQueryRequest,
	PythonSidecarResponse,
	RepairSQLRequest,
	NL2SQLError,
} from "./config.js"

/**
 * Embedding response from Python sidecar
 */
export interface EmbedResponse {
	embedding: number[]
	model: string
	dimensions: number
}

export class PythonClient {
	private baseUrl: string
	private timeout: number
	private healthCheckInterval?: NodeJS.Timeout
	private isHealthy: boolean = true

	constructor(baseUrl?: string, timeout?: number) {
		this.baseUrl = baseUrl || PYTHON_SIDECAR_CONFIG.baseUrl
		this.timeout = timeout || PYTHON_SIDECAR_CONFIG.timeout
	}

	/**
	 * Generate SQL from natural language question
	 */
	async generateSQL(
		request: NLQueryRequest,
	): Promise<PythonSidecarResponse> {
		const startTime = Date.now()

		// Circuit breaker: if Python is unhealthy, fail fast
		if (!this.isHealthy) {
			throw new NL2SQLError(
				"generation",
				"Python sidecar service is unavailable. Please try again later.",
				true, // recoverable
				{ baseUrl: this.baseUrl }
			)
		}

		const url = `${this.baseUrl}${PYTHON_SIDECAR_CONFIG.endpoints.generateSQL}`

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), this.timeout)

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Accept": "application/json",
				},
				body: JSON.stringify(request),
				signal: controller.signal,
			})

			clearTimeout(timeoutId)

			if (!response.ok) {
				const errorText = await response.text()
				throw new NL2SQLError(
					"generation",
					`Python sidecar returned error: ${response.status} ${errorText}`,
					response.status >= 500, // 5xx errors are recoverable
					{ statusCode: response.status, responseBody: errorText }
				)
			}

			const data = await response.json() as PythonSidecarResponse

			// Add latency to trace if not already present
			if (!data.trace) {
				data.trace = {
					stage1_tables: [],
					ollama_latency_ms: 0,
					total_latency_ms: Date.now() - startTime,
				}
			}

			return data
		} catch (error) {
			// Handle timeout
			if (error instanceof Error && error.name === "AbortError") {
				throw new NL2SQLError(
					"timeout",
					`Python sidecar request timed out after ${this.timeout}ms`,
					true, // recoverable
					{ timeout: this.timeout, url }
				)
			}

			// Handle network errors
			if (error instanceof TypeError) {
				// Mark as unhealthy
				this.isHealthy = false

				throw new NL2SQLError(
					"generation",
					`Cannot connect to Python sidecar at ${this.baseUrl}. Is it running?`,
					true, // recoverable
					{ baseUrl: this.baseUrl, originalError: error.message }
				)
			}

			// Re-throw NL2SQLError as-is
			if (error instanceof NL2SQLError) {
				throw error
			}

			// Wrap unknown errors
			throw new NL2SQLError(
				"generation",
				`Unexpected error communicating with Python sidecar: ${error}`,
				false, // not recoverable
				{ originalError: String(error) }
			)
		}
	}

	/**
	 * Repair SQL based on validation or execution errors
	 *
	 * Sends the failed SQL along with error context to Python sidecar
	 * for repair attempt using the repair prompt template.
	 */
	async repairSQL(request: RepairSQLRequest): Promise<PythonSidecarResponse> {
		const startTime = Date.now()

		// Circuit breaker: if Python is unhealthy, fail fast
		if (!this.isHealthy) {
			throw new NL2SQLError(
				"generation",
				"Python sidecar service is unavailable. Please try again later.",
				true,
				{ baseUrl: this.baseUrl }
			)
		}

		const url = `${this.baseUrl}${PYTHON_SIDECAR_CONFIG.endpoints.repairSQL}`

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), this.timeout)

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Accept": "application/json",
				},
				body: JSON.stringify(request),
				signal: controller.signal,
			})

			clearTimeout(timeoutId)

			if (!response.ok) {
				const errorText = await response.text()
				throw new NL2SQLError(
					"generation",
					`Python sidecar repair failed: ${response.status} ${errorText}`,
					response.status >= 500,
					{ statusCode: response.status, responseBody: errorText }
				)
			}

			const data = await response.json() as PythonSidecarResponse

			// Add latency to trace if not already present
			if (!data.trace) {
				data.trace = {
					stage1_tables: [],
					ollama_latency_ms: 0,
					total_latency_ms: Date.now() - startTime,
				}
			}

			return data
		} catch (error) {
			// Handle timeout
			if (error instanceof Error && error.name === "AbortError") {
				throw new NL2SQLError(
					"timeout",
					`Python sidecar repair timed out after ${this.timeout}ms`,
					true,
					{ timeout: this.timeout, url }
				)
			}

			// Handle network errors
			if (error instanceof TypeError) {
				this.isHealthy = false
				throw new NL2SQLError(
					"generation",
					`Cannot connect to Python sidecar at ${this.baseUrl}. Is it running?`,
					true,
					{ baseUrl: this.baseUrl, originalError: error.message }
				)
			}

			// Re-throw NL2SQLError as-is
			if (error instanceof NL2SQLError) {
				throw error
			}

			// Wrap unknown errors
			throw new NL2SQLError(
				"generation",
				`Unexpected error during SQL repair: ${error}`,
				false,
				{ originalError: String(error) }
			)
		}
	}

	/**
	 * Get embedding for text via Python sidecar
	 *
	 * Uses nomic-embed-text (768 dimensions) via Ollama
	 */
	async embedText(text: string, model?: string): Promise<number[]> {
		const url = `${this.baseUrl}/embed`

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), 30000) // 30s timeout for embeddings

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Accept": "application/json",
				},
				body: JSON.stringify({
					text,
					model: model || "nomic-embed-text:latest",
				}),
				signal: controller.signal,
			})

			clearTimeout(timeoutId)

			if (!response.ok) {
				const errorText = await response.text()
				throw new NL2SQLError(
					"generation",
					`Embedding request failed: ${response.status} ${errorText}`,
					response.status >= 500,
					{ statusCode: response.status, responseBody: errorText },
				)
			}

			const data = (await response.json()) as EmbedResponse
			return data.embedding
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new NL2SQLError(
					"timeout",
					"Embedding request timed out",
					true,
					{ timeout: 30000, url },
				)
			}

			if (error instanceof NL2SQLError) {
				throw error
			}

			throw new NL2SQLError(
				"generation",
				`Embedding error: ${error}`,
				false,
				{ originalError: String(error) },
			)
		}
	}

	/**
	 * Get embeddings for multiple texts via Python sidecar (batch)
	 *
	 * More efficient than calling embedText repeatedly.
	 * Uses nomic-embed-text (768 dimensions) via Ollama.
	 */
	async embedBatch(texts: string[], model?: string): Promise<number[][]> {
		const url = `${this.baseUrl}/embed_batch`

		try {
			const controller = new AbortController()
			// Longer timeout for batches: 60s base + 1s per text
			const timeout = Math.min(60000 + texts.length * 1000, 300000)
			const timeoutId = setTimeout(() => controller.abort(), timeout)

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Accept": "application/json",
				},
				body: JSON.stringify({
					texts,
					model: model || "nomic-embed-text:latest",
				}),
				signal: controller.signal,
			})

			clearTimeout(timeoutId)

			if (!response.ok) {
				const errorText = await response.text()
				throw new NL2SQLError(
					"generation",
					`Batch embedding request failed: ${response.status} ${errorText}`,
					response.status >= 500,
					{ statusCode: response.status, responseBody: errorText },
				)
			}

			const data = (await response.json()) as { embeddings: number[][]; model: string; count: number }
			return data.embeddings
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new NL2SQLError(
					"timeout",
					`Batch embedding request timed out (${texts.length} texts)`,
					true,
					{ timeout: 60000 + texts.length * 1000, url },
				)
			}

			if (error instanceof NL2SQLError) {
				throw error
			}

			throw new NL2SQLError(
				"generation",
				`Batch embedding error: ${error}`,
				false,
				{ originalError: String(error) },
			)
		}
	}

	/**
	 * Health check endpoint
	 *
	 * Returns true if Python sidecar is reachable and healthy.
	 */
	async healthCheck(): Promise<boolean> {
		const url = `${this.baseUrl}${PYTHON_SIDECAR_CONFIG.endpoints.health}`

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout

			const response = await fetch(url, {
				method: "GET",
				signal: controller.signal,
			})

			clearTimeout(timeoutId)

			this.isHealthy = response.ok
			return response.ok
		} catch (error) {
			this.isHealthy = false
			return false
		}
	}

	/**
	 * Start periodic health checks (Phase 5)
	 *
	 * Checks Python sidecar health every 30 seconds.
	 * Updates internal health status for circuit breaker.
	 */
	startHealthChecks(intervalMs: number = 30000): void {
		if (this.healthCheckInterval) {
			return // Already running
		}

		// Initial health check
		this.healthCheck().catch(() => {
			// Ignore errors, just update status
		})

		// Periodic checks
		this.healthCheckInterval = setInterval(async () => {
			await this.healthCheck().catch(() => {
				// Ignore errors, status already updated in healthCheck()
			})
		}, intervalMs)
	}

	/**
	 * Stop periodic health checks
	 */
	stopHealthChecks(): void {
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval)
			this.healthCheckInterval = undefined
		}
	}

	/**
	 * Invalidate Python sidecar caches (Phase 2+)
	 *
	 * Used when database schema changes.
	 */
	async invalidateCache(databaseId: string): Promise<void> {
		const url = `${this.baseUrl}${PYTHON_SIDECAR_CONFIG.endpoints.invalidateCache}`

		try {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), 5000)

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ database_id: databaseId }),
				signal: controller.signal,
			})

			clearTimeout(timeoutId)

			if (!response.ok) {
				throw new Error(`Cache invalidation failed: ${response.status}`)
			}
		} catch (error) {
			// Log error but don't throw - cache invalidation failure shouldn't break queries
			console.error(`Failed to invalidate Python cache for ${databaseId}:`, error)
		}
	}

	/**
	 * Get health status
	 */
	isHealthyStatus(): boolean {
		return this.isHealthy
	}

	/**
	 * Force set health status (for testing)
	 */
	setHealthStatus(healthy: boolean): void {
		this.isHealthy = healthy
	}
}

/**
 * Singleton instance for convenience
 */
let defaultClient: PythonClient | null = null

export function getPythonClient(): PythonClient {
	if (!defaultClient) {
		defaultClient = new PythonClient()
	}
	return defaultClient
}

/**
 * Reset singleton (for testing)
 */
export function resetPythonClient(): void {
	if (defaultClient) {
		defaultClient.stopHealthChecks()
		defaultClient = null
	}
}
