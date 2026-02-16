/**
 * Schema Grounding: Glosses + Schema Linker
 *
 * Consolidated module combining:
 * - schema_glosses.ts — Deterministic column gloss generation with synonym expansion + type hints
 * - schema_linker.ts — Keyphrase extraction + column matching → SchemaLinkBundle for prompt grounding
 */

import type { SchemaContextPacket } from "./schema_types.js"
import { getConfig } from "./config/loadConfig.js"

// ============================================================================
// Feature Flags
// ============================================================================

export const SCHEMA_GLOSSES_ENABLED = process.env.SCHEMA_GLOSSES_ENABLED !== undefined
	? process.env.SCHEMA_GLOSSES_ENABLED !== "false"
	: getConfig().features.glosses

export const SCHEMA_LINKER_ENABLED = process.env.SCHEMA_LINKER_ENABLED !== undefined
	? process.env.SCHEMA_LINKER_ENABLED === "true"
	: getConfig().features.schema_linker

// ============================================================================
// Gloss Types
// ============================================================================

export interface ColumnGloss {
	/** Human-readable description */
	description: string
	/** Synonym tokens for matching */
	synonyms: string[]
	/** Inferred type hint */
	typeHint: string
	/** Whether this is a primary key */
	isPK: boolean
	/** Whether this is a foreign key */
	isFK: boolean
	/** FK target table if applicable */
	fkTarget: string | null
	/** Original data type from schema */
	dataType: string
}

/** Map of "table.column" → ColumnGloss */
export type SchemaGlosses = Map<string, ColumnGloss>

// ============================================================================
// Linker Types
// ============================================================================

export interface SchemaLinkBundle {
	linkedTables: Array<{ table: string; relevance: number; reason: string }>
	linkedColumns: Record<string, Array<{ column: string; relevance: number; concept: string }>>
	joinHints: Array<{ from: string; to: string; via: string }>
	valueHints: Array<{ value: string; likelyColumn: string; likelyTable: string }>
	unsupportedConcepts: string[]
}

// ============================================================================
// Abbreviation Mappings
// ============================================================================

const ABBREVIATION_MAP: Record<string, string[]> = {
	// Quantity / Amount
	qty: ["quantity"],
	quantity: ["qty"],
	amt: ["amount"],
	amount: ["amt"],
	num: ["number"],
	number: ["num", "nbr"],
	nbr: ["number"],
	// Text fields
	desc: ["description"],
	description: ["desc"],
	txt: ["text"],
	// Address / Location
	addr: ["address"],
	address: ["addr"],
	// Org structure
	dept: ["department"],
	department: ["dept"],
	emp: ["employee"],
	employee: ["emp"],
	emplid: ["employee id", "employee identifier"],
	mgr: ["manager"],
	manager: ["mgr"],
	org: ["organization"],
	organization: ["org"],
	// Percentage
	pct: ["percent", "percentage"],
	percent: ["pct"],
	percentage: ["pct"],
	// Time
	yr: ["year"],
	year: ["yr"],
	mo: ["month"],
	month: ["mo"],
	dt: ["date"],
	date: ["dt"],
	strt: ["start"],
	start: ["strt"],
	// Identifiers
	id: ["identifier", "key"],
	no: ["number"],
	cd: ["code"],
	code: ["cd"],
	// Categories
	cat: ["category"],
	category: ["cat"],
	grp: ["group"],
	group: ["grp"],
	lvl: ["level"],
	level: ["lvl"],
	// Entities
	cust: ["customer"],
	customer: ["cust"],
	prod: ["product"],
	product: ["prod"],
	acct: ["account"],
	account: ["acct"],
	// Status / Approval
	sts: ["status"],
	status: ["sts"],
	aprvl: ["approval"],
	approval: ["aprvl"],
	// Documents / Transactions
	inv: ["invoice", "inventory"],
	po: ["purchase order"],
	so: ["sales order"],
	txn: ["transaction"],
	trnx: ["transaction"],
	transaction: ["txn", "trnx"],
	hdr: ["header"],
	header: ["hdr"],
	ln: ["line"],
	dtl: ["detail", "line"],
	// Manufacturing
	mfg: ["manufacturing"],
	manufacturing: ["mfg"],
	wo: ["work order"],
	bom: ["bill of materials"],
	mfr: ["manufacturer"],
	wh: ["warehouse"],
	warehouse: ["wh"],
	// Financial
	tot: ["total"],
	total: ["tot"],
	bal: ["balance"],
	balance: ["bal"],
	consol: ["consolidation"],
	consolidation: ["consol"],
	elim: ["elimination"],
	elimination: ["elim"],
	ic: ["intercompany"],
	intercompany: ["ic"],
	fx: ["foreign exchange"],
	// Services / Retail
	svc: ["service"],
	service: ["svc"],
	rsrc: ["resource"],
	resource: ["rsrc"],
	sow: ["statement of work"],
	rtl: ["retail"],
	retail: ["rtl"],
	pos: ["point of sale"],
	promo: ["promotion"],
	promotion: ["promo"],
	// Corporate
	corp: ["corporate"],
	corporate: ["corp"],
}

// ============================================================================
// Type Hint Inference
// ============================================================================

const SUFFIX_TYPE_HINTS: Array<{ suffixes: string[]; hint: string }> = [
	{ suffixes: ["_id", "id"], hint: "identifier/key" },
	{ suffixes: ["_date", "_at", "_on", "_time", "_timestamp", "_ts"], hint: "date/timestamp" },
	{ suffixes: ["_amount", "_total", "_cost", "_price", "_rate", "_value", "_salary", "_budget", "_revenue", "_balance"], hint: "monetary amount" },
	{ suffixes: ["_count", "_qty", "_quantity", "_num", "_number"], hint: "quantity" },
	{ suffixes: ["_name", "_title", "_label"], hint: "name/label" },
	{ suffixes: ["_status"], hint: "status enum" },
	{ suffixes: ["_type", "_category", "_kind", "_class"], hint: "type/category" },
	{ suffixes: ["_code"], hint: "code identifier" },
	{ suffixes: ["_pct", "_percent", "_percentage", "_ratio"], hint: "percentage/ratio" },
	{ suffixes: ["_desc", "_description", "_note", "_notes", "_comment", "_comments"], hint: "description/text" },
	{ suffixes: ["_email"], hint: "email address" },
	{ suffixes: ["_phone", "_tel", "_fax"], hint: "phone number" },
	{ suffixes: ["_addr", "_address", "_street", "_city", "_state", "_zip", "_country"], hint: "address/location" },
	{ suffixes: ["_flag", "_is_", "_has_", "_can_"], hint: "boolean flag" },
	{ suffixes: ["_url", "_link", "_path"], hint: "URL/path" },
]

const EXACT_NAME_HINTS: Record<string, string> = {
	salary: "monetary amount",
	budget: "monetary amount",
	revenue: "monetary amount",
	cost: "monetary amount",
	price: "monetary amount",
	amount: "monetary amount",
	total: "monetary amount",
	balance: "monetary amount",
	rate: "monetary amount",
	quantity: "quantity",
	qty: "quantity",
	count: "quantity",
	name: "name/label",
	title: "name/label",
	status: "status enum",
	type: "type/category",
	category: "type/category",
	code: "code identifier",
	email: "email address",
	phone: "phone number",
	address: "address/location",
	date: "date/timestamp",
	description: "description/text",
}

// ============================================================================
// Gloss Core Functions
// ============================================================================

export function splitSnakeCase(name: string): string[] {
	return name
		.toLowerCase()
		.split("_")
		.filter(token => token.length > 0)
}

export function inferTypeHint(name: string, dataType: string): string {
	const lowerName = name.toLowerCase()

	if (EXACT_NAME_HINTS[lowerName]) {
		return EXACT_NAME_HINTS[lowerName]
	}

	for (const { suffixes, hint } of SUFFIX_TYPE_HINTS) {
		for (const suffix of suffixes) {
			if (suffix.startsWith("_")) {
				if (lowerName.endsWith(suffix)) return hint
			} else {
				if (lowerName === suffix) return hint
			}
		}
	}

	const lowerType = dataType.toLowerCase()
	if (lowerType.includes("int") || lowerType.includes("serial")) return "numeric"
	if (lowerType.includes("numeric") || lowerType.includes("decimal") || lowerType.includes("float") || lowerType.includes("double") || lowerType.includes("real")) return "numeric"
	if (lowerType.includes("date") || lowerType.includes("time") || lowerType.includes("timestamp")) return "date/timestamp"
	if (lowerType.includes("bool")) return "boolean flag"
	if (lowerType.includes("text") || lowerType.includes("varchar") || lowerType.includes("char")) return "text"

	return "general"
}

export function glossColumn(
	columnName: string,
	dataType: string,
	isPK: boolean,
	isFK: boolean,
	fkTarget: string | null,
): ColumnGloss {
	const tokens = splitSnakeCase(columnName)
	const typeHint = inferTypeHint(columnName, dataType)

	const parts: string[] = []
	if (isPK) parts.push("Primary key")
	else if (isFK && fkTarget) parts.push(`Foreign key → ${fkTarget}`)

	const wordDescription = tokens.join(" ")
	if (typeHint !== "general") {
		parts.push(`${wordDescription} (${typeHint})`)
	} else {
		parts.push(wordDescription)
	}

	const description = parts.join(". ")

	const synonyms = new Set<string>(tokens)
	for (const token of tokens) {
		const expansions = ABBREVIATION_MAP[token]
		if (expansions) {
			for (const exp of expansions) {
				synonyms.add(exp)
			}
		}
	}
	synonyms.add(columnName.toLowerCase())

	return {
		description,
		synonyms: Array.from(synonyms),
		typeHint,
		isPK,
		isFK,
		fkTarget,
		dataType,
	}
}

// ============================================================================
// M-Schema Parsing (for gloss generation)
// ============================================================================

interface ParsedColumn {
	name: string
	type: string
	isPK: boolean
	isFK: boolean
	fkTarget: string | null
}

function parseMSchemaColumns(mSchema: string): ParsedColumn[] {
	const columns: ParsedColumn[] = []

	const match = mSchema.match(/\(([^)]+)\)/s)
	if (!match) return columns

	const content = match[1]
	const parts = content.split(/,\s*/)

	for (const part of parts) {
		const trimmed = part.trim()
		if (!trimmed) continue

		const nameMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/)
		if (!nameMatch) continue

		const name = nameMatch[1]

		const restAfterName = trimmed.substring(name.length).trim()
		const typeMatch = restAfterName.match(/^([a-zA-Z][a-zA-Z0-9_()]*(?:\(\d+(?:,\s*\d+)?\))?)/)
		const type = typeMatch ? typeMatch[1] : "text"

		const isPK = /\bPK\b/i.test(trimmed)
		const isFK = /\bFK\b/i.test(trimmed)
		const fkMatch = trimmed.match(/FK→(\w+)/i)
		const fkTarget = fkMatch ? fkMatch[1] : null

		columns.push({ name, type, isPK, isFK, fkTarget })
	}

	return columns
}

// ============================================================================
// Gloss Main Entry Point
// ============================================================================

export function generateGlosses(schemaContext: SchemaContextPacket): SchemaGlosses {
	const glosses: SchemaGlosses = new Map()

	for (const table of schemaContext.tables) {
		const columns = parseMSchemaColumns(table.m_schema)

		for (const col of columns) {
			const key = `${table.table_name}.${col.name}`
			const gloss = glossColumn(col.name, col.type, col.isPK, col.isFK, col.fkTarget)
			glosses.set(key, gloss)
		}
	}

	return glosses
}

// ============================================================================
// Linker: Stopwords & Metric Words
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

const METRIC_WORDS = new Set([
	"total", "count", "average", "avg", "sum", "maximum", "minimum",
	"max", "min", "highest", "lowest", "most", "least", "top", "bottom",
	"per", "each", "every", "overall", "combined",
])

// ============================================================================
// Linker: Keyphrase Extraction
// ============================================================================

interface Keyphrase {
	text: string
	tokens: string[]
	isQuotedValue: boolean
	isNumber: boolean
	isMetric: boolean
}

export function extractKeyphrases(question: string): Keyphrase[] {
	const keyphrases: Keyphrase[] = []

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

	const withoutQuotes = question.replace(/["'][^"']+["']/g, " ")

	const tokens = withoutQuotes
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter(t => t.length > 0)

	for (const token of tokens) {
		if (STOPWORDS.has(token)) continue

		const isNumber = /^\d+(\.\d+)?$/.test(token)
		const isMetric = METRIC_WORDS.has(token)

		keyphrases.push({
			text: token,
			tokens: [token],
			isQuotedValue: false,
			isNumber,
			isMetric,
		})
	}

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
// Linker: Matching
// ============================================================================

function computeMatchScore(keyphrase: Keyphrase, gloss: ColumnGloss, columnName: string): number {
	if (keyphrase.isQuotedValue || keyphrase.isNumber) return 0

	const kTokens = keyphrase.tokens
	let bestScore = 0

	for (const kToken of kTokens) {
		for (const synonym of gloss.synonyms) {
			if (kToken === synonym) {
				bestScore = Math.max(bestScore, 1.0)
			}
			else if (synonym.startsWith(kToken) && kToken.length >= 3) {
				bestScore = Math.max(bestScore, 0.8)
			}
			else if (synonym.includes(kToken) && kToken.length >= 4) {
				bestScore = Math.max(bestScore, 0.7)
			}
		}
	}

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

	for (const kToken of kTokens) {
		if (gloss.typeHint.toLowerCase().includes(kToken) && kToken.length >= 3) {
			bestScore = Math.max(bestScore, 0.5)
		}
	}

	return bestScore
}

// ============================================================================
// Linker: Main Entry Point
// ============================================================================

const MIN_LINK_SCORE = 0.5
const MIN_TABLE_RELEVANCE = 0.1

export function linkSchema(
	question: string,
	schemaContext: SchemaContextPacket,
	glosses?: SchemaGlosses,
): SchemaLinkBundle {
	const g = glosses || generateGlosses(schemaContext)

	const keyphrases = extractKeyphrases(question)

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

	const tableScores: Array<{ table: string; relevance: number; reason: string }> = []
	for (const table of schemaContext.tables) {
		const matches = columnMatches.get(table.table_name)
		const matchCount = matches?.length || 0
		const maxScore = matches ? Math.max(...matches.map(m => m.score)) : 0

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

	const linkedColumns: Record<string, Array<{ column: string; relevance: number; concept: string }>> = {}
	for (const [tableName, matches] of columnMatches) {
		linkedColumns[tableName] = matches.map(m => ({
			column: m.column,
			relevance: m.score,
			concept: m.concept,
		}))
	}

	const joinHints = schemaContext.fk_edges.map(edge => ({
		from: `${edge.from_table}.${edge.from_column}`,
		to: `${edge.to_table}.${edge.to_column}`,
		via: edge.from_column,
	}))

	const valueHints: Array<{ value: string; likelyColumn: string; likelyTable: string }> = []
	for (const kp of keyphrases) {
		if (!kp.isQuotedValue) continue

		for (const table of schemaContext.tables) {
			for (const [key, gloss] of g) {
				if (!key.startsWith(`${table.table_name}.`)) continue
				const columnName = key.split(".")[1]

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

	const unsupportedConcepts: string[] = []
	for (const kp of keyphrases) {
		if (kp.isQuotedValue || kp.isNumber || kp.isMetric) continue
		if (kp.tokens.length > 1) continue
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
// Confusable Tables (commonly mis-joined by LLM)
// ============================================================================

const CONFUSABLE_TABLES: Record<string, {
	confusesWith: string
	triggerKeywords: string[]
	hint: string
}> = {
	sales_regions: {
		confusesWith: "states_provinces",
		triggerKeywords: ["region", "regions", "by region", "sales region"],
		hint: "For geographic 'by region' grouping, use states_provinces via address chain (customers → addresses → cities → states_provinces). sales_regions has NO FK to sales_orders.",
	},
}

// ============================================================================
// Column Redirect Detection (parent-child warnings)
// ============================================================================

export interface ColumnRedirect {
	childTable: string
	parentTable: string
	column: string
	columnType: string
	joinKey: string
}

export function detectColumnRedirects(
	schemaContext: SchemaContextPacket,
): ColumnRedirect[] {
	const redirects: ColumnRedirect[] = []
	const tableColMap = new Map<string, Set<string>>()

	// Build column map from m_schema
	for (const table of schemaContext.tables) {
		const cols = new Set<string>()
		const match = table.m_schema.match(/\(([^)]+)\)/)
		if (match) {
			for (const part of match[1].split(/,\s*/)) {
				const colMatch = part.trim().match(/^([a-zA-Z_]\w*)/)
				if (colMatch) cols.add(colMatch[1].toLowerCase())
			}
		}
		tableColMap.set(table.table_name.toLowerCase(), cols)
	}

	const IMPORTANT_PATTERNS = [
		{ pattern: /date|_at$/i, category: "date" },
		{ pattern: /employee_id|emp_id|worker_id/i, category: "employee" },
		{ pattern: /^status$|status_code/i, category: "status" },
	]

	for (const edge of schemaContext.fk_edges) {
		const childName = edge.from_table.toLowerCase()
		const parentName = edge.to_table.toLowerCase()
		const childCols = tableColMap.get(childName)
		const parentCols = tableColMap.get(parentName)
		if (!childCols || !parentCols) continue

		for (const pCol of parentCols) {
			if (childCols.has(pCol)) continue
			for (const { pattern, category } of IMPORTANT_PATTERNS) {
				if (pattern.test(pCol)) {
					redirects.push({
						childTable: edge.from_table,
						parentTable: edge.to_table,
						column: pCol,
						columnType: category,
						joinKey: `${edge.from_column} → ${edge.to_table}.${edge.to_column}`,
					})
				}
			}
		}
	}

	return redirects
}

// ============================================================================
// Linker: Prompt Formatting
// ============================================================================

export function formatSchemaLinkForPrompt(
	bundle: SchemaLinkBundle,
	glosses: SchemaGlosses,
	schemaContext?: SchemaContextPacket,
): string {
	const lines: string[] = []

	lines.push("## Schema Contract (MANDATORY)")
	lines.push("You MUST only use columns from this list. Do not invent columns.")
	lines.push("")

	lines.push("### Required Tables")
	for (let i = 0; i < bundle.linkedTables.length; i++) {
		const t = bundle.linkedTables[i]
		lines.push(`${i + 1}. ${t.table} (relevance: ${t.relevance.toFixed(2)}) — ${t.reason}`)
	}
	lines.push("")

	lines.push("### Allowed Columns")
	for (const t of bundle.linkedTables) {
		const cols = bundle.linkedColumns[t.table]
		if (!cols || cols.length === 0) {
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
			const colParts: string[] = []
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

	// Column redirect warnings (parent-child mismatches)
	if (schemaContext) {
		const redirects = detectColumnRedirects(schemaContext)
		if (redirects.length > 0) {
			lines.push("### Column Warnings (READ CAREFULLY)")
			const byChild = new Map<string, ColumnRedirect[]>()
			for (const r of redirects) {
				const list = byChild.get(r.childTable) || []
				list.push(r)
				byChild.set(r.childTable, list)
			}
			for (const [child, reds] of byChild) {
				const colList = reds.map(r => r.column).join(", ")
				const parent = reds[0].parentTable
				const joinKey = reds[0].joinKey
				lines.push(`- **${child}** has NO ${colList}. JOIN to ${parent} via ${joinKey}`)
			}
			lines.push("")
		}
	}

	// Table confusion warnings (e.g., sales_regions vs states_provinces)
	if (schemaContext) {
		const tableNames = new Set(bundle.linkedTables.map(t => t.table.toLowerCase()))
		const question = schemaContext.question.toLowerCase()
		const tableWarnings: string[] = []
		for (const [tableName, config] of Object.entries(CONFUSABLE_TABLES)) {
			if (!tableNames.has(tableName)) continue
			if (!config.triggerKeywords.some(kw => question.includes(kw))) continue
			tableWarnings.push(`- **${tableName}**: ${config.hint}`)
		}
		if (tableWarnings.length > 0) {
			lines.push("### Table Warnings (READ CAREFULLY)")
			lines.push(...tableWarnings)
			lines.push("")
		}
	}

	if (bundle.joinHints.length > 0) {
		lines.push("### Join Plan")
		for (const hint of bundle.joinHints) {
			lines.push(`${hint.from} → ${hint.to}`)
		}
		lines.push("")
	}

	if (bundle.valueHints.length > 0) {
		lines.push("### Value Hints")
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
