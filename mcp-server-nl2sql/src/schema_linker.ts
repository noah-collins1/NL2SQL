/**
 * Schema Linker (RSL-SQL Style)
 *
 * Produces a compact "schema link bundle" that forces the LLM to only use
 * grounded columns. This is the main anti-hallucination mechanism.
 *
 * Algorithm:
 * 1. Extract keyphrases from question
 * 2. Match keyphrases to columns using gloss synonyms + fuzzy matching
 * 3. Rank tables by matched columns
 * 4. Detect value hints (quoted strings, numbers)
 * 5. Identify unsupported concepts
 */

import type { SchemaContextPacket } from "./schema_types.js"
import { generateGlosses, type SchemaGlosses, type ColumnGloss } from "./schema_glosses.js"

// ============================================================================
// Feature Flag
// ============================================================================

import { getConfig } from "./config/loadConfig.js"

export const SCHEMA_LINKER_ENABLED = process.env.SCHEMA_LINKER_ENABLED !== undefined
	? process.env.SCHEMA_LINKER_ENABLED === "true"
	: getConfig().features.schema_linker

// ============================================================================
// Types
// ============================================================================

export interface SchemaLinkBundle {
	linkedTables: Array<{ table: string; relevance: number; reason: string }>
	linkedColumns: Record<string, Array<{ column: string; relevance: number; concept: string }>>
	joinHints: Array<{ from: string; to: string; via: string }>
	valueHints: Array<{ value: string; likelyColumn: string; likelyTable: string }>
	unsupportedConcepts: string[]
}

// ============================================================================
// Stopwords
// ============================================================================

const STOPWORDS = new Set([
	"a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "shall", "can", "need", "must",
	"i", "me", "my", "we", "our", "you", "your", "he", "she", "it",
	"they", "them", "their", "this", "that", "these", "those",
	"what", "which", "who", "whom", "whose", "where", "when", "how",
	"not", "no", "nor", "but", "or", "and", "if", "then", "else",
	"of", "at", "by", "for", "with", "about", "to", "from", "in", "on",
	"as", "into", "through", "during", "before", "after", "above", "below",
	"between", "out", "off", "over", "under", "again", "further",
	"all", "each", "every", "both", "few", "more", "most", "other",
	"some", "such", "only", "own", "same", "so", "than", "too", "very",
	"just", "because", "also", "there", "here",
	// SQL-like words that aren't concepts
	"show", "give", "list", "find", "get", "display", "tell",
	"many", "much", "long", "number",
])

/** Metric words that suggest aggregation but aren't column names */
const METRIC_WORDS = new Set([
	"total", "count", "average", "avg", "sum", "maximum", "minimum",
	"max", "min", "highest", "lowest", "most", "least", "top", "bottom",
	"per", "each", "every", "overall", "combined",
])

// ============================================================================
// Keyphrase Extraction
// ============================================================================

interface Keyphrase {
	text: string
	tokens: string[]
	isQuotedValue: boolean
	isNumber: boolean
	isMetric: boolean
}

/**
 * Extract keyphrases from a natural language question.
 */
export function extractKeyphrases(question: string): Keyphrase[] {
	const keyphrases: Keyphrase[] = []

	// Extract quoted strings first
	const quotedPattern = /["']([^"']+)["']/g
	let match: RegExpExecArray | null
	while ((match = quotedPattern.exec(question)) !== null) {
		keyphrases.push({
			text: match[1],
			tokens: match[1].toLowerCase().split(/\s+/),
			isQuotedValue: true,
			isNumber: false,
			isMetric: false,
		})
	}

	// Remove quoted strings for further processing
	const withoutQuotes = question.replace(/["'][^"']+["']/g, " ")

	// Tokenize remaining text
	const tokens = withoutQuotes
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter(t => t.length > 0)

	for (const token of tokens) {
		if (STOPWORDS.has(token)) continue

		// Check if it's a number
		const isNumber = /^\d+(\.\d+)?$/.test(token)

		// Check if it's a metric word
		const isMetric = METRIC_WORDS.has(token)

		keyphrases.push({
			text: token,
			tokens: [token],
			isQuotedValue: false,
			isNumber,
			isMetric,
		})
	}

	// Also extract multi-word phrases (bigrams) for better matching
	for (let i = 0; i < tokens.length - 1; i++) {
		if (STOPWORDS.has(tokens[i]) || STOPWORDS.has(tokens[i + 1])) continue
		if (METRIC_WORDS.has(tokens[i]) && METRIC_WORDS.has(tokens[i + 1])) continue

		keyphrases.push({
			text: `${tokens[i]} ${tokens[i + 1]}`,
			tokens: [tokens[i], tokens[i + 1]],
			isQuotedValue: false,
			isNumber: false,
			isMetric: false,
		})
	}

	return keyphrases
}

// ============================================================================
// Matching
// ============================================================================

/**
 * Compute token overlap score between keyphrase and column gloss.
 * Returns 0-1 score.
 */
function computeMatchScore(keyphrase: Keyphrase, gloss: ColumnGloss, columnName: string): number {
	if (keyphrase.isQuotedValue || keyphrase.isNumber) return 0

	const kTokens = keyphrase.tokens
	let bestScore = 0

	// Check against synonyms
	for (const kToken of kTokens) {
		for (const synonym of gloss.synonyms) {
			// Exact match
			if (kToken === synonym) {
				bestScore = Math.max(bestScore, 1.0)
			}
			// Prefix match (e.g., "employ" matches "employee")
			else if (synonym.startsWith(kToken) && kToken.length >= 3) {
				bestScore = Math.max(bestScore, 0.8)
			}
			// Contained (e.g., "salary" in "base_salary")
			else if (synonym.includes(kToken) && kToken.length >= 4) {
				bestScore = Math.max(bestScore, 0.7)
			}
		}
	}

	// Check against column name directly
	const colTokens = columnName.toLowerCase().split("_")
	for (const kToken of kTokens) {
		for (const colToken of colTokens) {
			if (kToken === colToken) {
				bestScore = Math.max(bestScore, 1.0)
			} else if (colToken.startsWith(kToken) && kToken.length >= 3) {
				bestScore = Math.max(bestScore, 0.8)
			}
		}
	}

	// Check type hint matching (e.g., keyphrase "date" matches typeHint "date/timestamp")
	for (const kToken of kTokens) {
		if (gloss.typeHint.toLowerCase().includes(kToken) && kToken.length >= 3) {
			bestScore = Math.max(bestScore, 0.5)
		}
	}

	return bestScore
}

// ============================================================================
// Main Entry Point
// ============================================================================

/** Minimum match score for a column to be considered linked */
const MIN_LINK_SCORE = 0.5

/** Minimum table relevance to be included */
const MIN_TABLE_RELEVANCE = 0.1

/**
 * Perform schema linking: match NL question to schema columns.
 *
 * @param question - Natural language question
 * @param schemaContext - Schema context from retrieval
 * @param glosses - Pre-computed glosses (optional, will generate if not provided)
 * @returns SchemaLinkBundle with linked tables, columns, and hints
 */
export function linkSchema(
	question: string,
	schemaContext: SchemaContextPacket,
	glosses?: SchemaGlosses,
): SchemaLinkBundle {
	// Generate glosses if not provided
	const g = glosses || generateGlosses(schemaContext)

	// Extract keyphrases
	const keyphrases = extractKeyphrases(question)

	// Match keyphrases to columns
	const columnMatches: Map<string, Array<{ column: string; score: number; concept: string }>> = new Map()
	const matchedConcepts = new Set<string>()

	for (const table of schemaContext.tables) {
		const tableMatches: Array<{ column: string; score: number; concept: string }> = []

		for (const [key, gloss] of g) {
			if (!key.startsWith(`${table.table_name}.`)) continue
			const columnName = key.split(".")[1]

			for (const kp of keyphrases) {
				if (kp.isQuotedValue || kp.isNumber || kp.isMetric) continue

				const score = computeMatchScore(kp, gloss, columnName)
				if (score >= MIN_LINK_SCORE) {
					tableMatches.push({
						column: columnName,
						score,
						concept: kp.text,
					})
					matchedConcepts.add(kp.text)
				}
			}
		}

		// Deduplicate: keep best score per column
		const bestByColumn = new Map<string, { column: string; score: number; concept: string }>()
		for (const match of tableMatches) {
			const existing = bestByColumn.get(match.column)
			if (!existing || match.score > existing.score) {
				bestByColumn.set(match.column, match)
			}
		}

		if (bestByColumn.size > 0) {
			columnMatches.set(
				table.table_name,
				Array.from(bestByColumn.values()).sort((a, b) => b.score - a.score),
			)
		}
	}

	// Rank tables by: (a) number of matched columns, (b) max column match score, (c) retrieval similarity
	const tableScores: Array<{ table: string; relevance: number; reason: string }> = []
	for (const table of schemaContext.tables) {
		const matches = columnMatches.get(table.table_name)
		const matchCount = matches?.length || 0
		const maxScore = matches ? Math.max(...matches.map(m => m.score)) : 0

		// Weighted relevance: column matches + retrieval similarity
		const relevance = (matchCount * 0.3 + maxScore * 0.4 + table.similarity * 0.3)

		const reasons: string[] = []
		if (matches) {
			reasons.push(`matched: ${matches.map(m => `"${m.concept}"`).join(", ")}`)
		}
		if (table.similarity >= 0.5) {
			reasons.push("high retrieval similarity")
		}

		tableScores.push({
			table: table.table_name,
			relevance,
			reason: reasons.join("; ") || "retrieval",
		})
	}

	tableScores.sort((a, b) => b.relevance - a.relevance)

	// Build linked columns output
	const linkedColumns: Record<string, Array<{ column: string; relevance: number; concept: string }>> = {}
	for (const [tableName, matches] of columnMatches) {
		linkedColumns[tableName] = matches.map(m => ({
			column: m.column,
			relevance: m.score,
			concept: m.concept,
		}))
	}

	// Build join hints from FK edges
	const joinHints = schemaContext.fk_edges.map(edge => ({
		from: `${edge.from_table}.${edge.from_column}`,
		to: `${edge.to_table}.${edge.to_column}`,
		via: edge.from_column,
	}))

	// Detect value hints: quoted strings → look for text columns
	const valueHints: Array<{ value: string; likelyColumn: string; likelyTable: string }> = []
	for (const kp of keyphrases) {
		if (!kp.isQuotedValue) continue

		// Find text columns that might hold this value
		for (const table of schemaContext.tables) {
			for (const [key, gloss] of g) {
				if (!key.startsWith(`${table.table_name}.`)) continue
				const columnName = key.split(".")[1]

				// Text columns with "name", "label", "title", "code", "status", "type" hints
				if (["name/label", "text", "status enum", "type/category", "code identifier", "description/text"].includes(gloss.typeHint)) {
					valueHints.push({
						value: kp.text,
						likelyColumn: columnName,
						likelyTable: table.table_name,
					})
				}
			}
		}
	}

	// Identify unsupported concepts: keyphrases with no column match
	const unsupportedConcepts: string[] = []
	for (const kp of keyphrases) {
		if (kp.isQuotedValue || kp.isNumber || kp.isMetric) continue
		if (kp.tokens.length > 1) continue // Skip bigrams for unsupported detection
		if (!matchedConcepts.has(kp.text)) {
			unsupportedConcepts.push(kp.text)
		}
	}

	return {
		linkedTables: tableScores.filter(t => t.relevance >= MIN_TABLE_RELEVANCE),
		linkedColumns,
		joinHints,
		valueHints,
		unsupportedConcepts,
	}
}

// ============================================================================
// Prompt Formatting
// ============================================================================

/**
 * Format a SchemaLinkBundle as a "Schema Contract" section for the LLM prompt.
 */
export function formatSchemaLinkForPrompt(
	bundle: SchemaLinkBundle,
	glosses: SchemaGlosses,
): string {
	const lines: string[] = []

	lines.push("## Schema Contract (MANDATORY)")
	lines.push("You MUST only use columns from this list. Do not invent columns.")
	lines.push("")

	// Required tables
	lines.push("### Required Tables")
	for (let i = 0; i < bundle.linkedTables.length; i++) {
		const t = bundle.linkedTables[i]
		lines.push(`${i + 1}. ${t.table} (relevance: ${t.relevance.toFixed(2)}) — ${t.reason}`)
	}
	lines.push("")

	// Allowed columns
	lines.push("### Allowed Columns")
	for (const t of bundle.linkedTables) {
		const cols = bundle.linkedColumns[t.table]
		if (!cols || cols.length === 0) {
			// Include all columns from this table (no specific matches)
			const allCols: string[] = []
			for (const [key, gloss] of glosses) {
				if (key.startsWith(`${t.table}.`)) {
					const colName = key.split(".")[1]
					const tags: string[] = []
					if (gloss.isPK) tags.push("PK")
					if (gloss.isFK && gloss.fkTarget) tags.push(`FK→${gloss.fkTarget}`)
					if (gloss.typeHint !== "general") tags.push(gloss.typeHint.toUpperCase().split("/")[0])
					allCols.push(tags.length > 0 ? `${colName} [${tags.join(", ")}]` : colName)
				}
			}
			lines.push(`**${t.table}:** ${allCols.join(", ")}`)
		} else {
			// Include matched columns with their matched concepts
			const colParts: string[] = []
			// Also include all columns from the table so the LLM has the full picture
			for (const [key, gloss] of glosses) {
				if (key.startsWith(`${t.table}.`)) {
					const colName = key.split(".")[1]
					const matchedCol = cols.find(c => c.column === colName)
					const tags: string[] = []
					if (gloss.isPK) tags.push("PK")
					if (gloss.isFK && gloss.fkTarget) tags.push(`FK→${gloss.fkTarget}`)
					if (matchedCol) tags.push(`matched: "${matchedCol.concept}"`)
					else if (gloss.typeHint !== "general") tags.push(gloss.typeHint.toUpperCase().split("/")[0])
					colParts.push(tags.length > 0 ? `${colName} [${tags.join(", ")}]` : colName)
				}
			}
			lines.push(`**${t.table}:** ${colParts.join(", ")}`)
		}
	}
	lines.push("")

	// Join plan
	if (bundle.joinHints.length > 0) {
		lines.push("### Join Plan")
		for (const hint of bundle.joinHints) {
			lines.push(`${hint.from} → ${hint.to}`)
		}
		lines.push("")
	}

	// Value hints
	if (bundle.valueHints.length > 0) {
		lines.push("### Value Hints")
		// Deduplicate by value
		const seen = new Set<string>()
		for (const vh of bundle.valueHints) {
			if (seen.has(vh.value)) continue
			seen.add(vh.value)
			lines.push(`- "${vh.value}" → likely in ${vh.likelyTable}.${vh.likelyColumn}`)
		}
		lines.push("")
	}

	return lines.join("\n")
}
