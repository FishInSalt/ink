import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
// @ts-expect-error Standalone release scripts do not ship TypeScript declarations.
import * as visibility from "../scripts/check-registry-visibility.mjs";
import { NETWORK_PRELOAD } from "./helpers/cli-fixture.js";
import { mkTempDir } from "./helpers/mktemp.js";

const { PUBLISH_NOTICE, RegistryVerificationError, runRegistryVisibility, verifyRegistryVisibility } =
	visibility;
const config = { packageName: "ink-agent", version: "0.99.0", commit: "a".repeat(40) };
const metadata = () => ({
	name: config.packageName,
	version: config.version,
	gitHead: config.commit,
	dist: { tarball: `https://registry.npmjs.org/ink-agent/-/ink-agent-${config.version}.tgz` },
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const script = fileURLToPath(new URL("../scripts/check-registry-visibility.mjs", import.meta.url));
function clocked(reply: (attempt: number, elapsed: number) => Response | Promise<Response>) {
	let elapsed = 0;
	let attempt = 0;
	const delays: number[] = [];
	const fetch = vi.fn(async () => reply(++attempt, elapsed));
	return {
		fetch,
		delays,
		now: () => elapsed,
		sleep: async (ms: number) => {
			delays.push(ms);
			elapsed += ms;
		},
		advance: (ms: number) => {
			elapsed += ms;
		},
	};
}
afterEach(() => vi.useRealTimers());

describe("bounded exact-version registry visibility", () => {
	it("imports without CLI/network side effects", () => {
		const root = mkTempDir("ink-release-guard-");
		const log = join(root, "network.log");
		const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
			input: `await import(${JSON.stringify(new URL("../scripts/check-registry-visibility.mjs", import.meta.url).href)}); console.log("imported");`,
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
			env: {
				PATH: "/usr/bin:/bin",
				NODE_OPTIONS: `--require ${JSON.stringify(NETWORK_PRELOAD)}`,
				INK_TEST_NETWORK_LOG: log,
			},
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("imported\n");
		expect(result.stderr).toBe("");
		expect(existsSync(log)).toBe(false);
	});

	it("verifies exact package/version/source/tarball, not latest or HTTP status alone", async () => {
		const env = clocked(() => json(metadata()));
		const result = await verifyRegistryVisibility(config, env);
		expect(result).toMatchObject({ ...config, attempts: 1, elapsedMs: 0 });
		expect(env.delays).toEqual([]);
		expect(env.fetch).toHaveBeenCalledWith(
			`https://registry.npmjs.org/ink-agent/${config.version}`,
			expect.objectContaining({
				method: "GET",
				redirect: "manual",
				credentials: "omit",
				cache: "no-store",
				headers: { accept: "application/json", "cache-control": "no-cache" },
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("accepts visibility after 180 seconds under the unchanged ten-minute budget", async () => {
		const env = clocked((_attempt, elapsed) => (elapsed < 185_000 ? json("not yet", 404) : json(metadata())));
		const result = await verifyRegistryVisibility(config, env);
		expect(result.elapsedMs).toBe(185_000);
		expect(result.attempts).toBe(9);
		expect(env.delays.slice(0, 4)).toEqual([5000, 10_000, 20_000, 30_000]);
		expect(env.delays.every((ms) => ms <= 30_000)).toBe(true);
		expect(new Set(env.fetch.mock.calls.map((call: unknown[]) => call[0]))).toEqual(
			new Set([`https://registry.npmjs.org/ink-agent/${config.version}`]),
		);
	});

	it("rejects an overdue response even when the request timer has not run yet", async () => {
		const env = clocked((attempt) => {
			if (attempt === 1) env.advance(16_000);
			return json(metadata());
		});
		expect((await verifyRegistryVisibility(config, env)).attempts).toBe(2);
		expect(env.delays).toEqual([5000]);
	});

	it.each([404, 429, 500, 502, 503, 504])("retries HTTP %s without parsing its body", async (status) => {
		const env = clocked((attempt) =>
			attempt === 1 ? new Response("PRIVATE_UNTRUSTED_BODY", { status }) : json(metadata()),
		);
		expect((await verifyRegistryVisibility(config, env)).attempts).toBe(2);
		expect(env.delays).toEqual([5000]);
	});

	it("cancels unused response bodies before the next probe", async () => {
		let canceled = 0;
		const env = clocked((attempt) =>
			attempt === 1
				? new Response(
						new ReadableStream({
							cancel() {
								canceled++;
							},
						}),
						{ status: 404 },
					)
				: json(metadata()),
		);
		await verifyRegistryVisibility(config, env);
		expect(canceled).toBe(1);
	});

	it("retries network failures without exposing raw errors", async () => {
		const env = clocked((attempt) => {
			if (attempt === 1) throw new Error("PRIVATE_NETWORK_DETAIL");
			return json(metadata());
		});
		expect((await verifyRegistryVisibility(config, env)).attempts).toBe(2);
	});

	it.each([
		{},
		{ name: "ink-agent" },
		{ name: "ink-agent", version: config.version, dist: {} },
		{ ...metadata(), gitHead: undefined },
		{ ...metadata(), dist: undefined },
	])("waits for consistent missing metadata %j", async (partial) => {
		const env = clocked((attempt) => json(attempt === 1 ? partial : metadata()));
		expect((await verifyRegistryVisibility(config, env)).attempts).toBe(2);
	});

	it.each([
		{ ...metadata(), name: "other-package" },
		{ ...metadata(), version: "0.98.0" },
		{ ...metadata(), gitHead: "b".repeat(40) },
		{ gitHead: "b".repeat(40) },
		{ ...metadata(), name: null },
		{ ...metadata(), gitHead: 1 },
		{ ...metadata(), dist: null },
		{ ...metadata(), dist: [] },
		{ ...metadata(), dist: { tarball: "https://other.invalid/package.tgz" } },
		{ dist: { tarball: 123 } },
		null,
		[],
		"PRIVATE_BODY",
		1,
	])("rejects malformed or mismatched metadata without hiding it behind absent fields: %j", async (wrong) => {
		const env = clocked(() => json(wrong));
		await expect(verifyRegistryVisibility(config, env)).rejects.toBeInstanceOf(RegistryVerificationError);
		expect(env.fetch).toHaveBeenCalledTimes(1);
		expect(env.delays).toEqual([]);
	});

	it.each([204, 301, 302, 307, 308, 400, 401, 403, 410])(
		"rejects terminal HTTP %s instead of waiting or following it",
		async (status) => {
			const env = clocked(
				() =>
					new Response(status === 204 ? null : "private", {
						status,
						headers: { location: "https://other.invalid" },
					}),
			);
			await expect(verifyRegistryVisibility(config, env)).rejects.toBeInstanceOf(RegistryVerificationError);
			expect(env.fetch).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["PRIVATE_INVALID_JSON", "x".repeat(256 * 1024 + 1)])(
		"rejects invalid or oversized bodies without echoing them",
		async (body) => {
			const env = clocked(() => new Response(body));
			const error = await verifyRegistryVisibility(config, env).catch((reason: Error) => reason);
			expect(error).toBeInstanceOf(RegistryVerificationError);
			expect(error.message).not.toContain("PRIVATE_INVALID_JSON");
			expect(error.message.length).toBeLessThan(150);
		},
	);

	it.each([
		{ ...config, packageName: "other" },
		{ ...config, version: "latest" },
		{ ...config, version: "0.99.0-beta" },
		{ ...config, version: "0.099.0" },
		{ ...config, version: "../0.99.0" },
		{ ...config, commit: "" },
		{ ...config, commit: "g".repeat(40) },
		null,
		undefined,
	])("rejects invalid input before network: %j", async (invalid) => {
		const env = clocked(() => json(metadata()));
		await expect(verifyRegistryVisibility(invalid, env)).rejects.toBeInstanceOf(RegistryVerificationError);
		expect(env.fetch).not.toHaveBeenCalled();
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects an invalid time budget %s before transport",
		async (budgetMs) => {
			const env = clocked(() => json(metadata()));
			await expect(verifyRegistryVisibility(config, { ...env, budgetMs })).rejects.toBeInstanceOf(
				RegistryVerificationError,
			);
			expect(env.fetch).not.toHaveBeenCalled();
		},
	);

	it("clamps the final sleep and never starts a probe at the deadline", async () => {
		const env = clocked(() => json({}, 404));
		await expect(verifyRegistryVisibility(config, { ...env, budgetMs: 3500 })).rejects.toMatchObject({
			pending: true,
		});
		expect(env.delays).toEqual([3500]);
		expect(env.now()).toBe(3500);
		expect(env.fetch).toHaveBeenCalledTimes(1);
	});

	it("exhausts the default 600-second budget with a bounded final pause and no late probe", async () => {
		const env = clocked(() => json({}, 404));
		await expect(verifyRegistryVisibility(config, env)).rejects.toMatchObject({ pending: true });
		expect(env.now()).toBe(600_000);
		expect(env.delays.at(-1)).toBe(25_000);
		expect(env.fetch).toHaveBeenCalledTimes(22);
	});

	it("does not admit a valid response that arrives at the deadline", async () => {
		const env = clocked(() => {
			env.advance(100);
			return json(metadata());
		});
		await expect(verifyRegistryVisibility(config, { ...env, budgetMs: 100 })).rejects.toMatchObject({
			pending: true,
		});
		expect(env.fetch).toHaveBeenCalledTimes(1);
	});

	it.each(["headers", "body"])("bounds stalled %s, cancels work and clears timers", async (where) => {
		vi.useFakeTimers();
		let canceled = 0;
		const fetch = vi.fn(() =>
			where === "headers"
				? new Promise<Response>(() => {})
				: Promise.resolve(
						new Response(
							new ReadableStream({
								cancel() {
									canceled++;
								},
							}),
						),
					),
		);
		const pending = verifyRegistryVisibility(config, {
			fetch,
			now: () => Date.now(),
			budgetMs: 100,
			requestTimeoutMs: 60,
		}).catch((error: Error) => error);
		await vi.advanceTimersByTimeAsync(100);
		expect(await pending).toMatchObject({ pending: true });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		if (where === "body") expect(canceled).toBe(1);
	});

	it("cancels a fetch that ignores abort and resolves late, without a late success or rejection", async () => {
		vi.useFakeTimers();
		let resolve!: (response: Response) => void;
		let canceled = 0;
		const pending = verifyRegistryVisibility(config, {
			fetch: () =>
				new Promise<Response>((done) => {
					resolve = done;
				}),
			now: () => Date.now(),
			budgetMs: 40,
		}).catch((error: Error) => error);
		await vi.advanceTimersByTimeAsync(40);
		expect(await pending).toMatchObject({ pending: true });
		resolve(
			new Response(
				new ReadableStream({
					cancel() {
						canceled++;
					},
				}),
			),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(canceled).toBe(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

function reportHarness() {
	const output: string[] = [],
		errors: string[] = [],
		summaries: string[] = [];
	const env = {
		PACKAGE: config.packageName,
		VERSION: config.version,
		EXPECTED_GIT_HEAD: config.commit,
		GITHUB_STEP_SUMMARY: join(mkTempDir("ink-release-guard-"), "summary.md"),
	};
	return {
		env,
		output,
		errors,
		summaries,
		io: {
			stdout: (text: string) => {
				output.push(text);
			},
			stderr: (text: string) => {
				errors.push(text);
			},
			appendSummary: (_path: string, text: string) => {
				summaries.push(text);
			},
		},
	};
}

describe("post-publication reporting and workflow boundaries", () => {
	it.each([true, false])(
		"summary write failure cannot mask primary verification outcome (success=%s)",
		async (success) => {
			const h = reportHarness();
			const code = await runRegistryVisibility(h.env, {
				...h.io,
				verify: async () => {
					if (!success) throw new RegistryVerificationError("verification timed out", true);
				},
				appendSummary: () => {
					throw new Error("PRIVATE_SUMMARY_PATH");
				},
			});
			expect(code).toBe(success ? 0 : 1);
			expect(h.errors.join("\n")).toContain("could not write");
			expect(h.errors.join("\n")).not.toContain("PRIVATE_SUMMARY_PATH");
			if (success) expect(h.output.join("\n")).toContain("Registry metadata verified");
			else expect(h.errors).toEqual(expect.arrayContaining([PUBLISH_NOTICE, "verification timed out"]));
		},
	);

	it("reports pending verification as nonzero, never a failed publish or unverified success", async () => {
		const h = reportHarness();
		expect(
			await runRegistryVisibility(h.env, {
				...h.io,
				verify: async () => {
					throw new RegistryVerificationError("timed out", true);
				},
			}),
		).toBe(1);
		expect(h.errors).toContain(PUBLISH_NOTICE);
		expect(h.summaries.join("")).toContain("Registry verification pending");
		expect(h.output).toEqual([]);
	});

	it("does not echo unexpected transport/reporting errors", async () => {
		const h = reportHarness();
		expect(
			await runRegistryVisibility(h.env, {
				...h.io,
				verify: async () => {
					throw new Error("PRIVATE_REMOTE_ERROR");
				},
			}),
		).toBe(1);
		expect(h.errors.join("\n")).not.toContain("PRIVATE_REMOTE_ERROR");
		expect(h.errors).toContain(PUBLISH_NOTICE);
	});

	it("reports success without claiming artifact/provenance cryptographic verification", async () => {
		const h = reportHarness();
		expect(await runRegistryVisibility(h.env, { ...h.io, verify: async () => {} })).toBe(0);
		expect(h.summaries.join("")).toContain("Registry metadata verified");
		expect(h.output.join("\n")).toContain("require separate");
	});

	it("invalid input invokes neither verifier nor summary writer and still warns against republication", async () => {
		const h = reportHarness();
		const verify = vi.fn();
		expect(
			await runRegistryVisibility({ ...h.env, VERSION: "PRIVATE_INVALID_VERSION" }, { ...h.io, verify }),
		).toBe(1);
		expect(verify).not.toHaveBeenCalled();
		expect(h.summaries).toEqual([]);
		expect(h.errors).toContain(PUBLISH_NOTICE);
		expect(h.errors.join("\n")).not.toContain("PRIVATE_INVALID_VERSION");
	});

	it("symlink CLI execution rejects invalid configuration before network/file writes", () => {
		const root = mkTempDir("ink-release-guard-");
		const link = join(root, "visibility.mjs"),
			summary = join(root, "summary.md"),
			network = join(root, "network.log");
		symlinkSync(script, link);
		writeFileSync(summary, "unchanged");
		const result = spawnSync(process.execPath, [link], {
			cwd: root,
			encoding: "utf8",
			timeout: 10_000,
			env: {
				PATH: "/usr/bin:/bin",
				PACKAGE: "wrong",
				GITHUB_STEP_SUMMARY: summary,
				NODE_OPTIONS: `--require ${JSON.stringify(NETWORK_PRELOAD)}`,
				INK_TEST_NETWORK_LOG: network,
			},
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(PUBLISH_NOTICE);
		expect(readFileSync(summary, "utf8")).toBe("unchanged");
		expect(existsSync(network)).toBe(false);
	});

	const workflow = parse(
		readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
	) as {
		jobs: { publish: { steps: { name?: string; run?: string; if?: string; "timeout-minutes"?: number }[] } };
	};
	const steps = workflow.jobs.publish.steps;
	const index = steps.findIndex((step) => step.name === "registry visibility check");
	const step = steps[index]!;
	it("keeps verification after real publication, out of dispatch and without publication retries", () => {
		expect(steps[index - 1]?.name).toBe("npm publish (real)");
		expect(step.if).toBe("github.event_name == 'push' && steps.plan.outputs.mode == 'publish'");
		expect(step["timeout-minutes"]).toBe(12);
		expect(step.run).toContain("node scripts/check-registry-visibility.mjs");
		expect(step.run).not.toMatch(/^\s*(?:npm (?:publish|view)|gh run rerun|continue-on-error)/m);
		expect(step).not.toHaveProperty("continue-on-error");
	});

	it.each([
		{ gitFails: true, summaryFails: false, nodeExit: 0 },
		{ gitFails: false, summaryFails: true, nodeExit: 0 },
		{ gitFails: true, summaryFails: true, nodeExit: 0 },
		{ gitFails: false, summaryFails: true, nodeExit: 7 },
	])(
		"setup failure=$gitFails, summary failure=$summaryFails, verifier exit=$nodeExit preserves acceptance and primary status",
		({ gitFails, summaryFails, nodeExit }) => {
			const root = mkTempDir("ink-release-guard-");
			const bin = join(root, "bin");
			mkdirSync(bin);
			const summary = join(root, "summary");
			if (summaryFails) mkdirSync(summary);
			else writeFileSync(summary, "");
			const called = join(root, "node-called");
			writeFileSync(
				join(bin, "git"),
				`#!/bin/bash\nif [[ "$1" != rev-parse || "$2" != 'refs/tags/v0.99.0^{commit}' ]]; then exit 24; fi\n${gitFails ? "exit 23" : `printf '%s\\n' '${config.commit}'`}\n`,
				{ mode: 0o755 },
			);
			writeFileSync(
				join(bin, "node"),
				`#!/bin/bash\nprintf '%s' "$EXPECTED_GIT_HEAD" > '${called}'\nexit ${nodeExit}\n`,
				{
					mode: 0o755,
				},
			);
			const result = spawnSync("/bin/bash", ["-e", "-c", step.run!], {
				cwd: root,
				encoding: "utf8",
				timeout: 10_000,
				env: {
					PATH: `${bin}:/usr/bin:/bin`,
					HOME: root,
					GITHUB_REF: "refs/tags/v0.99.0",
					GITHUB_STEP_SUMMARY: summary,
				},
			});
			expect(result.status).toBe(gitFails ? 23 : nodeExit);
			expect(result.stderr).toContain(PUBLISH_NOTICE);
			expect(existsSync(called)).toBe(!gitFails);
			if (!gitFails) expect(readFileSync(called, "utf8")).toBe(config.commit);
			if (summaryFails) expect(result.stderr).toContain("could not write publication summary");
			else expect(readFileSync(summary, "utf8")).toContain("npm publish returned success");
		},
	);
});
