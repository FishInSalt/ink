import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { NETWORK_PRELOAD } from "./helpers/cli-fixture.js";
import { mkTempDir } from "./helpers/mktemp.js";

interface WorkflowStep {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
	"timeout-minutes"?: number;
}
interface WorkflowJob {
	"runs-on": string;
	env: Record<string, string>;
	strategy?: { matrix: { node: Array<string | number>; os: string[] } };
	steps: WorkflowStep[];
}
interface Workflow {
	jobs: Record<string, WorkflowJob>;
}

function workflow(name: string): Workflow {
	return parse(
		readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
	) as Workflow;
}

describe("CI prerequisite coverage", () => {
	it("tests the exact supported Node minimum and Node 24", () => {
		expect(workflow("ci").jobs.verify?.strategy?.matrix.node).toEqual(["22.19.0", 24]);
	});

	it.each([
		["ci", "verify"],
		["release", "gate"],
	])("%s/%s provisions and verifies required search tools before tests", (name, jobName) => {
		const job = workflow(name).jobs[jobName];
		if (name === "ci") {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression, not JavaScript interpolation.
			expect(job?.["runs-on"]).toBe("${{ matrix.os }}");
			expect(job?.strategy?.matrix.os).toEqual(["ubuntu-latest"]);
		} else {
			expect(job?.["runs-on"]).toBe("ubuntu-latest");
		}
		expect(job?.env.CI_REQUIRE_SEARCH_TOOLS).toBe("1");
		const steps = job?.steps ?? [];
		const install = steps.findIndex((step) => step.name === "install search test prerequisites");
		const verify = steps.findIndex((step) => step.name === "verify search test prerequisites");
		const test = steps.findIndex((step) => step.run === "npm test");
		expect(install).toBeGreaterThan(-1);
		expect(verify).toBe(install + 1);
		expect(test).toBeGreaterThan(verify);
		expect(steps[install]?.run).toBe("bash scripts/install-ci-search-tools.sh");
		expect(steps[install]?.["timeout-minutes"]).toBe(10);
		expect(steps[install]).not.toHaveProperty("continue-on-error");
		expect(steps[verify]?.run?.trim().split("\n")).toEqual(["rg --version", "fd --version"]);
	});
});

interface ProvisionCall {
	tool: string;
	args: string[];
	action?: string;
	options?: Record<string, string>;
	sources?: string;
	foreign?: string;
}

function provision(overrides: NodeJS.ProcessEnv = {}) {
	const root = mkTempDir("ink-search-prerequisites-");
	const bin = join(root, "bin");
	const runner = join(root, "runner temp with spaces");
	const aptParent = join(root, "canonical tmp with spaces");
	for (const directory of [bin, runner, aptParent, join(root, "home"), join(root, "tmp")])
		mkdirSync(directory, { mode: 0o700 });
	const output = join(root, "github path");
	const log = join(root, "calls.jsonl");
	const networkLog = join(root, "blocked-network.log");
	writeFileSync(output, "");
	const stub = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
	};
	stub("uname", 'console.log(process.env.TEST_PLATFORM || "Linux");');
	stub(
		"lsb_release",
		'console.log(process.argv[2] === "-is" ? (process.env.TEST_DISTRO || "Ubuntu") : (process.env.TEST_CODENAME || "noble"));',
	);
	stub(
		"dpkg",
		'console.log(process.argv[2] === "--print-architecture" ? (process.env.TEST_ARCH || "amd64") : (process.env.TEST_FOREIGN || ""));',
	);
	// Map the exact production templates into owned fixtures. Never create
	// loose local /tmp roots or execute a different mktemp program.
	stub(
		"mktemp",
		`
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "-d") process.exit(99);
let prefix;
if (args[1] === "/tmp/ink-ci-search.XXXXXX") prefix = path.join(process.env.TEST_APT_PARENT, "ink-ci-search.");
else if (args[1] === path.join(process.env.TEST_RUNNER_ROOT, "ink-ci-tools.XXXXXX")) prefix = path.join(process.env.TEST_RUNNER_ROOT, "ink-ci-tools.");
else process.exit(99);
fs.appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify({tool:"mktemp",args}) + "\\n");
console.log(fs.mkdtempSync(prefix));
`,
	);
	// This sudo stub records arguments and returns fixture statuses. It NEVER
	// imports child_process or executes apt, even when passed an unknown command.
	stub(
		"sudo",
		`
const fs = require("node:fs");
const full = process.argv.slice(2);
if (full[0] === "-n") {
  if (full.length !== 6 || full[1] !== "-u" || full[2] !== "_apt" || full[3] !== "/usr/bin/test" || full[4] !== "-r") process.exit(99);
  fs.appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify({tool:"sudo",args:full,action:"access-check"}) + "\\n");
  process.exit(process.env.TEST_FAIL === "access-check" ? 4 : 0);
}
if (process.argv[2] !== "apt-get") process.exit(99);
const args = process.argv.slice(3), options = {};
let i = 0;
while (args[i] === "-o") {
  const value = args[i + 1], equal = value.indexOf("=");
  options[value.slice(0, equal)] = value.slice(equal + 1); i += 2;
}
const action = args[i];
if (action !== "update" && action !== "install") process.exit(99);
fs.appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify({
  tool: "sudo", args: process.argv.slice(2), action, options,
  sources: fs.readFileSync(options["Dir::Etc::sourcelist"], "utf8"),
  foreign: process.env.TEST_FOREIGN || "",
}) + "\\n");
if (process.env.TEST_FAIL === action) process.exit(100);
`,
	);
	for (const name of ["rg", "fdfind"]) {
		stub(
			name,
			`
require("node:fs").appendFileSync(process.env.TEST_CALL_LOG, JSON.stringify({tool:${JSON.stringify(name)},args:process.argv.slice(2)}) + "\\n");
if (process.env.TEST_FAIL === ${JSON.stringify(name)}) process.exit(3);
console.log(${JSON.stringify(`${name} synthetic version`)});
`,
		);
	}
	const helper = fileURLToPath(new URL("../scripts/install-ci-search-tools.sh", import.meta.url));
	const result = spawnSync("/bin/bash", [helper], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
		env: {
			PATH: `${bin}:/usr/bin:/bin`,
			HOME: join(root, "home"),
			TMPDIR: join(root, "tmp"),
			RUNNER_TEMP: runner,
			GITHUB_PATH: output,
			TEST_CALL_LOG: log,
			TEST_APT_PARENT: aptParent,
			TEST_RUNNER_ROOT: runner,
			NODE_OPTIONS: `--require ${JSON.stringify(NETWORK_PRELOAD)}`,
			INK_TEST_NETWORK_LOG: networkLog,
			...overrides,
		},
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(existsSync(networkLog) ? readFileSync(networkLog, "utf8") : "").toBe("");
	const calls: ProvisionCall[] = existsSync(log)
		? readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as ProvisionCall)
		: [];
	return { result, root, runner, aptParent, bin, output: readFileSync(output, "utf8"), calls };
}

describe("isolated CI apt provisioning (non-executing privilege mocks)", () => {
	it("has valid Bash syntax without executing privileged commands", () => {
		const script = fileURLToPath(new URL("../scripts/install-ci-search-tools.sh", import.meta.url));
		expect(spawnSync("/bin/bash", ["-n", script]).status).toBe(0);
		const source = readFileSync(script, "utf8");
		expect(source).not.toMatch(
			/\/usr\/bin\/(?:sudo|apt-get)|--allow-unauthenticated|trusted=yes|curl.*\|.*sh|resolv\.conf/,
		);
	});

	it.each(["", "arm64\ni386"])("uses only signed amd64 sources with foreign registrations %j", (foreign) => {
		const env = provision({ TEST_FOREIGN: foreign });
		expect(env.result.status, env.result.stderr).toBe(0);
		const privilege = env.calls.filter((call) => call.tool === "sudo");
		expect(privilege.map((call) => call.action)).toEqual(["access-check", "update", "install"]);
		const apt = privilege.slice(1);
		expect(privilege[0]!.args).toEqual([
			"-n",
			"-u",
			"_apt",
			"/usr/bin/test",
			"-r",
			apt[0]!.options!["Dir::Etc::sourcelist"],
		]);
		expect(env.calls.filter((call) => call.tool === "mktemp").map((call) => call.args)).toEqual([
			["-d", "/tmp/ink-ci-search.XXXXXX"],
			["-d", join(env.runner, "ink-ci-tools.XXXXXX")],
		]);
		expect(apt[0]!.options).toEqual(apt[1]!.options);
		const options = apt[0]!.options!;
		expect(options).toMatchObject({
			"Dir::Etc::sourceparts": "-",
			"Acquire::Retries": "1",
			"Acquire::http::Timeout": "15",
			"Acquire::https::Timeout": "15",
			"APT::Update::Error-Mode": "any",
			"APT::Sandbox::User": "_apt",
		});
		for (const field of ["Dir::Etc::sourcelist", "Dir::State::lists", "Dir::Cache", "Dir::Cache::archives"]) {
			expect(options[field]?.startsWith(`${env.aptParent}/`)).toBe(true);
			expect(options[field]?.startsWith(`${env.runner}/`)).toBe(false);
		}
		expect(options["Dir::Cache::archives"]).toBe(join(options["Dir::Cache"]!, "archives"));
		expect(statSync(join(options["Dir::Etc::sourcelist"]!, "..")).mode & 0o777).toBe(0o755);
		const sources = apt[0]!.sources!;
		expect(sources.trim().split("\n")).toEqual([
			"deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble main universe",
			"deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu noble-updates main universe",
			"deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu noble-security main universe",
		]);
		expect(apt.every((call) => call.sources === sources && call.foreign === foreign)).toBe(true);
		expect(sources).not.toContain("azure");
		expect(apt[1]!.args.slice(-5)).toEqual([
			"install",
			"-y",
			"--no-install-recommends",
			"ripgrep",
			"fd-find",
		]);
		expect(
			env.calls.filter((call) => call.tool === "rg" || call.tool === "fdfind").map((call) => call.tool),
		).toEqual(["rg", "fdfind", "fdfind"]);
		const tools = env.output.trim();
		expect(tools.startsWith(`${env.runner}/`)).toBe(true);
		expect(readFileSync(join(tools, "fd"), "utf8")).toBe(readFileSync(join(env.bin, "fdfind"), "utf8"));
		expect(statSync(tools).mode & 0o777).toBe(0o700);
		expect(statSync(env.runner).mode & 0o777).toBe(0o700);
	});

	it.each([
		{ TEST_PLATFORM: "Darwin" },
		{ TEST_DISTRO: "Debian" },
		{ TEST_ARCH: "arm64" },
		{ TEST_CODENAME: "noble\ninjected" },
		{ TEST_CODENAME: "../noble" },
		{ RUNNER_TEMP: "relative" },
		{ GITHUB_PATH: "relative" },
		{ GITHUB_PATH: "" },
		{ GITHUB_PATH: "/tmp/bad\npath" },
	])("rejects unsupported/invalid configuration before privilege execution: %j", (fields) => {
		const env = provision(fields);
		expect(env.result.status).not.toBe(0);
		expect(env.calls).toEqual([]);
		expect(env.output).toBe("");
	});

	it("keeps a failed sandbox-user access check fatal before APT or PATH publication", () => {
		const env = provision({ TEST_FAIL: "access-check" });
		expect(env.result.status).toBe(4);
		expect(env.calls.filter((call) => call.tool === "sudo").map((call) => call.action)).toEqual([
			"access-check",
		]);
		expect(env.output).toBe("");
	});

	it.each(["update", "install", "rg", "fdfind"])(
		"keeps %s failure fatal and never publishes PATH",
		(failure) => {
			const env = provision({ TEST_FAIL: failure });
			expect(env.result.status).toBe(failure === "update" || failure === "install" ? 100 : 3);
			expect(env.output).toBe("");
			const apt = env.calls.filter((call) => call.action === "update" || call.action === "install");
			expect(apt.map((call) => call.action)).toEqual(
				failure === "update" ? ["update"] : ["update", "install"],
			);
		},
	);
});

const repo = fileURLToPath(new URL("../", import.meta.url));
const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

function childSearchTest(missing: readonly string[], required?: string) {
	const root = mkTempDir("ink-search-prerequisites-");
	try {
		for (const name of ["home", "bin", "tmp"]) mkdirSync(join(root, name), { mode: 0o700 });
		// These stubs only prove collection-time binary availability. They never
		// execute a search: strict missing-tool cases fail before test execution,
		// and optional cases deliberately omit both binaries so all tests skip.
		for (const name of ["rg", "fd"]) {
			if (!missing.includes(name)) {
				writeFileSync(join(root, "bin", name), "#!/bin/sh\nprintf 'synthetic binary version\\n'\n", {
					mode: 0o755,
					flag: "wx",
				});
			}
		}
		const report = join(root, "report.json");
		const log = join(root, "blocked-network.log");
		const result = spawnSync(
			process.execPath,
			[
				vitest,
				"run",
				"test/search-tools.test.ts",
				"--maxWorkers=1",
				"--no-file-parallelism",
				"--reporter=json",
				`--outputFile=${report}`,
			],
			{
				cwd: repo,
				encoding: "utf8",
				timeout: 20_000,
				maxBuffer: 1024 * 1024,
				env: {
					// No inherited credentials, proxies, config, real HOME or parent CI flag.
					HOME: join(root, "home"),
					USERPROFILE: join(root, "home"),
					TMPDIR: join(root, "tmp"),
					PATH: join(root, "bin"),
					NO_COLOR: "1",
					NODE_OPTIONS: `--require ${JSON.stringify(NETWORK_PRELOAD)}`,
					INK_TEST_NETWORK_LOG: log,
					...(required === undefined ? {} : { CI_REQUIRE_SEARCH_TOOLS: required }),
				},
			},
		);
		expect(result.error).toBeUndefined();
		expect(result.signal).toBeNull();
		// A swallowed nonlocal attempt also produces stderr and a failing child.
		// Check the exact collection error in the caller to exclude unrelated exits.
		expect(result.stderr).not.toContain("Blocked nonlocal");
		const reportText = readFileSync(report, "utf8");
		return {
			status: result.status,
			output: result.stdout + result.stderr + reportText,
			report: JSON.parse(reportText) as {
				success: boolean;
				numPassedTests: number;
				numFailedTests: number;
				numPendingTests: number;
			},
		};
	} finally {
		rmSync(root, { recursive: true });
	}
}

describe("search prerequisite failure versus optional local skips", () => {
	it.each(["rg", "fd"])("fails collection specifically when required %s is absent", (name) => {
		const result = childSearchTest([name], "1");
		expect(result.status).toBe(1);
		expect(result.report.success).toBe(false);
		expect(result.output).toContain(`Required search test binaries missing: ${name}`);
		expect(result.output).not.toContain(`missing: ${name},`);
	});

	it.each([undefined, "0"])("keeps local skips without an enabled strict flag (%s)", (flag) => {
		const result = childSearchTest(["rg", "fd"], flag);
		expect(result.status).toBe(0);
		expect(result.report.success).toBe(true);
		expect(result.report.numPassedTests).toBe(0);
		expect(result.report.numFailedTests).toBe(0);
		expect(result.report.numPendingTests).toBe(27);
		expect(result.output).not.toContain("Required search test binaries missing:");
	});
});
