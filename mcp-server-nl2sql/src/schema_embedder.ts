/**
 * Schema Embedder
 *
 * Generates embedding-friendly text representations for tables and columns.
 * Produces two formats:
 * 1. embed_text: Rich semantic text for vector embedding
 * 2. m_schema_compact: Dense, low-token format for LLM prompts
 *
 * Also handles embedding population via Python sidecar.
 */

import { Pool, PoolClient } from "pg"
import { getPythonClient, PythonClient } from "./python_client.js"
import {
	SchemaIntrospector,
	IntrospectedTable,
	IntrospectedColumn,
	IntrospectionResult,
	getSchemaIntrospector,
} from "./schema_introspector.js"
import crypto from "crypto"

// ============================================================================
// Types
// ============================================================================

export interface TableEmbedding {
	entity_type: "table"
	table_schema: string
	table_name: string
	column_name: null
	module: string | null
	gloss: string
	synonyms: string[]
	embed_text: string
	m_schema_compact: string
	fingerprint: string
}

export interface ColumnEmbedding {
	entity_type: "column"
	table_schema: string
	table_name: string
	column_name: string
	module: string | null
	gloss: string
	synonyms: string[]
	embed_text: string
	m_schema_compact: null
	data_type: string
	is_pk: boolean
	is_fk: boolean
	fk_target: string | null
	is_nullable: boolean
	is_generic: boolean
	fingerprint: string
}

export type EmbeddingRecord = TableEmbedding | ColumnEmbedding

export interface EmbedderConfig {
	/** Module mapping function (table_name -> module) */
	moduleMapper?: (tableName: string) => string | null

	/** Gloss inference rules */
	glossRules?: GlossRules

	/** Generic column patterns to flag */
	genericPatterns?: string[]
}

export interface GlossRules {
	/** Abbreviation expansions */
	abbreviations: Record<string, string>

	/** Column suffix meanings */
	suffixMeanings: Record<string, string>

	/** Table name patterns */
	tablePatterns: Record<string, string>
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_ABBREVIATIONS: Record<string, string> = {
	emp: "employee",
	dept: "department",
	mgr: "manager",
	amt: "amount",
	qty: "quantity",
	num: "number",
	desc: "description",
	fy: "fiscal year",
	fp: "fiscal period",
	cc: "cost center",
	bu: "business unit",
	gl: "general ledger",
	ap: "accounts payable",
	ar: "accounts receivable",
	po: "purchase order",
	so: "sales order",
	pr: "purchase requisition",
	wip: "work in progress",
	bom: "bill of materials",
	uom: "unit of measure",
	sku: "stock keeping unit",
	coa: "chart of accounts",
	pto: "paid time off",
	ytd: "year to date",
	mtd: "month to date",
	acct: "account",
	addr: "address",
	org: "organization",
	pos: "position",
	loc: "location",
	inv: "inventory",
	txn: "transaction",
	xfer: "transfer",
	rcpt: "receipt",
	adj: "adjustment",
	alloc: "allocation",
	pct: "percent",
	curr: "currency",
	src: "source",
	tgt: "target",
	cat: "category",
	grp: "group",
	lvl: "level",
	typ: "type",
	stat: "status",
	flg: "flag",
	ind: "indicator",
	cd: "code",
	nm: "name",
	val: "value",
	bal: "balance",
	pymt: "payment",
	recv: "receivable",
	paybl: "payable",
	sched: "schedule",
	maint: "maintenance",
	depr: "depreciation",
	accum: "accumulated",
	cert: "certification",
	perf: "performance",
	eval: "evaluation",
	rev: "revenue",
	exp: "expense",
	cogs: "cost of goods sold",
	opex: "operating expense",
	capex: "capital expenditure",
	min: "minimum",
	max: "maximum",
	avg: "average",
	tot: "total",
	sub: "subtotal",
	fk: "foreign key",
	pk: "primary key",
}

const DEFAULT_SUFFIX_MEANINGS: Record<string, string> = {
	_id: "identifier",
	_at: "timestamp",
	_date: "date",
	_by: "performed by user/employee",
	_count: "count/quantity",
	_amount: "monetary amount",
	_total: "total value",
	_rate: "rate or percentage",
	_code: "code identifier",
	_name: "name",
	_desc: "description",
	_status: "status",
	_type: "type classification",
}

// ============================================================================
// Type Tags for M-Schema (V2)
// ============================================================================

/**
 * Infer a semantic type tag from column name and data type
 * Returns tags like [NUM], [TEXT], [DATE], [BOOL], [TS], [AMT], [QTY], [CODE], [STATUS], [ID]
 */
function inferTypeTag(columnName: string, dataType: string, isPK: boolean, isFK: boolean): string {
	const nameLower = columnName.toLowerCase()
	const typeLower = dataType.toLowerCase()

	// PK/FK take precedence
	if (isPK) return "PK"
	if (isFK) return "" // FK tag is added separately with target

	// Semantic tags based on column name patterns
	if (nameLower.endsWith("_amount") || nameLower.endsWith("_cost") || nameLower.endsWith("_price") ||
		nameLower.endsWith("_salary") || nameLower.endsWith("_total") || nameLower.endsWith("_budget") ||
		nameLower.endsWith("_value") || nameLower.endsWith("_balance") || nameLower === "amount" ||
		nameLower === "cost" || nameLower === "price" || nameLower === "salary" || nameLower === "total") {
		return "AMT" // Monetary amount
	}

	if (nameLower.endsWith("_qty") || nameLower.endsWith("_quantity") || nameLower.endsWith("_count") ||
		nameLower.endsWith("_units") || nameLower.endsWith("_hours") || nameLower === "quantity") {
		return "QTY" // Quantity
	}

	if (nameLower.endsWith("_rate") || nameLower.endsWith("_percent") || nameLower.endsWith("_pct") ||
		nameLower.endsWith("_percentage")) {
		return "PCT" // Percentage/Rate
	}

	if (nameLower.endsWith("_code") || nameLower === "code" || nameLower.endsWith("_number") ||
		nameLower === "sku" || nameLower === "part_number") {
		return "CODE" // Code/identifier string
	}

	if (nameLower === "status" || nameLower.endsWith("_status")) {
		return "STATUS" // Status enum
	}

	if (nameLower === "type" || nameLower.endsWith("_type") || nameLower === "category" ||
		nameLower.endsWith("_category")) {
		return "TYPE" // Type/category enum
	}

	if (nameLower === "name" || nameLower.endsWith("_name")) {
		return "NAME" // Name field
	}

	if (nameLower === "description" || nameLower.endsWith("_description") ||
		nameLower === "notes" || nameLower === "comments") {
		return "DESC" // Description/notes
	}

	// Data type based tags
	if (typeLower.includes("timestamp")) {
		return "TS" // Timestamp
	}

	if (typeLower === "date") {
		return "DATE"
	}

	if (typeLower === "time") {
		return "TIME"
	}

	if (typeLower === "boolean") {
		return "BOOL"
	}

	if (typeLower === "integer" || typeLower === "bigint" || typeLower === "smallint") {
		// Check if it's likely an ID
		if (nameLower.endsWith("_id") || nameLower === "id") {
			return "ID"
		}
		return "INT"
	}

	if (typeLower === "numeric" || typeLower === "decimal" || typeLower === "real" ||
		typeLower === "double precision" || typeLower === "money") {
		return "NUM"
	}

	if (typeLower.includes("char") || typeLower === "text") {
		return "TEXT"
	}

	if (typeLower === "json" || typeLower === "jsonb") {
		return "JSON"
	}

	if (typeLower === "uuid") {
		return "UUID"
	}

	return "" // No specific tag
}

/**
 * Generate micro-gloss for ambiguous/generic columns
 * Only for columns that need disambiguation
 */
function generateMicroGloss(
	columnName: string,
	tableName: string,
	dataType: string,
	isPK: boolean,
	isFK: boolean,
	fkTarget: string | null,
): string | null {
	const nameLower = columnName.toLowerCase()

	// Skip if PK or FK (they have their own context)
	if (isPK || isFK) return null

	// Ambiguous generic columns that need context
	const ambiguousPatterns: Record<string, (tbl: string) => string> = {
		"status": (tbl) => `${tbl} lifecycle state`,
		"type": (tbl) => `${tbl} classification`,
		"category": (tbl) => `${tbl} grouping`,
		"name": (tbl) => `${tbl} display name`,
		"description": (tbl) => `${tbl} details`,
		"amount": (tbl) => `${tbl} monetary value`,
		"total": (tbl) => `${tbl} sum/aggregate`,
		"code": (tbl) => `${tbl} identifier code`,
		"date": (tbl) => `${tbl} date`,
		"start_date": () => "period start",
		"end_date": () => "period end",
		"created_at": () => "record creation time",
		"updated_at": () => "last modification time",
		"notes": (tbl) => `${tbl} free-text notes`,
	}

	// Check for exact matches
	if (ambiguousPatterns[nameLower]) {
		const humanTable = tableName.replace(/_/g, " ")
		return ambiguousPatterns[nameLower](humanTable)
	}

	// Check for suffix patterns with business meaning
	const businessPatterns: Array<[RegExp, (match: string, tbl: string) => string]> = [
		[/^(.+)_amount$/, (m, tbl) => `${m.replace(/_/g, " ")} monetary value`],
		[/^(.+)_total$/, (m, tbl) => `${m.replace(/_/g, " ")} sum`],
		[/^(.+)_cost$/, (m, tbl) => `${m.replace(/_/g, " ")} cost`],
		[/^(.+)_price$/, (m, tbl) => `${m.replace(/_/g, " ")} price`],
		[/^(.+)_hours$/, (m, tbl) => `${m.replace(/_/g, " ")} hour count`],
		[/^(.+)_count$/, (m, tbl) => `${m.replace(/_/g, " ")} quantity`],
		[/^(.+)_rate$/, (m, tbl) => `${m.replace(/_/g, " ")} percentage`],
		[/^(.+)_date$/, (m, tbl) => `${m.replace(/_/g, " ")} date`],
		[/^(.+)_by$/, (m, tbl) => `user who ${m.replace(/_/g, " ")}`],
	]

	for (const [pattern, generator] of businessPatterns) {
		const match = nameLower.match(pattern)
		if (match) {
			return generator(match[1], tableName)
		}
	}

	return null
}

/**
 * Generate table-level gloss from table name and module
 */
function generateTableGloss(tableName: string, module: string | null): string {
	// Expand abbreviations in table name
	const expanded = expandName(tableName, DEFAULT_ABBREVIATIONS)

	// Add module context if available
	if (module && module !== "default") {
		const moduleExpanded = expandName(module, DEFAULT_ABBREVIATIONS)
		return `${moduleExpanded} - ${expanded}`
	}

	return expanded
}

const DEFAULT_GENERIC_PATTERNS = [
	"_id",
	"id",
	"created_at",
	"updated_at",
	"deleted_at",
	"modified_at",
	"created_by",
	"updated_by",
	"modified_by",
	"status",
	"is_active",
	"is_deleted",
	"name",
	"description",
	"notes",
	"comments",
]

// ============================================================================
// Gloss Inference
// ============================================================================

/**
 * Infer a human-readable gloss from a name
 */
function inferGloss(
	name: string,
	context: {
		isTable?: boolean
		isColumn?: boolean
		tableName?: string
		isPK?: boolean
		isFK?: boolean
		fkTarget?: string | null
		dataType?: string
	},
	abbreviations: Record<string, string> = DEFAULT_ABBREVIATIONS,
	suffixMeanings: Record<string, string> = DEFAULT_SUFFIX_MEANINGS,
): string {
	// Handle PK
	if (context.isPK) {
		return `Primary key - unique identifier for ${context.tableName || "record"}`
	}

	// Handle FK
	if (context.isFK && context.fkTarget) {
		const targetTable = context.fkTarget.split(".").pop() || context.fkTarget
		const humanTarget = expandName(targetTable, abbreviations)

		// Check for semantic hints in column name
		if (name.includes("manager") || name.includes("mgr")) {
			return `Manager reference (FK to ${targetTable})`
		}
		if (name.includes("approved_by") || name.includes("approver")) {
			return `Approver reference (FK to ${targetTable})`
		}
		if (name.includes("created_by") || name.includes("creator")) {
			return `Creator reference (FK to ${targetTable})`
		}
		if (name.endsWith("_by")) {
			return `Performed by (FK to ${targetTable})`
		}
		if (name.includes("parent")) {
			return `Parent reference for hierarchy (FK to ${targetTable})`
		}

		return `Reference to ${humanTarget} (FK to ${targetTable})`
	}

	// Expand abbreviations in name
	const expanded = expandName(name, abbreviations)

	// Add type-based hints
	if (context.dataType) {
		const dt = context.dataType.toLowerCase()
		if (dt.includes("timestamp") || dt.includes("date")) {
			if (name.endsWith("_at")) {
				return `${expanded} timestamp`
			}
			if (!name.includes("date")) {
				return `${expanded} (date/time)`
			}
		}
		if (dt === "boolean") {
			if (!expanded.includes("flag") && !expanded.includes("indicator")) {
				return `${expanded} flag (true/false)`
			}
		}
		if (dt === "numeric" || dt === "decimal" || dt === "money") {
			if (
				name.includes("amount") ||
				name.includes("cost") ||
				name.includes("price") ||
				name.includes("total") ||
				name.includes("salary") ||
				name.includes("budget")
			) {
				return `${expanded} (monetary value)`
			}
			if (name.includes("rate") || name.includes("percent") || name.includes("pct")) {
				return `${expanded} (rate/percentage)`
			}
		}
	}

	// Special column patterns
	if (name === "status") {
		return "Status (e.g., pending, active, completed, cancelled)"
	}
	if (name === "created_at") {
		return "Record creation timestamp"
	}
	if (name === "updated_at") {
		return "Last modification timestamp"
	}
	if (name === "is_active") {
		return "Active/inactive flag"
	}
	if (name === "email") {
		return "Email address"
	}
	if (name === "phone") {
		return "Phone number"
	}

	// Table-specific name/description
	if (context.isColumn && context.tableName) {
		if (name === "name") {
			const tableHuman = expandName(context.tableName, abbreviations)
			return `${tableHuman} name`
		}
		if (name === "description") {
			const tableHuman = expandName(context.tableName, abbreviations)
			return `${tableHuman} description`
		}
	}

	return expanded
}

/**
 * Expand abbreviations in a name
 */
function expandName(name: string, abbreviations: Record<string, string>): string {
	const words = name.split("_")
	const expanded = words.map((word) => {
		const lower = word.toLowerCase()
		if (abbreviations[lower]) {
			return capitalize(abbreviations[lower])
		}
		return capitalize(word)
	})
	return expanded.join(" ")
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

/**
 * Generate synonyms for a table/column name
 */
function generateSynonyms(
	name: string,
	gloss: string,
	abbreviations: Record<string, string>,
): string[] {
	const synonyms: string[] = []

	// Add expanded form
	const expanded = expandName(name, abbreviations).toLowerCase()
	if (expanded !== name.toLowerCase()) {
		synonyms.push(expanded)
	}

	// Extract meaningful words from gloss
	const glossWords = gloss
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 3 && !["the", "for", "and", "from", "with"].includes(w))

	// Add unique gloss words not already present
	for (const word of glossWords) {
		if (!synonyms.includes(word) && !name.toLowerCase().includes(word)) {
			synonyms.push(word)
		}
	}

	return synonyms.slice(0, 5) // Cap at 5 synonyms
}

// ============================================================================
// Embed Text Generation
// ============================================================================

/**
 * Generate STABLE embed_text for a TABLE (for vector embedding)
 *
 * This format is optimized for semantic similarity search and should NOT change
 * when prompt formatting changes. Key principles:
 * - Semantic, not overly structured
 * - Include table name, module, 1-2 lines describing purpose
 * - Short list of representative columns (not all)
 * - Key business synonyms, avoid heavy tagging/brackets
 *
 * Format:
 * <table_name>: <gloss>
 * Module: <module>
 * Key columns: <representative columns with brief descriptions>
 * Related to: <FK target tables>
 */
function generateStableTableEmbedText(
	table: IntrospectedTable,
	module: string | null,
	gloss: string,
	synonyms: string[],
): string {
	const lines: string[] = []

	// Simple header with table name and gloss
	lines.push(`${table.table_name}: ${gloss}`)

	// Module context (if not default)
	if (module && module !== "default") {
		lines.push(`Module: ${module}`)
	}

	// Add synonyms inline if present
	if (synonyms.length > 0) {
		lines.push(`Also known as: ${synonyms.slice(0, 3).join(", ")}`)
	}

	// Key columns - select representative columns (not all)
	// Priority: PK, important business columns, FKs
	const representativeCols: string[] = []

	// Add PK first
	const pkCol = table.columns.find((c) => c.is_pk)
	if (pkCol) {
		representativeCols.push(`${pkCol.column_name} (primary key)`)
	}

	// Add important business columns (up to 5)
	const businessCols = table.columns.filter((c) => {
		if (c.is_pk) return false
		const name = c.column_name.toLowerCase()
		// Prioritize columns with business meaning
		return (
			name === "name" ||
			name.includes("amount") ||
			name.includes("total") ||
			name.includes("status") ||
			name.includes("type") ||
			name.includes("date") ||
			name.includes("price") ||
			name.includes("quantity") ||
			name.includes("salary") ||
			name.includes("budget")
		)
	})

	for (const col of businessCols.slice(0, 4)) {
		const microGloss = generateMicroGloss(
			col.column_name,
			table.table_name,
			col.data_type,
			col.is_pk,
			col.is_fk,
			null,
		)
		if (microGloss) {
			representativeCols.push(`${col.column_name} (${microGloss})`)
		} else {
			representativeCols.push(col.column_name)
		}
	}

	// Add FK relationships
	const fkCols = table.columns.filter((c) => c.is_fk && c.fk_target_table)
	for (const col of fkCols.slice(0, 3)) {
		representativeCols.push(`${col.column_name} (references ${col.fk_target_table})`)
	}

	if (representativeCols.length > 0) {
		lines.push(`Key columns: ${representativeCols.slice(0, 6).join(", ")}`)
	}

	// Related tables (from FK targets)
	const relatedTables = [...new Set(fkCols.map((c) => c.fk_target_table!))]
	if (relatedTables.length > 0) {
		lines.push(`Related to: ${relatedTables.join(", ")}`)
	}

	return lines.join("\n")
}

/**
 * Generate rich embed_text for a TABLE (V2 Enhanced) - LEGACY
 *
 * NOTE: This function is kept for backward compatibility but generateStableTableEmbedText()
 * should be used for embeddings to maintain retrieval stability.
 *
 * Format:
 * TABLE: schema.table_name
 * MODULE: <module>
 * PURPOSE: <table gloss>
 * SYNONYMS: <synonyms>
 * COLUMNS:
 * - col1 [PK] primary key
 * - col2 [FK→target] reference to target
 * - col3 [AMT] monetary amount -- micro-gloss
 * - col4 [STATUS] status enum -- micro-gloss
 * JOIN_KEYS:
 * - fk_col -> schema.table.col (relationship description)
 */
function generateTableEmbedText(
	table: IntrospectedTable,
	module: string | null,
	gloss: string,
	synonyms: string[],
): string {
	const lines: string[] = []

	// Header
	lines.push(`TABLE: ${table.table_schema}.${table.table_name}`)
	lines.push(`MODULE: ${module || "default"}`)
	lines.push(`PURPOSE: ${gloss}`)

	if (synonyms.length > 0) {
		lines.push(`SYNONYMS: ${synonyms.join(", ")}`)
	}

	// Columns with semantic tags - one per line for embedding quality
	lines.push("COLUMNS:")
	for (const col of table.columns) {
		let line = `- ${col.column_name}`

		// Build tags
		const tags: string[] = []
		if (col.is_pk) {
			tags.push("PK")
		} else if (col.is_fk && col.fk_target_table) {
			tags.push(`FK→${col.fk_target_schema}.${col.fk_target_table}.${col.fk_target_column}`)
		} else {
			const typeTag = inferTypeTag(col.column_name, col.data_type, col.is_pk, col.is_fk)
			if (typeTag) {
				tags.push(typeTag)
			}
		}

		if (tags.length > 0) {
			line += ` [${tags.join(", ")}]`
		}

		// Add column gloss or micro-gloss
		const fkTarget = col.is_fk && col.fk_target_table
			? `${col.fk_target_schema}.${col.fk_target_table}.${col.fk_target_column}`
			: null
		const microGloss = generateMicroGloss(
			col.column_name,
			table.table_name,
			col.data_type,
			col.is_pk,
			col.is_fk,
			fkTarget,
		)

		if (col.is_pk) {
			line += ` -- unique identifier for ${table.table_name}`
		} else if (col.is_fk && col.fk_target_table) {
			const colGloss = inferGloss(col.column_name, {
				isColumn: true,
				tableName: table.table_name,
				isFK: true,
				fkTarget: fkTarget,
			})
			line += ` -- ${colGloss}`
		} else if (microGloss) {
			line += ` -- ${microGloss}`
		}

		lines.push(line)
	}

	// Join keys section (FK relationships)
	const fkCols = table.columns.filter((c) => c.is_fk && c.fk_target_table)
	if (fkCols.length > 0) {
		lines.push("JOIN_KEYS:")
		for (const col of fkCols) {
			const colGloss = inferGloss(col.column_name, {
				isColumn: true,
				tableName: table.table_name,
				isFK: true,
				fkTarget: `${col.fk_target_schema}.${col.fk_target_table}.${col.fk_target_column}`,
			})
			lines.push(
				`- ${table.table_name}.${col.column_name} → ${col.fk_target_schema}.${col.fk_target_table}.${col.fk_target_column} (${colGloss})`,
			)
		}
	}

	return lines.join("\n")
}

/**
 * Generate m_schema_compact for a TABLE (for LLM prompts) - V2 Compact
 *
 * Format (single line, compact):
 * table_name (col1[PK], col2[FK→table], col3[AMT], col4[STATUS], ...)
 *
 * Type tags: PK, FK→table, AMT, QTY, DATE, TS, STATUS, TYPE, CODE
 * Only most useful tags are included to keep prompt compact.
 */
function generateTableMSchemaCompact(table: IntrospectedTable, tableModule: string | null): string {
	const colParts = table.columns.map((col) => {
		let part = col.column_name

		// Add compact type tags (only most useful ones)
		if (col.is_pk) {
			part += "[PK]"
		} else if (col.is_fk && col.fk_target_table) {
			// Compact FK notation: just the table name for brevity
			part += `[FK→${col.fk_target_table}]`
		} else {
			// Add semantic type tag only for key business columns
			const tag = inferCompactTypeTag(col.column_name, col.data_type)
			if (tag) {
				part += `[${tag}]`
			}
		}

		return part
	})

	return `${table.table_name} (${colParts.join(", ")})`
}

/**
 * Infer compact type tag - only for columns where type matters for correctness
 */
function inferCompactTypeTag(columnName: string, dataType: string): string {
	const nameLower = columnName.toLowerCase()
	const typeLower = dataType.toLowerCase()

	// Monetary amounts - important for correct aggregation
	if (nameLower.includes("amount") || nameLower.includes("cost") || nameLower.includes("price") ||
		nameLower.includes("salary") || nameLower.includes("total") || nameLower.includes("budget") ||
		nameLower.includes("value") || nameLower.includes("balance")) {
		return "AMT"
	}

	// Quantities - important for correct aggregation
	if (nameLower.includes("qty") || nameLower.includes("quantity") || nameLower.includes("count") ||
		nameLower.includes("units") || nameLower.includes("hours")) {
		return "QTY"
	}

	// Dates - important for filtering/ordering
	if (typeLower === "date" || (nameLower.includes("date") && !nameLower.endsWith("_id"))) {
		return "DATE"
	}

	// Timestamps
	if (typeLower.includes("timestamp") || nameLower.endsWith("_at")) {
		return "TS"
	}

	// Status/type enums - common source of errors
	if (nameLower === "status" || nameLower.endsWith("_status")) {
		return "STATUS"
	}
	if (nameLower === "type" || nameLower.endsWith("_type")) {
		return "TYPE"
	}

	return "" // No tag for most columns to keep prompt compact
}

/**
 * Generate compact single-line m_schema for backward compatibility
 */
function generateTableMSchemaCompactOneLine(table: IntrospectedTable): string {
	const colParts = table.columns.map((col) => {
		let part = `${col.column_name}`

		// Add type tag
		if (col.is_pk) {
			part += "[PK]"
		} else if (col.is_fk && col.fk_target_table) {
			part += `[FK→${col.fk_target_table}]`
		} else {
			const typeTag = inferTypeTag(col.column_name, col.data_type, col.is_pk, col.is_fk)
			if (typeTag) {
				part += `[${typeTag}]`
			}
		}

		return part
	})

	return `${table.table_name}(${colParts.join(", ")})`
}

/**
 * Generate STABLE embed_text for a COLUMN (for vector embedding)
 *
 * This format is optimized for semantic similarity search and should NOT change
 * when prompt formatting changes. Key principles:
 * - Simple, semantic format
 * - schema.table.column type + micro-gloss
 * - Avoid dumping whole table schema into each column
 *
 * Format:
 * <table_name>.<column_name>: <type> - <micro-gloss>
 * In <module> table <table_name> (<table_gloss>)
 * [References <target_table> if FK]
 */
function generateStableColumnEmbedText(
	table: IntrospectedTable,
	column: IntrospectedColumn,
	tableModule: string | null,
	tableGloss: string,
	columnGloss: string,
): string {
	const lines: string[] = []

	// Simple format: table.column: type - description
	const shortType = column.data_type.split("(")[0] // Remove length specifier
	lines.push(`${table.table_name}.${column.column_name}: ${shortType} - ${columnGloss}`)

	// Add table context (brief)
	const modulePrefix = tableModule && tableModule !== "default" ? `${tableModule} ` : ""
	lines.push(`In ${modulePrefix}table ${table.table_name}`)

	// Add FK target if applicable
	if (column.is_fk && column.fk_target_table) {
		lines.push(`References ${column.fk_target_table}`)
	}

	return lines.join("\n")
}

/**
 * Generate rich embed_text for a COLUMN (V2 Enhanced) - LEGACY
 *
 * NOTE: This function is kept for backward compatibility but generateStableColumnEmbedText()
 * should be used for embeddings to maintain retrieval stability.
 *
 * Format:
 * COLUMN: schema.table.column
 * TABLE: table_name (table gloss)
 * MODULE: module
 * TYPE: data_type [SEMANTIC_TAG]
 * MEANING: column gloss/description
 * JOIN_TARGET: schema.table.column (if FK)
 */
function generateColumnEmbedText(
	table: IntrospectedTable,
	column: IntrospectedColumn,
	tableModule: string | null,
	tableGloss: string,
	columnGloss: string,
): string {
	const lines: string[] = []

	// Header - fully qualified column path
	lines.push(`COLUMN: ${table.table_schema}.${table.table_name}.${column.column_name}`)
	lines.push(`TABLE: ${table.table_name} (${tableGloss})`)
	lines.push(`MODULE: ${tableModule || "default"}`)

	// Type with semantic tag
	const typeTag = inferTypeTag(column.column_name, column.data_type, column.is_pk, column.is_fk)
	if (column.is_pk) {
		lines.push(`TYPE: ${column.data_type} [PK]`)
	} else if (column.is_fk && column.fk_target_table) {
		lines.push(`TYPE: ${column.data_type} [FK→${column.fk_target_schema}.${column.fk_target_table}.${column.fk_target_column}]`)
	} else if (typeTag) {
		lines.push(`TYPE: ${column.data_type} [${typeTag}]`)
	} else {
		lines.push(`TYPE: ${column.data_type}`)
	}

	// Meaning/description
	lines.push(`MEANING: ${columnGloss}`)

	// FK join target (explicit for embedding)
	if (column.is_fk && column.fk_target_table) {
		lines.push(`JOIN_TARGET: ${column.fk_target_schema}.${column.fk_target_table}.${column.fk_target_column}`)
	}

	return lines.join("\n")
}

// ============================================================================
// Embedder Class
// ============================================================================

export class SchemaEmbedder {
	private pool: Pool
	private pythonClient: PythonClient
	private introspector: SchemaIntrospector
	private config: EmbedderConfig
	private logger: {
		info: Function
		error: Function
		warn: Function
		debug: Function
	}

	constructor(
		pool: Pool,
		logger: { info: Function; error: Function; warn: Function; debug: Function },
		config?: EmbedderConfig,
	) {
		this.pool = pool
		this.pythonClient = getPythonClient()
		this.introspector = getSchemaIntrospector(pool, logger)
		this.config = config || {}
		this.logger = logger
	}

	/**
	 * Generate embedding records from introspected schema
	 * (Does not write to DB or call embedding API - just generates the text)
	 *
	 * NOTE: Uses STABLE embed_text format for embeddings to ensure retrieval
	 * consistency. Prompt-optimized format (m_schema_compact) is stored separately.
	 */
	async generateEmbeddingRecords(
		databaseId: string,
		moduleMapping: Map<string, string>,
		schemas: string[] = ["public"],
		excludeTables: string[] = [],
	): Promise<EmbeddingRecord[]> {
		const introspection = await this.introspector.introspect(databaseId, schemas, excludeTables)

		const records: EmbeddingRecord[] = []

		for (const table of introspection.tables) {
			const module = moduleMapping.get(table.table_name) || null

			// Generate table gloss
			const tableGloss =
				table.comment ||
				inferGloss(table.table_name, { isTable: true }, DEFAULT_ABBREVIATIONS)

			// Generate table synonyms
			const tableSynonyms = generateSynonyms(table.table_name, tableGloss, DEFAULT_ABBREVIATIONS)

			// Generate STABLE table embed_text (for vector embedding - does not change with prompt format)
			const tableEmbedText = generateStableTableEmbedText(table, module, tableGloss, tableSynonyms)

			// Generate table m_schema_compact (V2 enhanced format - for LLM prompts)
			const tableMSchemaCompact = generateTableMSchemaCompact(table, module)

			// Table fingerprint
			const tableFingerprint = crypto
				.createHash("md5")
				.update(tableEmbedText)
				.digest("hex")

			// Add table record
			records.push({
				entity_type: "table",
				table_schema: table.table_schema,
				table_name: table.table_name,
				column_name: null,
				module,
				gloss: tableGloss,
				synonyms: tableSynonyms,
				embed_text: tableEmbedText,
				m_schema_compact: tableMSchemaCompact,
				fingerprint: tableFingerprint,
			})

			// Generate column records
			for (const column of table.columns) {
				const fkTarget = column.is_fk && column.fk_target_table
					? `${column.fk_target_schema}.${column.fk_target_table}.${column.fk_target_column}`
					: null

				// Generate column gloss
				const columnGloss =
					column.comment ||
					inferGloss(
						column.column_name,
						{
							isColumn: true,
							tableName: table.table_name,
							isPK: column.is_pk,
							isFK: column.is_fk,
							fkTarget,
							dataType: column.data_type,
						},
						DEFAULT_ABBREVIATIONS,
					)

				// Generate column synonyms
				const columnSynonyms = generateSynonyms(
					column.column_name,
					columnGloss,
					DEFAULT_ABBREVIATIONS,
				)

				// Generate STABLE column embed_text (for vector embedding - does not change with prompt format)
				const columnEmbedText = generateStableColumnEmbedText(
					table,
					column,
					module,
					tableGloss,
					columnGloss,
				)

				// Check if generic
				const isGeneric = this.isGenericColumn(column.column_name)

				// Column fingerprint
				const columnFingerprint = crypto
					.createHash("md5")
					.update(columnEmbedText)
					.digest("hex")

				records.push({
					entity_type: "column",
					table_schema: table.table_schema,
					table_name: table.table_name,
					column_name: column.column_name,
					module,
					gloss: columnGloss,
					synonyms: columnSynonyms,
					embed_text: columnEmbedText,
					m_schema_compact: null,
					data_type: column.data_type,
					is_pk: column.is_pk,
					is_fk: column.is_fk,
					fk_target: fkTarget,
					is_nullable: column.is_nullable,
					is_generic: isGeneric,
					fingerprint: columnFingerprint,
				})
			}
		}

		this.logger.info("Generated embedding records", {
			database_id: databaseId,
			total_records: records.length,
			table_records: records.filter((r) => r.entity_type === "table").length,
			column_records: records.filter((r) => r.entity_type === "column").length,
		})

		return records
	}

	/**
	 * Populate embeddings table with records
	 * Calls Python sidecar for embeddings, then writes to DB
	 */
	async populateEmbeddings(
		databaseId: string,
		records: EmbeddingRecord[],
		batchSize: number = 50,
	): Promise<{ inserted: number; updated: number; errors: number }> {
		const startTime = Date.now()
		let inserted = 0
		let updated = 0
		let errors = 0

		this.logger.info("Starting embedding population", {
			database_id: databaseId,
			total_records: records.length,
			batch_size: batchSize,
		})

		// Process in batches
		for (let i = 0; i < records.length; i += batchSize) {
			const batch = records.slice(i, i + batchSize)
			const batchNum = Math.floor(i / batchSize) + 1
			const totalBatches = Math.ceil(records.length / batchSize)

			this.logger.debug(`Processing batch ${batchNum}/${totalBatches}`, {
				batch_size: batch.length,
			})

			try {
				// Get embeddings from Python
				const embedTexts = batch.map((r) => r.embed_text)
				const embeddings = await this.pythonClient.embedBatch(embedTexts)

				// Write to DB
				const client = await this.pool.connect()
				try {
					await client.query("BEGIN")

					for (let j = 0; j < batch.length; j++) {
						const record = batch[j]
						const embedding = embeddings[j]

						const result = await this.upsertEmbedding(client, databaseId, record, embedding)
						if (result === "inserted") inserted++
						else if (result === "updated") updated++
					}

					await client.query("COMMIT")
				} catch (err) {
					await client.query("ROLLBACK")
					throw err
				} finally {
					client.release()
				}
			} catch (err) {
				this.logger.error(`Batch ${batchNum} failed`, { error: String(err) })
				errors += batch.length
			}
		}

		const latency = Date.now() - startTime
		this.logger.info("Embedding population complete", {
			database_id: databaseId,
			inserted,
			updated,
			errors,
			latency_ms: latency,
		})

		return { inserted, updated, errors }
	}

	/**
	 * Upsert a single embedding record
	 */
	private async upsertEmbedding(
		client: PoolClient,
		databaseId: string,
		record: EmbeddingRecord,
		embedding: number[],
	): Promise<"inserted" | "updated"> {
		const vectorLiteral = `[${embedding.join(",")}]`

		const query = `
			INSERT INTO rag.schema_embeddings (
				database_id, entity_type, table_schema, table_name, column_name,
				module, gloss, synonyms, embed_text, m_schema_compact,
				data_type, is_pk, is_fk, fk_target, is_nullable, is_generic,
				embedding, fingerprint, updated_at
			) VALUES (
				$1, $2, $3, $4, $5,
				$6, $7, $8, $9, $10,
				$11, $12, $13, $14, $15, $16,
				$17::vector, $18, now()
			)
			ON CONFLICT (database_id, entity_type, table_schema, table_name, column_name)
			DO UPDATE SET
				module = EXCLUDED.module,
				gloss = EXCLUDED.gloss,
				synonyms = EXCLUDED.synonyms,
				embed_text = EXCLUDED.embed_text,
				m_schema_compact = EXCLUDED.m_schema_compact,
				data_type = EXCLUDED.data_type,
				is_pk = EXCLUDED.is_pk,
				is_fk = EXCLUDED.is_fk,
				fk_target = EXCLUDED.fk_target,
				is_nullable = EXCLUDED.is_nullable,
				is_generic = EXCLUDED.is_generic,
				embedding = EXCLUDED.embedding,
				fingerprint = EXCLUDED.fingerprint,
				updated_at = now()
			RETURNING (xmax = 0) AS inserted
		`

		const values =
			record.entity_type === "table"
				? [
						databaseId,
						record.entity_type,
						record.table_schema,
						record.table_name,
						null, // column_name
						record.module,
						record.gloss,
						record.synonyms,
						record.embed_text,
						record.m_schema_compact,
						null, // data_type
						false, // is_pk
						false, // is_fk
						null, // fk_target
						true, // is_nullable
						false, // is_generic
						vectorLiteral,
						record.fingerprint,
					]
				: [
						databaseId,
						record.entity_type,
						record.table_schema,
						record.table_name,
						record.column_name,
						record.module,
						record.gloss,
						record.synonyms,
						record.embed_text,
						null, // m_schema_compact
						(record as ColumnEmbedding).data_type,
						(record as ColumnEmbedding).is_pk,
						(record as ColumnEmbedding).is_fk,
						(record as ColumnEmbedding).fk_target,
						(record as ColumnEmbedding).is_nullable,
						(record as ColumnEmbedding).is_generic,
						vectorLiteral,
						record.fingerprint,
					]

		const result = await client.query(query, values)
		return result.rows[0].inserted ? "inserted" : "updated"
	}

	/**
	 * Check if a column name matches generic patterns
	 */
	private isGenericColumn(columnName: string): boolean {
		const patterns = this.config.genericPatterns || DEFAULT_GENERIC_PATTERNS

		for (const pattern of patterns) {
			if (columnName === pattern || columnName.endsWith(pattern)) {
				return true
			}
		}
		return false
	}
}

// ============================================================================
// Singleton
// ============================================================================

let defaultEmbedder: SchemaEmbedder | null = null

export function getSchemaEmbedder(
	pool: Pool,
	logger: { info: Function; error: Function; warn: Function; debug: Function },
	config?: EmbedderConfig,
): SchemaEmbedder {
	if (!defaultEmbedder) {
		defaultEmbedder = new SchemaEmbedder(pool, logger, config)
	}
	return defaultEmbedder
}

export function resetSchemaEmbedder(): void {
	defaultEmbedder = null
}

// ============================================================================
// Exports for testing
// ============================================================================

export const _testing = {
	inferGloss,
	expandName,
	generateSynonyms,
	generateTableEmbedText,
	generateStableTableEmbedText,
	generateTableMSchemaCompact,
	generateTableMSchemaCompactOneLine,
	generateColumnEmbedText,
	generateStableColumnEmbedText,
	inferTypeTag,
	generateMicroGloss,
	generateTableGloss,
	DEFAULT_ABBREVIATIONS,
	DEFAULT_GENERIC_PATTERNS,
}
