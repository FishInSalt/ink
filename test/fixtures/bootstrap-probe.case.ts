import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, inject, it } from "vitest";
import { NETWORK_PRELOAD } from "../helpers/cli-fixture.js";

it("probes the actual global-setup -> worker -> Node+tsx bootstrap", () => {
	const root = inject("testRunRoot");
	expect(tmpdir()).toBe(root);
	for (const key of ["TMPDIR", "TMP", "TEMP"]) expect(process.env[key]).toBe(root);
	expect(statSync(root).mode & 0o777).toBe(0o700);
	expect(Object.hasOwn(globalThis, Symbol.for("ink.test.network-blocker"))).toBe(true);
	expect(process.env.NODE_OPTIONS).toContain(NETWORK_PRELOAD);
	for (const key of ["HOME", "INK_SETTINGS_PATH", "INK_AUTH_PATH", "INK_CATALOG_PATH", "XDG_CONFIG_HOME"])
		expect(process.env[key]?.startsWith(`${root}/`)).toBe(true);
	expect(existsSync(process.env.HOME!)).toBe(true);
	const fixture = mkdtempSync(path.join(tmpdir(), "ink-bootstrap-worker-"));
	rmdirSync(fixture);
	const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
	const child = JSON.parse(
		execFileSync(process.execPath, ["--import", loader, path.join(import.meta.dirname, "tmpdir-probe.ts")], {
			env: process.env,
			encoding: "utf8",
			timeout: 5000,
		}),
	);
	expect(child.tmpdir).toBe(root);
	expect(child.fixture.startsWith(`${root}/`)).toBe(true);
	expect(child.preloaded).toBe(true);
	expect(child.options).toContain(NETWORK_PRELOAD);
	// Model a retained artifact. The real global teardown must not erase it,
	// even after the settings sandbox has cleaned its own contents.
	writeFileSync(path.join(root, "bootstrap-diagnostic"), "retained evidence");
	writeFileSync(inject("bootstrapReport"), JSON.stringify({ root, fixture, child, home: process.env.HOME }));
});
