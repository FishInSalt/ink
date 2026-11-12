import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createVitest, type TestRunEndReason, type TestRunResult, type Vitest } from "vitest/node";

const [directory, scenario, variant] = process.argv.slice(2);
if (
	!directory ||
	!["cancel-first", "cancel-rerun"].includes(scenario ?? "") ||
	!["missing", "empty"].includes(variant ?? "")
)
	throw new Error("watch bootstrap driver requires <directory> <cancel-first|cancel-rerun> <variant>");
const repo = path.resolve(import.meta.dirname, "../..");
const keys = ["TMPDIR", "TMP", "TEMP"] as const;
const snapshot = () =>
	keys.map((key) => ({ key, present: Object.hasOwn(process.env, key), value: process.env[key] ?? null }));
const original = snapshot();
const originalExitCode = process.exitCode;

async function bounded<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`watch bootstrap ${label} timeout (${ms}ms)`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function main(directory: string): Promise<void> {
	let runner: Vitest | undefined;
	let reason: TestRunEndReason | undefined;
	const rounds: unknown[] = [];
	let originalConfig!: NodeJS.ProcessEnv;
	let project!: ReturnType<Vitest["getRootProject"]>;
	let root = "";
	try {
		runner = await createVitest(
			"test",
			{
				root: repo,
				config: false,
				watch: true,
				maxWorkers: 1,
				fileParallelism: false,
				cache: false,
				include: ["test/fixtures/bootstrap-probe.case.ts"],
				globalSetup: [path.join(repo, "test/helpers/global-setup.ts")],
				setupFiles: [path.join(repo, "test/helpers/settings-setup.ts")],
				testTimeout: 15_000,
				teardownTimeout: 2000,
				reporters: [
					{
						onTestRunEnd(_modules, _errors, value) {
							reason = value;
						},
					},
				],
			},
			{ cacheDir: path.join(repo, ".vitest-cache"), server: { watch: { ignored: ["**/*"] } } },
		);
		await runner.standalone();
		project = runner.getRootProject();
		originalConfig = { ...project.config.env, WATCH_BOOTSTRAP_KEEP: "unchanged" };
		for (const key of keys) {
			if (variant === "missing") delete originalConfig[key];
			else originalConfig[key] = "";
		}
		Object.freeze(originalConfig);
		project.config.env = originalConfig;
		const specifications = await runner.globTestSpecifications();
		assert.equal(specifications.length, 1);
		assert.deepEqual(snapshot(), original);
		for (let round = 1; round <= 3; round++) {
			const report = path.join(directory, `round-${round}.json`);
			const ready = path.join(directory, `ready-${round}`);
			const release = path.join(directory, `release-${round}`);
			project.provide("bootstrapReport", report);
			project.provide("bootstrapControl", { ready, release });
			reason = undefined;
			let finished = false;
			const run: Promise<TestRunResult> = (
				round === 1
					? runner.runTestSpecifications(specifications)
					: runner.rerunTestSpecifications(specifications)
			).finally(() => {
				finished = true;
			});
			// Attach immediately: an early runner failure must not be unhandled
			// while the driver is waiting for the worker's readiness evidence.
			void run.catch(() => {});
			const deadline = Date.now() + 10_000;
			while (!existsSync(ready)) {
				if (finished) {
					const result = await run;
					throw new Error(
						`probe ended before ready: ${JSON.stringify(result.unhandledErrors)}; reason=${reason}`,
					);
				}
				if (Date.now() >= deadline) throw new Error(`watch bootstrap ready timeout: ${ready}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const cancel = scenario === "cancel-first" ? round === 1 : round === 2;
			const cancellation: Promise<void> = cancel
				? runner.cancelCurrentRun("keyboard-input")
				: Promise.resolve();
			writeFileSync(release, "");
			const result: TestRunResult = (
				await bounded(Promise.all([run, cancellation]), 10_000, `round ${round}`)
			)[0];
			assert.deepEqual(result.unhandledErrors, []);
			assert.equal(result.testModules.length, 1);
			assert.equal(result.testModules[0]!.state(), "passed");
			assert.equal(reason, cancel ? "interrupted" : "passed");
			// Vitest intentionally sets exitCode=1 for an interrupted run. Only
			// clear that expected outcome after checking all worker/error results.
			assert.equal(process.exitCode, cancel ? 1 : originalExitCode);
			if (cancel) process.exitCode = originalExitCode;
			const probe = JSON.parse(readFileSync(report, "utf8"));
			root ||= probe.root;
			assert.equal(probe.root, root);
			for (const key of keys) assert.equal(project.config.env[key], root);
			assert.deepEqual(snapshot(), original);
			rounds.push({ round, reason, probe, coordinator: snapshot() });
		}
	} finally {
		if (runner) await bounded(runner.close(), 5000, "close");
	}
	assert.strictEqual(project.config.env, originalConfig);
	assert.deepEqual(snapshot(), original);
	assert.equal(readFileSync(path.join(root, "bootstrap-diagnostic"), "utf8"), "retained evidence");
	writeFileSync(
		path.join(directory, "result.json"),
		JSON.stringify({ original, restored: snapshot(), configRestored: true, rounds }),
	);
}

main(directory).catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
