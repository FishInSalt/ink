import { join } from "node:path";

/** Relative path facts only. Each loader owns its checks, precedence and gate. */
export const INK_RESOURCE_PATHS = {
	extensions: ".ink/extensions",
	agents: ".ink/agents",
	commands: ".ink/commands",
	skills: ".ink/skills",
	settings: ".ink/settings.json",
	system: ".ink/SYSTEM.md",
	appendSystem: ".ink/APPEND_SYSTEM.md",
} as const;

export const AGENTS_SKILLS_PATH = ".agents/skills";
export const PROJECT_MCP_CONFIG_NAMES = [".mcp.json", "mcp.json"] as const;

/** Ordered project tier, also used to classify paths in full MCP overrides. */
export function projectMcpConfigPaths(cwd: string): string[] {
	return PROJECT_MCP_CONFIG_NAMES.map((name) => join(cwd, name));
}
