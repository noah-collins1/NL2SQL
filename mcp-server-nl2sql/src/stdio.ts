#!/usr/bin/env node
/**
 * Stdio entry point for NL2SQL MCP Server
 *
 * This allows the server to be run via LibreChat's MCP integration
 * which expects stdio transport.
 *
 * Config priority:
 *   1. .mcp.json file in server directory (highest priority)
 *   2. CLI argument
 *   3. Environment variables
 *
 * Usage:
 *   node stdio.js '{"postgresConnectionString":"postgresql://...","role":"read"}'
 *
 * Or via environment variables:
 *   POSTGRES_CONNECTION_STRING=postgresql://... POSTGRES_ROLE=read node stdio.js
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import createServer, { configSchema } from "./index.js"

// Simple logger that writes to stderr (stdout is reserved for MCP protocol)
const logger = {
	info: (...args: any[]) => console.error("[INFO]", ...args),
	error: (...args: any[]) => console.error("[ERROR]", ...args),
	warn: (...args: any[]) => console.error("[WARN]", ...args),
	debug: (...args: any[]) => console.error("[DEBUG]", ...args),
}

/**
 * Try to load config from .mcp.json file in the server directory
 */
function loadConfigFromFile(): { postgresConnectionString: string; role: string } | null {
	try {
		// Get the directory of this script
		const __filename = fileURLToPath(import.meta.url)
		const __dirname = dirname(__filename)

		// Look for .mcp.json in parent directory (project root)
		const configPath = join(__dirname, "..", ".mcp.json")

		if (existsSync(configPath)) {
			const content = readFileSync(configPath, "utf-8")
			const parsed = JSON.parse(content)
			const validated = configSchema.parse(parsed)
			logger.info(`Config loaded from ${configPath}`)
			return validated
		}
	} catch (e) {
		logger.warn("Failed to load config from .mcp.json:", e)
	}
	return null
}

async function main() {
	// Parse config from file, CLI argument, or environment variables
	// Priority: .mcp.json > CLI argument > env vars
	let config: { postgresConnectionString: string; role: string }

	// Try .mcp.json first (bypasses LibreChat's cached config)
	const fileConfig = loadConfigFromFile()
	if (fileConfig) {
		config = fileConfig
	} else {
		const configArg = process.argv[2]
		if (configArg) {
			try {
				const parsed = JSON.parse(configArg)
				const validated = configSchema.parse(parsed)
				config = validated
				logger.info("Config loaded from CLI argument")
			} catch (e) {
				logger.error("Failed to parse config from CLI argument:", e)
				process.exit(1)
			}
		} else if (process.env.POSTGRES_CONNECTION_STRING) {
			config = {
				postgresConnectionString: process.env.POSTGRES_CONNECTION_STRING,
				role: process.env.POSTGRES_ROLE || "read",
			}
			const validated = configSchema.parse(config)
			config = validated
			logger.info("Config loaded from environment variables")
		} else {
			logger.error("No config provided. Usage:")
			logger.error('  node stdio.js \'{"postgresConnectionString":"postgresql://...","role":"read"}\'')
			logger.error("  Or set POSTGRES_CONNECTION_STRING environment variable")
			process.exit(1)
		}
	}

	logger.info("Starting NL2SQL MCP Server with stdio transport")
	logger.info(`Database: ${config.postgresConnectionString.replace(/:[^:@]+@/, ':***@')}`)
	logger.info(`Role: ${config.role}`)

	// Create the server
	const server = createServer({ config, logger })

	// Connect via stdio transport
	const transport = new StdioServerTransport()
	await server.connect(transport)

	logger.info("NL2SQL MCP Server running via stdio")

	// Handle graceful shutdown
	process.on("SIGINT", async () => {
		logger.info("Shutting down...")
		await server.close()
		process.exit(0)
	})

	process.on("SIGTERM", async () => {
		logger.info("Shutting down...")
		await server.close()
		process.exit(0)
	})
}

main().catch((error) => {
	logger.error("Fatal error:", error)
	process.exit(1)
})
