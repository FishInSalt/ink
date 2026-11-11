import { execFile, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { onTestFinished } from "vitest";
import { NETWORK_PRELOAD } from "./cli-fixture.js";

export type FifoScenario = "overlap" | "abort" | "child";
export type FifoControl =
	| "delayed-reader"
	| "serial"
	| "holder-early-exit"
	| "orphan"
	| "watchdog"
	| "malformed-ipc"
	| "early-exit"
	| "spawn-error";
export interface FifoReport {
	type: "verdict";
	ok: boolean;
	error: string;
	stopReason: string;
	results: { id: string; content: string; isError: boolean }[];
	running: string[];
	settled: string[];
	ends: string[];
	executed: string[];
	executeSettled: string[];
	holders: { pid: number; ready: boolean; closed: boolean; code: number | null; signal: string | null }[];
	witness: boolean;
	prefixBlocked: boolean;
	eofSent: boolean;
	readerDelayMs: number;
}
interface GroupMember {
	pid: number;
	ppid: number;
	pgid: number;
	stat: string;
}
export interface FifoOutcome {
	ok: boolean;
	failure: string;
	blockedNetwork: string;
	root: string;
	pgid: number | undefined;
	report: FifoReport | undefined;
	stdout: string;
	stderr: string;
	ownership: GroupMember[];
	holderPids: number[];
	cleanup: {
		conclusive: boolean;
		directClosed: boolean;
		code: number | null;
		signal: NodeJS.Signals | null;
		before: GroupMember[];
		remaining: GroupMember[];
		zombies: GroupMember[];
		error: string;
	};
}

const MAX_OUTPUT = 16 * 1024;
const MAX_IPC = 32 * 1024;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pid = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 1;
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const ids = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.length <= 7 &&
	value.every((id) => typeof id === "string" && /^[ck][1-7]$/.test(id));

/** IPC is evidence only. In particular no message can choose a signal target. */
function isReport(value: unknown): value is FifoReport {
	if (!record(value) || value.type !== "verdict") return false;
	return (
		typeof value.ok === "boolean" &&
		typeof value.error === "string" &&
		typeof value.stopReason === "string" &&
		["witness", "prefixBlocked", "eofSent"].every((key) => typeof value[key] === "boolean") &&
		typeof value.readerDelayMs === "number" &&
		Number.isFinite(value.readerDelayMs) &&
		["running", "settled", "ends", "executed", "executeSettled"].every((key) => ids(value[key])) &&
		Array.isArray(value.results) &&
		value.results.length <= 7 &&
		value.results.every(
			(result) =>
				record(result) &&
				ids([result.id]) &&
				typeof result.content === "string" &&
				typeof result.isError === "boolean",
		) &&
		Array.isArray(value.holders) &&
		value.holders.length <= 5 &&
		value.holders.every(
			(holder) =>
				record(holder) &&
				pid(holder.pid) &&
				typeof holder.ready === "boolean" &&
				typeof holder.closed === "boolean" &&
				(holder.code === null || Number.isInteger(holder.code)) &&
				(holder.signal === null || typeof holder.signal === "string"),
		)
	);
}

/** External, bounded audit: never queues filesystem work in the FIFO worker. */
function auditGroup(pgid: number, deadline: number): Promise<GroupMember[]> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return Promise.reject(new Error("group audit deadline expired"));
	return new Promise((resolve, reject) => {
		execFile(
			"/bin/ps",
			["-axo", "pid=,ppid=,pgid=,stat="],
			{
				timeout: Math.min(500, remaining),
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
				env: { PATH: "/usr/bin:/bin" },
			},
			(error, stdout) => {
				if (error) return reject(error);
				const members: GroupMember[] = [];
				for (const line of stdout.trim().split("\n")) {
					const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
					if (!match) return reject(new Error(`Malformed ps row: ${line}`));
					if (Number(match[3]) === pgid) {
						members.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid, stat: match[4]! });
					}
				}
				resolve(members);
			},
		);
	});
}

// The blocking open is external to libuv. stdin is intentionally consumed only
// AFTER open + ready: an already-buffered EOF command cannot unpair a queued open.
const HOLDER_SCRIPT = `const fs = require("node:fs");
// Fault-only: wait for supervisor ownership verification, then exit pre-open.
if (process.argv[3] === "early") { fs.readFileSync(0); process.exit(17); }
const fd = fs.openSync(process.argv[2], "w");
fs.writeSync(1, "ready\\n");
const command = fs.readFileSync(0, "utf8");
if (command === "data\\n") fs.writeSync(fd, "fifo content\\n");
else if (command !== "eof\\n") process.exitCode = 18;
fs.closeSync(fd);
`;

/** Expected scenario failures must never exempt the finishing hook's network guard. */
export function assertNoFifoBlockedNetwork(outcome: Pick<FifoOutcome, "failure" | "blockedNetwork">): void {
	if (outcome.blockedNetwork !== "") {
		throw new Error(
			`FIFO blocked-network evidence (scenario: ${outcome.failure || "none"}):\n${outcome.blockedNetwork}`,
		);
	}
}

/** Owns one detached process group and its paths. No caller-supplied PGID API. */
export async function runFifoFixture(
	scenario: FifoScenario,
	options: { control?: FifoControl; watchdogMs?: number } = {},
): Promise<FifoOutcome> {
	if (process.platform === "win32") throw new Error("FIFO fixtures require POSIX process groups");
	const watchdogMs = options.watchdogMs ?? 10_000;
	if (!(watchdogMs > 0 && watchdogMs <= 10_000)) throw new Error("Invalid FIFO watchdog budget");
	const bodyDeadline = Date.now() + watchdogMs;
	const prefix = { overlap: "ink-parallel-", abort: "ink-abort-", child: "ink-child-" }[scenario];
	// Not mkTempDir: inconclusive cleanup MUST retain the FIFO paths.
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
	for (const name of ["home", "tmp", "cache", "config", "data", "state"]) mkdirSync(path.join(root, name));
	writeFileSync(path.join(root, "holder.cjs"), HOLDER_SCRIPT);
	const env: NodeJS.ProcessEnv = {
		PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
		HOME: path.join(root, "home"),
		TMPDIR: path.join(root, "tmp"),
		XDG_CACHE_HOME: path.join(root, "cache"),
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_STATE_HOME: path.join(root, "state"),
		INK_AUTH_PATH: path.join(root, "auth.json"),
		INK_SETTINGS_PATH: path.join(root, "settings.json"),
		INK_CATALOG_PATH: path.join(root, "catalog.json"),
		INK_CATALOG_BASE_URL: "http://127.0.0.1:1",
		INK_TEST_NETWORK_LOG: path.join(root, "blocked-network.log"),
		NODE_OPTIONS: `--require ${JSON.stringify(NETWORK_PRELOAD)}`,
		NO_COLOR: "1",
	};
	const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
	const child = spawn(
		options.control === "spawn-error" ? path.join(root, "missing-node") : process.execPath,
		[
			"--import",
			loader,
			path.join(import.meta.dirname, "fifo-worker.ts"),
			root,
			scenario,
			options.control ?? "",
		],
		{ cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
	);
	// Captured exclusively from our own detached spawn, never from worker IPC.
	const pgid = child.pid;
	const outcome: FifoOutcome = {
		ok: false,
		failure: "",
		blockedNetwork: "",
		root,
		pgid,
		report: undefined,
		stdout: "",
		stderr: "",
		ownership: [],
		holderPids: [],
		cleanup: {
			conclusive: false,
			directClosed: false,
			code: null,
			signal: null,
			before: [],
			remaining: [],
			zombies: [],
			error: "",
		},
	};
	let finish!: () => void;
	const body = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const fail = (reason: string) => {
		outcome.failure ||= reason;
		finish();
	};
	child.once("error", (error) => fail(`worker spawn/error: ${error.message}`));
	child.once("close", (code, signal) => {
		Object.assign(outcome.cleanup, { directClosed: true, code, signal });
		if (!outcome.report) fail("worker exited without verdict");
		else if (code !== 0 || signal !== null) fail(`worker exited abnormally: ${code}/${signal}`);
		finish();
	});
	for (const stream of ["stdout", "stderr"] as const) {
		child[stream]!.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			if (outcome[stream].length + text.length > MAX_OUTPUT) fail(`worker ${stream} exceeded output cap`);
			outcome[stream] = (outcome[stream] + text).slice(0, MAX_OUTPUT);
		});
	}
	let holderPids: number[] | undefined;
	let ownershipVerified = false;
	child.on("message", (message: unknown) => {
		if (JSON.stringify(message).length > MAX_IPC) return fail("oversized worker IPC");
		if (record(message) && message.type === "holders" && !holderPids && !outcome.report) {
			const list = message.pids;
			if (
				!Array.isArray(list) ||
				list.length !== (scenario === "abort" ? 5 : 1) ||
				!list.every(pid) ||
				new Set(list).size !== list.length ||
				!pgid ||
				list.includes(pgid)
			)
				return fail("malformed holder IPC");
			holderPids = list;
			outcome.holderPids = list;
			void auditGroup(pgid, Date.now() + 1000).then(
				(members) => {
					outcome.ownership = members;
					if (
						!members.some((member) => member.pid === pgid) ||
						!list.every((id) => members.some((member) => member.pid === id && member.ppid === pgid))
					) {
						return fail("worker/holder not observed in owned process group");
					}
					ownershipVerified = true;
					if (child.connected)
						child.send({ type: "proceed" }, (error) => {
							if (error) fail(`worker IPC send: ${error.message}`);
						});
				},
				(error: Error) => fail(`ownership audit: ${error.message}`),
			);
			return;
		}
		if (!isReport(message) || outcome.report) return fail("malformed worker IPC");
		outcome.report = message;
		if (!message.ok) return fail(message.error || "worker failure verdict");
		if (
			!ownershipVerified ||
			!holderPids ||
			message.holders.length !== holderPids.length ||
			!message.holders.every(
				(holder, i) =>
					holder.pid === holderPids?.[i] &&
					holder.ready &&
					holder.closed &&
					holder.code === 0 &&
					holder.signal === null,
			) ||
			!message.witness ||
			!message.eofSent ||
			message.executed.length === 0 ||
			new Set(message.executed).size !== message.executed.length ||
			[...message.executed].sort().join() !== [...message.executeSettled].sort().join()
		)
			fail("incomplete worker success evidence");
		// Even a valid verdict must wait for the direct worker's normal close.
	});
	const watchdog = setTimeout(
		() => fail(`FIFO scenario watchdog expired (${watchdogMs}ms)`),
		Math.max(0, bodyDeadline - Date.now()),
	);

	const collectBlockedNetwork = () => {
		const log = path.join(root, "blocked-network.log");
		const evidence = existsSync(log) ? readFileSync(log, "utf8") : "";
		if (evidence !== "" && !outcome.blockedNetwork.includes(evidence)) {
			outcome.blockedNetwork += evidence;
			fail("FIFO fixture recorded blocked-network evidence");
		}
	};
	let cleanupPending: Promise<void> | undefined;
	let groupAbsent = false;
	const cleanup = (): Promise<void> => {
		if (outcome.cleanup.conclusive) return Promise.resolve();
		if (cleanupPending) return cleanupPending;
		cleanupPending = (async () => {
			const deadline = Date.now() + 2000;
			try {
				let members: GroupMember[] | undefined;
				let auditError = "";
				try {
					members = pgid ? await auditGroup(pgid, deadline) : [];
				} catch (error) {
					auditError = String(error);
					fail(`initial FIFO group audit failed: ${auditError}`);
				}
				outcome.cleanup.before = members ?? [];
				// A normal worker close can precede tsx/esbuild's natural exit.
				// Give it a brief audit-only interval, inside the SAME 2s budget;
				// failure paths still proceed directly to group containment.
				const naturalDeadline = Math.min(deadline, Date.now() + 250);
				while (members?.length && !outcome.failure && Date.now() < naturalDeadline) {
					await pause(Math.min(20, naturalDeadline - Date.now()));
					try {
						members = pgid ? await auditGroup(pgid, naturalDeadline) : [];
					} catch (error) {
						members = undefined;
						auditError = String(error);
						fail(`natural-exit FIFO group audit failed: ${auditError}`);
					}
				}
				if (members?.length === 0) groupAbsent = true;
				// Success demands an EMPTY group. Failure permits only dead zombies.
				if (members?.length && !outcome.failure) fail("process group not empty after normal worker close");
				// An audit error must not prevent containment. Signal our captured
				// PGID once unless absence/death has already been established.
				if (pgid && !groupAbsent && (!members || members.some((m) => !m.stat.startsWith("Z")))) {
					try {
						process.kill(-pgid, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				}
				while (true) {
					if (members) {
						if (members.length === 0) groupAbsent = true;
						outcome.cleanup.remaining = members.filter((m) => !m.stat.startsWith("Z"));
						for (const zombie of members.filter((m) => m.stat.startsWith("Z"))) {
							if (!outcome.cleanup.zombies.some((m) => m.pid === zombie.pid))
								outcome.cleanup.zombies.push(zombie);
						}
						if (outcome.cleanup.directClosed && outcome.cleanup.remaining.length === 0) break;
					}
					if (Date.now() >= deadline)
						throw new Error(`direct close/live group cleanup deadline expired: ${auditError}`);
					await pause(Math.min(20, Math.max(1, deadline - Date.now())));
					try {
						members = pgid ? await auditGroup(pgid, deadline) : [];
					} catch (error) {
						members = undefined;
						auditError = String(error);
					}
				}
				collectBlockedNetwork();
				rmSync(root, { recursive: true, force: true });
				outcome.cleanup.conclusive = true;
				outcome.cleanup.error = "";
			} catch (error) {
				outcome.cleanup.error = String(error);
				fail(`inconclusive FIFO cleanup; retained ${root}: ${String(error)}`);
			} finally {
				cleanupPending = undefined;
				// Also preserve evidence on inconclusive cleanup, so the finishing
				// hook cannot lose it if a later fallback removes the fixture root.
				collectBlockedNetwork();
			}
		})();
		return cleanupPending;
	};
	// Unexpected assertion/test failure repeats ONLY the bounded ownership-aware
	// cleanup, never an unconditional recursive removal of these FIFO paths.
	onTestFinished(async () => {
		try {
			await cleanup();
		} finally {
			assertNoFifoBlockedNetwork(outcome);
		}
		if (!outcome.cleanup.conclusive) {
			throw new Error(
				`FIFO cleanup inconclusive; retained ${root}: ${outcome.cleanup.error}; scenario: ${outcome.failure}`,
			);
		}
	});
	await body;
	clearTimeout(watchdog);
	await cleanup();
	outcome.ok = outcome.failure === "" && outcome.blockedNetwork === "" && outcome.cleanup.conclusive;
	return outcome;
}
