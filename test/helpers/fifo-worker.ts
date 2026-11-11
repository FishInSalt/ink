// Test-only POSIX worker. Never import Vitest here: native FIFO requests live
// in this process, not in a Vitest pool worker or a shared worker_thread pool.
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { type AgentEvent, runAgentLoop } from "../../src/core/loop.js";
import type { AgentMessage } from "../../src/core/messages.js";
import { runSubagent } from "../../src/core/subagent.js";
import { createReadTool } from "../../src/core/tools/read.js";
import type { Tool } from "../../src/core/tools/types.js";
import type { LLMRequest } from "../../src/provider/types.js";
import { assistant, scriptedProvider } from "./fakes.js";
import type { FifoControl, FifoReport, FifoScenario } from "./fifo-fixture.js";

const [root, scenario, control] = process.argv.slice(2) as [string, FifoScenario, FifoControl | ""];
let orderlyDisconnect = false;
function disconnectNormally(): void {
	orderlyDisconnect = true;
	if (process.connected) process.disconnect();
}
function containOwnerLoss(): void {
	if (orderlyDisconnect) return;
	// Our detached spawn makes this still-live PID the owned group leader.
	// Never use an IPC-supplied target or async fs in an exhausted native pool.
	try {
		process.kill(-process.pid, "SIGKILL");
	} finally {
		// Bounded fallback only; signal failure cannot prove descendant cleanup.
		process.exit(70);
	}
}
if (control === "owner-startup-loss") {
	// Consume the event BEFORE registration: only the connected-state check
	// below can detect this deterministic startup/import-window fault.
	await new Promise<void>((resolve) => {
		process.once("disconnect", resolve);
		process.disconnect();
	});
}
process.once("disconnect", containOwnerLoss);
if (!process.connected) containOwnerLoss();

const report: FifoReport = {
	type: "verdict",
	ok: false,
	error: "",
	stopReason: "",
	results: [],
	running: [],
	settled: [],
	ends: [],
	executed: [],
	executeSettled: [],
	holders: [],
	witness: false,
	prefixBlocked: false,
	eofSent: false,
	readerDelayMs: 0,
};
const io: Promise<unknown>[] = [];
const events: AgentEvent[] = [];
let holderError = "";
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, error: string): Promise<void> {
	const deadline = Date.now() + 2500;
	while (!condition()) {
		if (holderError) throw new Error(holderError);
		if (Date.now() >= deadline) throw new Error(error);
		await pause(5);
	}
	if (holderError) throw new Error(holderError);
}
function send(message: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send || !process.connected) return reject(new Error("supervisor IPC disconnected"));
		process.send(message, (error) => (error ? reject(error) : resolve()));
	});
}
function observe<T>(promise: Promise<T>): Promise<T> {
	// A failing readiness witness must not turn an in-flight loop rejection
	// into an unhandled rejection. The supervisor owns final physical cleanup.
	void promise.catch(() => {});
	return promise;
}
const onEvent = (event: AgentEvent) => {
	events.push(event);
	if (event.type === "tool_running") report.running.push(event.toolCallId);
	if (event.type === "tool_settled") report.settled.push(event.result.toolCallId);
	if (event.type === "tool_end") report.ends.push(event.result.toolCallId);
};
function results(messages: AgentMessage[]) {
	return messages.flatMap((message) =>
		message.role === "toolResult"
			? message.results.map((result) => {
					if (typeof result.content !== "string") throw new Error("Expected text-only FIFO result");
					return { id: result.toolCallId, content: result.content, isError: result.isError };
				})
			: [],
	);
}

async function run(): Promise<void> {
	if (!root || !["overlap", "abort", "child"].includes(scenario))
		throw new Error("Invalid FIFO worker arguments");
	if (control === "malformed-ipc") {
		await send({ type: "verdict", ok: true, pgid: 1 });
		return;
	}
	if (control === "early-exit") {
		disconnectNormally();
		return;
	}
	const count = scenario === "abort" ? 5 : 1;
	for (let i = 1; i <= count; i++) {
		execFileSync("/usr/bin/mkfifo", [path.join(root, `gate${i}.fifo`)], { timeout: 1000 });
	}
	writeFileSync(path.join(root, "plain.txt"), "plain content\n");
	for (let i = 6; i <= 7; i++) writeFileSync(path.join(root, `f${i}.txt`), `file ${i}\n`);
	const holders = Array.from({ length: count }, (_, i) => {
		const child = spawn(
			process.execPath,
			[
				path.join(root, "holder.cjs"),
				path.join(root, `gate${i + 1}.fifo`),
				control === "holder-early-exit" ? "early" : "",
			],
			{ stdio: ["pipe", "pipe", "pipe"], env: process.env },
		);
		const state = {
			pid: child.pid!,
			ready: false,
			closed: false,
			code: null as number | null,
			signal: null as string | null,
		};
		report.holders.push(state);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(0, 65);
			if (output.length > 64 || !"ready\n".startsWith(output)) holderError ||= "malformed holder readiness";
			if (output === "ready\n") state.ready = true;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			holderError ||= `holder stderr: ${chunk.toString("utf8").slice(0, 512)}`;
		});
		child.once("error", (error) => {
			holderError ||= `holder spawn: ${error.message}`;
		});
		// An early holder exit can race a buffered command. Observe EPIPE instead
		// of crashing or allowing it to count as a successful release.
		child.stdin.on("error", (error) => {
			holderError ||= `holder stdin: ${error.message}`;
		});
		child.once("close", (code, signal) => {
			Object.assign(state, { closed: true, code, signal });
			if (!state.ready || code !== 0 || signal !== null)
				holderError ||= "holder exited before normal ready/close";
		});
		return child;
	});
	let proceed = false;
	process.on("message", (message: unknown) => {
		if (message && typeof message === "object" && "type" in message && message.type === "proceed")
			proceed = true;
		else holderError ||= "malformed supervisor IPC";
	});
	await send({ type: "holders", pids: report.holders.map((holder) => holder.pid) });
	// Faults also wait for external ownership verification before proceeding.
	await until(() => proceed, "supervisor did not verify holder ownership");
	if (control === "owner-before-open") {
		await send({ type: "owner-loss-ready", report });
		process.disconnect(); // Fault stimulus: do NOT mark this orderly.
		await new Promise<void>(() => {});
	}
	if (control === "holder-early-exit") holders[0]!.stdin.end("exit\n");
	if (control === "orphan") {
		// No reader exists: this holder remains blocked in open after worker exit.
		disconnectNormally();
		process.exit(23);
	}
	if (control === "watchdog") await new Promise<void>(() => {});

	const realRead = createReadTool({ cwd: root });
	const read: Tool = {
		...realRead,
		...(control === "serial" ? { concurrencySafe: false } : {}),
		async execute(args, signal) {
			const requested = String(args.path);
			const index = requested === "plain.txt" ? 2 : Number(/\d+/.exec(requested)?.[0]);
			const id = `${scenario === "child" ? "k" : "c"}${index}`;
			report.executed.push(id);
			if (control === "delayed-reader" && requested === "gate1.fifo") {
				const start = Date.now();
				await pause(450);
				report.readerDelayMs = Date.now() - start;
			}
			const actual = realRead.execute(args, signal);
			io.push(observe(actual));
			try {
				return await actual;
			} finally {
				report.executeSettled.push(id);
			}
		},
	};
	const closeGates = (command: "eof" | "data") => {
		report.eofSent = true;
		for (const holder of holders) holder.stdin.end(`${command}\n`);
	};
	const finalText = assistant([{ type: "text", text: "done" }]);
	const history: AgentMessage[] = [];
	const controller = new AbortController();
	let pending: Promise<unknown>;
	if (scenario === "child") {
		let probeRan = false;
		const probe: Tool = {
			name: "probe",
			description: "records execution before gate close",
			parameters: Type.Object({ message: Type.String() }),
			concurrencySafe: true,
			async execute(args) {
				probeRan = !report.eofSent;
				return { output: `probe:${String(args.message)}` };
			},
		};
		const childTurn = assistant(
			[
				{ type: "toolCall", id: "k1", name: "read", arguments: { path: "gate1.fifo" } },
				{ type: "toolCall", id: "k2", name: "probe", arguments: { message: "go" } },
			],
			"tool_use",
		);
		const requests: LLMRequest[] = [];
		pending = observe(
			runSubagent({
				provider: scriptedProvider([childTurn, finalText], requests),
				model: "m",
				system: "CHILD",
				tools: [read, probe],
				prompt: "run them",
				onEvent,
			}).then((outcome) => {
				report.stopReason = outcome.status;
				report.results = results(requests[1]?.messages ?? []);
			}),
		);
		await until(() => report.holders.every((h) => h.ready) && probeRan, "probe did not execute before EOF");
		if (control === "owner-paired-read") {
			await send({ type: "owner-loss-ready", report });
			process.disconnect(); // Fault stimulus: do NOT mark this orderly.
			await new Promise<void>(() => {});
		}
		report.witness = probeRan && !report.eofSent && report.executeSettled.length === 0;
		closeGates("eof");
	} else {
		const paths =
			scenario === "overlap"
				? ["gate1.fifo", "plain.txt"]
				: Array.from({ length: 7 }, (_, i) => (i < 5 ? `gate${i + 1}.fifo` : `f${i + 1}.txt`));
		const turn = assistant(
			paths.map((file, i) => ({
				type: "toolCall" as const,
				id: `c${i + 1}`,
				name: "read",
				arguments: { path: file },
			})),
			"tool_use",
		);
		pending = observe(
			runAgentLoop({
				provider: scriptedProvider([turn, finalText]),
				model: "m",
				system: "",
				tools: [read],
				history,
				userMessage: "go",
				onEvent,
				signal: controller.signal,
			}).then((outcome) => {
				report.stopReason = outcome.stopReason;
				report.results = results(history);
			}),
		);
		if (scenario === "overlap") {
			await until(
				() => report.holders.every((h) => h.ready) && report.settled.includes("c2"),
				"plain read did not settle before FIFO release",
			);
			report.prefixBlocked = !events.some((event) => event.type === "tool_end");
			report.witness = report.prefixBlocked && !report.executeSettled.includes("c1");
			closeGates("data");
		} else {
			await until(
				() => report.executed.length === 5 && report.running.length === 5,
				"five FIFO reads not admitted",
			);
			controller.abort();
			// Queue EOF immediately after abort, without waiting for readiness.
			// OS opens may already have paired, or some may still be pending;
			// holders consume this command only after their actual open succeeds.
			report.witness = report.executed.length === 5 && report.executeSettled.length === 0;
			closeGates("eof");
		}
	}
	await pending;
	await Promise.all(io);
	await until(
		() => report.holders.every((holder) => holder.ready && holder.closed),
		"holders did not close normally",
	);
	if (holderError) throw new Error(holderError);
	report.ok = true;
}

try {
	await run();
	if (control !== "malformed-ipc" && control !== "early-exit") await send(report);
} catch (error) {
	report.error = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
	await send(report).catch(() => {});
	process.exitCode = 1;
} finally {
	// Pending failure I/O must retain owner-loss protection until the live
	// supervisor contains the group. Only drained success/no-I/O controls
	// disconnect intentionally; unexpected owner loss remains self-contained.
	if (report.ok || control === "malformed-ipc" || control === "early-exit") disconnectNormally();
}
