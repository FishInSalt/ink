import { join } from "node:path";
import { expect, it } from "vitest";
import {
	AGENTS_SKILLS_PATH,
	INK_RESOURCE_PATHS,
	PROJECT_MCP_CONFIG_NAMES,
	projectMcpConfigPaths,
} from "../src/core/resource-paths.js";

it("keeps the existing relative resource paths without discovery or authorization", () => {
	expect(INK_RESOURCE_PATHS).toEqual({
		extensions: ".ink/extensions",
		agents: ".ink/agents",
		commands: ".ink/commands",
		skills: ".ink/skills",
		settings: ".ink/settings.json",
		system: ".ink/SYSTEM.md",
		appendSystem: ".ink/APPEND_SYSTEM.md",
	});
	expect(AGENTS_SKILLS_PATH).toBe(".agents/skills");
	expect(PROJECT_MCP_CONFIG_NAMES).toEqual([".mcp.json", "mcp.json"]);
});

it("generates both project MCP paths in override order, even for a nonexistent cwd", () => {
	const cwd = join("/nonexistent-resource-path-fixture", "project");
	expect(projectMcpConfigPaths(cwd)).toEqual([join(cwd, ".mcp.json"), join(cwd, "mcp.json")]);
});
