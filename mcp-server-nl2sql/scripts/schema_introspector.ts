/**
 * Schema Introspector
 *
 * DB-agnostic schema introspection via information_schema + pg_catalog.
 * Extracts tables, columns, PKs, FKs, and comments from ANY connected Postgres DB.
 *
 * This module is the foundation for embedding-friendly schema representation.
 */

import { Pool, PoolClient } from "pg"

// ============================================================================
// Types
// ============================================================================

export interface IntrospectedColumn {
	column_name: string
	data_type: string
	is_nullable: boolean
	ordinal_position: number
	column_default: string | null
	comment: string | null // From pg_description

	// Key info
	is_pk: boolean
	pk_ordinal: number | null

	// FK info
	is_fk: boolean
	fk_constraint_name: string | null
	fk_target_schema: string | null
	fk_target_table: string | null
	fk_target_column: string | null
}

export interface IntrospectedTable {
	table_schema: string
	table_name: string
	table_type: string // 'BASE TABLE' | 'VIEW'
	comment: string | null // From pg_description
	columns: IntrospectedColumn[]

	// Computed
	pk_columns: string[]
	fk_count: number
	column_count: number
}

export interface IntrospectedFK {
	constraint_name: string
	table_schema: string
	table_name: string
	column_name: string
	ref_table_schema: string
	ref_table_name: string
	ref_column_name: string
}

export interface IntrospectionResult {
	database_id: string
	tables: IntrospectedTable[]
	fks: IntrospectedFK[]
	introspected_at: string
}

// ============================================================================
// Introspector Class
// ============================================================================

export class SchemaIntrospector {
	private pool: Pool
	private logger: {
		info: Function
		error: Function
		warn: Function
		debug: Function
	}

	constructor(
		pool: Pool,
		logger: { info: Function; error: Function; warn: Function; debug: Function },
	) {
		this.pool = pool
		this.logger = logger
	}

	/**
	 * Introspect all tables in specified schemas
	 *
	 * @param databaseId Identifier for this database
	 * @param schemas Schemas to introspect (default: ['public'])
	 * @param excludeTables Tables to exclude (e.g., migration tables)
	 */
	async introspect(
		databaseId: string,
		schemas: string[] = ["public"],
		excludeTables: string[] = [],
	): Promise<IntrospectionResult> {
		const startTime = Date.now()
		this.logger.info("Starting schema introspection", {
			database_id: databaseId,
			schemas,
			exclude_tables: excludeTables,
		})

		let client: PoolClient | null = null

		try {
			client = await this.pool.connect()

			// Step 1: Get all tables
			const tables = await this.getTables(client, schemas, excludeTables)
			this.logger.debug("Tables found", { count: tables.length })

			// Step 2: Get all columns with PK/FK info
			const tableNames = tables.map((t) => t.table_name)
			const columns = await this.getColumns(client, schemas, tableNames)
			this.logger.debug("Columns found", { count: columns.length })

			// Step 3: Get all FK relationships
			const fks = await this.getForeignKeys(client, schemas, tableNames)
			this.logger.debug("Foreign keys found", { count: fks.length })

			// Step 4: Merge columns into tables
			const enrichedTables = this.mergeColumnsIntoTables(tables, columns, fks)

			const result: IntrospectionResult = {
				database_id: databaseId,
				tables: enrichedTables,
				fks,
				introspected_at: new Date().toISOString(),
			}

			const latency = Date.now() - startTime
			this.logger.info("Schema introspection complete", {
				database_id: databaseId,
				tables: result.tables.length,
				total_columns: columns.length,
				fks: fks.length,
				latency_ms: latency,
			})

			return result
		} finally {
			if (client) {
				client.release()
			}
		}
	}

	/**
	 * Get all tables from information_schema
	 */
	private async getTables(
		client: PoolClient,
		schemas: string[],
		excludeTables: string[],
	): Promise<
		Array<{
			table_schema: string
			table_name: string
			table_type: string
			comment: string | null
		}>
	> {
		const query = `
			SELECT
				t.table_schema,
				t.table_name,
				t.table_type,
				pg_catalog.obj_description(
					(quote_ident(t.table_schema) || '.' || quote_ident(t.table_name))::regclass,
					'pg_class'
				) AS comment
			FROM information_schema.tables t
			WHERE t.table_schema = ANY($1)
				AND t.table_type IN ('BASE TABLE', 'VIEW')
				AND t.table_name != ALL($2)
			ORDER BY t.table_schema, t.table_name
		`

		const result = await client.query(query, [schemas, excludeTables])
		return result.rows
	}

	/**
	 * Get all columns with PK info
	 */
	private async getColumns(
		client: PoolClient,
		schemas: string[],
		tableNames: string[],
	): Promise<
		Array<{
			table_schema: string
			table_name: string
			column_name: string
			data_type: string
			is_nullable: boolean
			ordinal_position: number
			column_default: string | null
			comment: string | null
			is_pk: boolean
			pk_ordinal: number | null
		}>
	> {
		const query = `
			WITH pk_columns AS (
				SELECT
					kcu.table_schema,
					kcu.table_name,
					kcu.column_name,
					kcu.ordinal_position AS pk_ordinal
				FROM information_schema.table_constraints tc
				JOIN information_schema.key_column_usage kcu
					ON tc.constraint_name = kcu.constraint_name
					AND tc.table_schema = kcu.table_schema
				WHERE tc.constraint_type = 'PRIMARY KEY'
					AND tc.table_schema = ANY($1)
			)
			SELECT
				c.table_schema,
				c.table_name,
				c.column_name,
				c.data_type,
				(c.is_nullable = 'YES') AS is_nullable,
				c.ordinal_position,
				c.column_default,
				pg_catalog.col_description(
					(quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass,
					c.ordinal_position
				) AS comment,
				(pk.column_name IS NOT NULL) AS is_pk,
				pk.pk_ordinal
			FROM information_schema.columns c
			LEFT JOIN pk_columns pk
				ON pk.table_schema = c.table_schema
				AND pk.table_name = c.table_name
				AND pk.column_name = c.column_name
			WHERE c.table_schema = ANY($1)
				AND c.table_name = ANY($2)
			ORDER BY c.table_schema, c.table_name, c.ordinal_position
		`

		const result = await client.query(query, [schemas, tableNames])
		return result.rows
	}

	/**
	 * Get all foreign key relationships
	 */
	private async getForeignKeys(
		client: PoolClient,
		schemas: string[],
		tableNames: string[],
	): Promise<IntrospectedFK[]> {
		const query = `
			SELECT
				tc.constraint_name,
				kcu.table_schema,
				kcu.table_name,
				kcu.column_name,
				ccu.table_schema AS ref_table_schema,
				ccu.table_name AS ref_table_name,
				ccu.column_name AS ref_column_name
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
				ON tc.constraint_name = kcu.constraint_name
				AND tc.table_schema = kcu.table_schema
			JOIN information_schema.constraint_column_usage ccu
				ON ccu.constraint_name = tc.constraint_name
			WHERE tc.constraint_type = 'FOREIGN KEY'
				AND tc.table_schema = ANY($1)
				AND kcu.table_name = ANY($2)
			ORDER BY kcu.table_schema, kcu.table_name, kcu.column_name
		`

		const result = await client.query(query, [schemas, tableNames])
		return result.rows
	}

	/**
	 * Merge column and FK data into table structures
	 */
	private mergeColumnsIntoTables(
		tables: Array<{
			table_schema: string
			table_name: string
			table_type: string
			comment: string | null
		}>,
		columns: Array<{
			table_schema: string
			table_name: string
			column_name: string
			data_type: string
			is_nullable: boolean
			ordinal_position: number
			column_default: string | null
			comment: string | null
			is_pk: boolean
			pk_ordinal: number | null
		}>,
		fks: IntrospectedFK[],
	): IntrospectedTable[] {
		// Index FKs by table.column
		const fkIndex = new Map<string, IntrospectedFK>()
		for (const fk of fks) {
			const key = `${fk.table_schema}.${fk.table_name}.${fk.column_name}`
			fkIndex.set(key, fk)
		}

		// Group columns by table
		const columnsByTable = new Map<string, typeof columns>()
		for (const col of columns) {
			const key = `${col.table_schema}.${col.table_name}`
			const existing = columnsByTable.get(key) || []
			existing.push(col)
			columnsByTable.set(key, existing)
		}

		// Build enriched tables
		return tables.map((table) => {
			const key = `${table.table_schema}.${table.table_name}`
			const tableCols = columnsByTable.get(key) || []

			const enrichedColumns: IntrospectedColumn[] = tableCols.map((col) => {
				const fkKey = `${col.table_schema}.${col.table_name}.${col.column_name}`
				const fk = fkIndex.get(fkKey)

				return {
					column_name: col.column_name,
					data_type: col.data_type,
					is_nullable: col.is_nullable,
					ordinal_position: col.ordinal_position,
					column_default: col.column_default,
					comment: col.comment,
					is_pk: col.is_pk,
					pk_ordinal: col.pk_ordinal,
					is_fk: !!fk,
					fk_constraint_name: fk?.constraint_name ?? null,
					fk_target_schema: fk?.ref_table_schema ?? null,
					fk_target_table: fk?.ref_table_name ?? null,
					fk_target_column: fk?.ref_column_name ?? null,
				}
			})

			const pkColumns = enrichedColumns
				.filter((c) => c.is_pk)
				.sort((a, b) => (a.pk_ordinal ?? 0) - (b.pk_ordinal ?? 0))
				.map((c) => c.column_name)

			const fkCount = enrichedColumns.filter((c) => c.is_fk).length

			return {
				table_schema: table.table_schema,
				table_name: table.table_name,
				table_type: table.table_type,
				comment: table.comment,
				columns: enrichedColumns,
				pk_columns: pkColumns,
				fk_count: fkCount,
				column_count: enrichedColumns.length,
			}
		})
	}
}

// ============================================================================
// Singleton
// ============================================================================

let defaultIntrospector: SchemaIntrospector | null = null

export function getSchemaIntrospector(
	pool: Pool,
	logger: { info: Function; error: Function; warn: Function; debug: Function },
): SchemaIntrospector {
	if (!defaultIntrospector) {
		defaultIntrospector = new SchemaIntrospector(pool, logger)
	}
	return defaultIntrospector
}

export function resetSchemaIntrospector(): void {
	defaultIntrospector = null
}
