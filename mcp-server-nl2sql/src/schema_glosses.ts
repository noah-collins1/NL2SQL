/**
 * Schema Column Glosses (TA-SQL Style)
 *
 * Generate rich descriptions for each column using deterministic heuristics.
 * No LLM call required. Provides synonyms and type hints for schema linking.
 */

import type { SchemaContextPacket } from "./schema_types.js"

// ============================================================================
// Feature Flag
// ============================================================================

export const SCHEMA_GLOSSES_ENABLED = process.env.SCHEMA_GLOSSES_ENABLED !== "false"

// ============================================================================
// Types
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
// Abbreviation Mappings
// ============================================================================

const ABBREVIATION_MAP: Record<string, string[]> = {
	qty: ["quantity"],
	quantity: ["qty"],
	amt: ["amount"],
	amount: ["amt"],
	num: ["number"],
	number: ["num"],
	desc: ["description"],
	description: ["desc"],
	addr: ["address"],
	address: ["addr"],
	dept: ["department"],
	department: ["dept"],
	emp: ["employee"],
	employee: ["emp"],
	mgr: ["manager"],
	manager: ["mgr"],
	org: ["organization"],
	organization: ["org"],
	pct: ["percent", "percentage"],
	percent: ["pct"],
	percentage: ["pct"],
	yr: ["year"],
	year: ["yr"],
	mo: ["month"],
	month: ["mo"],
	dt: ["date"],
	date: ["dt"],
	id: ["identifier", "key"],
	no: ["number"],
	cat: ["category"],
	category: ["cat"],
	grp: ["group"],
	group: ["grp"],
	cust: ["customer"],
	customer: ["cust"],
	prod: ["product"],
	product: ["prod"],
	inv: ["invoice", "inventory"],
	po: ["purchase order"],
	so: ["sales order"],
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

/** Exact-name matches for standalone words (no underscore prefix needed) */
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
// Core Functions
// ============================================================================

/**
 * Split a snake_case name into word tokens.
 *
 * @param name - Column name like "purchase_order_date"
 * @returns Array of words like ["purchase", "order", "date"]
 */
export function splitSnakeCase(name: string): string[] {
	return name
		.toLowerCase()
		.split("_")
		.filter(token => token.length > 0)
}

/**
 * Infer a type hint from column name and data type.
 *
 * @param name - Column name
 * @param dataType - SQL data type (e.g., "integer", "text", "date")
 * @returns Type hint string
 */
export function inferTypeHint(name: string, dataType: string): string {
	const lowerName = name.toLowerCase()

	// Check exact name matches first (e.g., "salary", "budget")
	if (EXACT_NAME_HINTS[lowerName]) {
		return EXACT_NAME_HINTS[lowerName]
	}

	// Check suffix patterns
	for (const { suffixes, hint } of SUFFIX_TYPE_HINTS) {
		for (const suffix of suffixes) {
			if (suffix.startsWith("_")) {
				// Suffix match (e.g., "_id")
				if (lowerName.endsWith(suffix)) return hint
			} else {
				// Exact match for short suffixes (e.g., "id" when name is exactly "id")
				if (lowerName === suffix) return hint
			}
		}
	}

	// Fall back to data type
	const lowerType = dataType.toLowerCase()
	if (lowerType.includes("int") || lowerType.includes("serial")) return "numeric"
	if (lowerType.includes("numeric") || lowerType.includes("decimal") || lowerType.includes("float") || lowerType.includes("double") || lowerType.includes("real")) return "numeric"
	if (lowerType.includes("date") || lowerType.includes("time") || lowerType.includes("timestamp")) return "date/timestamp"
	if (lowerType.includes("bool")) return "boolean flag"
	if (lowerType.includes("text") || lowerType.includes("varchar") || lowerType.includes("char")) return "text"

	return "general"
}

/**
 * Generate a gloss for a single column.
 *
 * @param columnName - Column name (e.g., "purchase_order_date")
 * @param dataType - SQL data type
 * @param isPK - Whether this is a primary key
 * @param isFK - Whether this is a foreign key
 * @param fkTarget - FK target table (e.g., "departments") or null
 * @returns ColumnGloss with description, synonyms, and type hint
 */
export function glossColumn(
	columnName: string,
	dataType: string,
	isPK: boolean,
	isFK: boolean,
	fkTarget: string | null,
): ColumnGloss {
	const tokens = splitSnakeCase(columnName)
	const typeHint = inferTypeHint(columnName, dataType)

	// Build description
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

	// Build synonyms: tokens + abbreviation expansions
	const synonyms = new Set<string>(tokens)
	for (const token of tokens) {
		const expansions = ABBREVIATION_MAP[token]
		if (expansions) {
			for (const exp of expansions) {
				synonyms.add(exp)
			}
		}
	}

	// Add the full column name as a synonym (without underscores)
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

/**
 * Parse columns from M-Schema format for gloss generation.
 *
 * Format: table_name (col1 TYPE [PK], col2 TYPE [FK→target], ...)
 * Also handles multi-line format with tags like [AMT], [DATE], etc.
 */
function parseMSchemaColumns(mSchema: string): ParsedColumn[] {
	const columns: ParsedColumn[] = []

	// Extract content between parentheses
	const match = mSchema.match(/\(([^)]+)\)/s)
	if (!match) return columns

	const content = match[1]
	const parts = content.split(/,\s*/)

	for (const part of parts) {
		const trimmed = part.trim()
		if (!trimmed) continue

		// Parse column name (first word)
		const nameMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/)
		if (!nameMatch) continue

		const name = nameMatch[1]

		// Parse data type (second word if present)
		const restAfterName = trimmed.substring(name.length).trim()
		const typeMatch = restAfterName.match(/^([a-zA-Z][a-zA-Z0-9_()]*(?:\(\d+(?:,\s*\d+)?\))?)/)
		const type = typeMatch ? typeMatch[1] : "text"

		// Check for PK/FK annotations
		const isPK = /\bPK\b/i.test(trimmed)
		const isFK = /\bFK\b/i.test(trimmed)
		const fkMatch = trimmed.match(/FK→(\w+)/i)
		const fkTarget = fkMatch ? fkMatch[1] : null

		columns.push({ name, type, isPK, isFK, fkTarget })
	}

	return columns
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Generate glosses for all columns in a SchemaContextPacket.
 *
 * @param schemaContext - Schema context from retrieval
 * @returns Map of "table.column" → ColumnGloss
 */
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
