/**
 * Column Pruner
 *
 * Phase 1.4: Trim columns per table to reduce prompt size.
 * Keeps: PK/FK columns + linker-matched columns + top-N by ordinal position.
 */

import { TableMeta, ColumnMeta } from "./schema_types.js"
import { SchemaLinkBundle } from "./schema_linker.js"
import { getConfig } from "./config/loadConfig.js"

export const COLUMN_PRUNING_ENABLED = process.env.COLUMN_PRUNING_ENABLED !== undefined
	? process.env.COLUMN_PRUNING_ENABLED === "true"
	: getConfig().features.column_pruning

/**
 * Prune columns per table to reduce prompt size.
 * Keeps: PK/FK columns + linker-matched columns + top-N by ordinal position.
 *
 * Returns new TableMeta objects (does not mutate input).
 */
export function pruneColumns(
	tables: Map<string, TableMeta>,
	schemaLinkBundle?: SchemaLinkBundle | null,
	maxNonStructural: number = 5,
): { pruned: Map<string, TableMeta>; totalPruned: number } {
	let totalPruned = 0
	const pruned = new Map<string, TableMeta>()

	for (const [tableName, table] of tables) {
		const originalCount = table.columns.length

		// Small tables: don't prune if <= maxNonStructural + typical PK/FK count
		if (originalCount <= maxNonStructural + 3) {
			pruned.set(tableName, table)
			continue
		}

		// Get linked columns for this table
		const linkedCols = new Set<string>()
		if (schemaLinkBundle?.linkedColumns[tableName]) {
			for (const lc of schemaLinkBundle.linkedColumns[tableName]) {
				linkedCols.add(lc.column.toLowerCase())
			}
		}

		// Classify columns
		const structural: ColumnMeta[] = [] // PK/FK — always keep
		const linked: ColumnMeta[] = [] // Linker-matched — always keep
		const remaining: ColumnMeta[] = [] // Everything else — top-N by ordinal

		for (const col of table.columns) {
			if (col.is_pk || col.is_fk) {
				structural.push(col)
			} else if (linkedCols.has(col.column_name.toLowerCase())) {
				linked.push(col)
			} else {
				remaining.push(col)
			}
		}

		// Sort remaining by ordinal position (early columns tend to be more important)
		remaining.sort((a, b) => a.ordinal_pos - b.ordinal_pos)

		// How many non-structural slots do we have?
		const slotsUsedByLinked = linked.length
		const nonStructuralSlots = Math.max(0, maxNonStructural - slotsUsedByLinked)
		const topRemaining = remaining.slice(0, nonStructuralSlots)

		const keptColumns = [...structural, ...linked, ...topRemaining]
		// Sort back by ordinal position for consistent output
		keptColumns.sort((a, b) => a.ordinal_pos - b.ordinal_pos)

		const prunedCount = originalCount - keptColumns.length
		totalPruned += prunedCount

		pruned.set(tableName, {
			...table,
			columns: keptColumns,
		})
	}

	return { pruned, totalPruned }
}
