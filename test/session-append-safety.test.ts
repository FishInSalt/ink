import * as fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/core/messages.js";
import { SessionStore, summaryToMessage } from "../src/core/session/store.js";
import { mkTempDir } from "./helpers/mktemp.js";

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		appendFileSync: vi.fn(actual.appendFileSync),
		truncateSync: vi.fn(actual.truncateSync),
		readFileSync: vi.fn(actual.readFileSync),
	};
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
beforeEach(() => {
	vi.mocked(fs.appendFileSync).mockReset().mockImplementation(actual.appendFileSync);
	vi.mocked(fs.truncateSync).mockReset().mockImplementation(actual.truncateSync);
	vi.mocked(fs.readFileSync).mockReset().mockImplementation(actual.readFileSync);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const user = (content: string): AgentMessage => ({ role: "user", content });
const model = { provider: "zai", modelId: "test-model" };
const call: AgentMessage = {
	role: "assistant",
	blocks: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "inspect" } }],
	usage: { inputTokens: 10, outputTokens: 5 },
	stopReason: "tool_use",
};
const result: AgentMessage = {
	role: "toolResult",
	results: [{ toolCallId: "call-1", toolName: "bash", content: "中断后的结果未知 🔧", isError: true }],
};
const usage = { inputTokens: 3, outputTokens: 1 };

function fresh(): SessionStore {
	return SessionStore.create(
		path.join(mkTempDir("ink-session-append-safety-"), "s.jsonl"),
		"/project/多字节/🔧",
		"append-safety",
	);
}

function failureOf(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("expected an operation to fail");
}

const failureModes = ["zero", "partial", "full without newline", "full with newline"] as const;
type FailureMode = (typeof failureModes)[number];
function failedBytes(data: string | Uint8Array, mode: FailureMode): Buffer {
	const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
	if (mode === "zero") return bytes.subarray(0, 0);
	if (mode === "partial") {
		const cjk = bytes.indexOf(Buffer.from("中"));
		// Cut inside a three-byte character when present, not merely between
		// JSON fields. Position markers instead exercise a partial ASCII record.
		return bytes.subarray(0, cjk >= 0 ? cjk + 1 : Math.floor(bytes.length / 2));
	}
	return mode === "full without newline" ? bytes.subarray(0, -1) : bytes;
}
const accepted = (mode: FailureMode) => mode.startsWith("full");

function expectWriteRefusal(store: SessionStore): void {
	const bytes = actual.readFileSync(store.filePath);
	const entries = [...store.getEntries()];
	const leaf = store.getLeafId();
	const context = store.buildContext();
	const reads = vi.mocked(fs.readFileSync).mock.calls.length;
	const appends = vi.mocked(fs.appendFileSync).mock.calls.length;
	const truncates = vi.mocked(fs.truncateSync).mock.calls.length;
	const firstUser = store.userForkPoints()[0]!.id;
	for (const action of [
		() => store.assertWritable(),
		() => store.appendMessage(user("must not append")),
		() => store.appendSessionName("must not rename"),
		() => store.appendThinkingLevelChange("high"),
		() => store.appendLabelChange(firstUser, "must not label"),
		() => store.appendCompaction("must not compact", [], 10),
		() => store.appendBranchSummary("must not summarize", usage),
		() => store.appendSummaryUsage(usage),
		() => store.seedModel(model),
		() => store.setModel(model),
		() => store.forkBefore(firstUser),
		() => store.branchTo(null),
		() => store.repairTornFinalLine(),
	]) {
		expect(action).toThrow(`reopen with /resume ${store.header.id} or restart before continuing`);
	}
	expect(actual.readFileSync(store.filePath)).toEqual(bytes);
	expect(store.getEntries()).toEqual(entries);
	expect(store.getLeafId()).toBe(leaf);
	expect(store.buildContext()).toEqual(context);
	expect(fs.readFileSync).toHaveBeenCalledTimes(reads);
	expect(fs.appendFileSync).toHaveBeenCalledTimes(appends);
	expect(fs.truncateSync).toHaveBeenCalledTimes(truncates);
}

describe("existing SessionStore write failures", () => {
	it.each(failureModes)("reconciles a %s tool-result append only after reopen", (mode) => {
		const store = fresh();
		store.seedModel(model);
		store.appendMessage(user("原始任务 🔧"));
		store.appendMessage(call);
		const prefix = actual.readFileSync(store.filePath);
		const leaf = store.getLeafId();
		const error = Object.assign(new Error("tool-result append failed"), { code: "ENOSPC" });
		let written: Buffer = Buffer.alloc(0);
		vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data) => {
			written = failedBytes(data, mode);
			actual.appendFileSync(file, written);
			throw error;
		});
		expect(failureOf(() => store.appendMessage(result))).toBe(error);
		expect(actual.readFileSync(store.filePath)).toEqual(Buffer.concat([prefix, written]));
		if (mode === "partial") {
			expect(() => new TextDecoder("utf8", { fatal: true }).decode(written)).toThrow();
		}
		expect(store.getEntries()).toHaveLength(2);
		expect(store.getLeafId()).toBe(leaf);
		expect(store.isPersisted).toBe(true);
		expectWriteRefusal(store);

		const reopened = SessionStore.open(store.filePath);
		expect(() => reopened.assertWritable()).not.toThrow();
		expect(reopened.getEntries()).toHaveLength(accepted(mode) ? 3 : 2);
		expect(reopened.tornFinalLine).toBe(mode === "partial" || mode === "full without newline");
		if (!accepted(mode)) reopened.appendMessage(result);
		reopened.appendSessionName("reconciled"); // also terminates a complete failed record lacking its newline
		const again = SessionStore.open(store.filePath);
		expect(again.buildContext().messages).toEqual([user("原始任务 🔧"), call, result]);
		expect(
			again.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "toolResult"),
		).toHaveLength(1);
		expect(again.tornFinalLine).toBe(false);
		expect(() => store.assertWritable()).toThrow(/reopen with \/resume/);
	});

	it.each(failureModes)("reconciles a %s explicit model append only after reopen", (mode) => {
		const store = fresh();
		store.seedModel(model);
		const leaf = store.appendMessage(user("kept"));
		const next = { ...model, modelId: "中文-model" };
		const error = new Error("model append failed");
		vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data) => {
			actual.appendFileSync(file, failedBytes(data, mode));
			throw error;
		});
		expect(failureOf(() => store.setModel(next))).toBe(error);
		expect(store.getModel()).toEqual(model);
		expect(store.hasModelSelection).toBe(false);
		expect(store.getLeafId()).toBe(leaf);
		expectWriteRefusal(store);
		const reopened = SessionStore.open(store.filePath);
		expect(reopened.getModel()).toEqual(accepted(mode) ? next : model);
		expect(reopened.hasModelSelection).toBe(accepted(mode));
		reopened.setModel(next);
		reopened.appendSessionName("after reopen");
		expect(SessionStore.open(store.filePath).getModel()).toEqual(next);
		const records = actual
			.readFileSync(store.filePath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records.filter((record) => record.type === "session_model")).toEqual([
			{ type: "session_model", ...next, explicit: true },
		]);
	});

	it.each(failureModes)("refuses a secondary receipt after a %s summary append", (mode) => {
		const store = fresh();
		const destination = store.appendMessage(user("destination"));
		store.appendMessage(user("abandoned branch"));
		store.branchTo(destination);
		const error = new Error("summary installation failed");
		vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data) => {
			actual.appendFileSync(file, failedBytes(data, mode));
			throw error;
		});
		expect(failureOf(() => store.appendBranchSummary("中断的摘要", usage))).toBe(error);
		expect(store.getLeafId()).toBe(destination);
		expect(store.buildContext().messages).toEqual([user("destination")]);
		expectWriteRefusal(store); // includes the accounting-only receipt path
		const reopened = SessionStore.open(store.filePath);
		const summaries = reopened.getEntries().filter((entry) => entry.type === "branchSummary");
		expect(summaries).toHaveLength(accepted(mode) ? 1 : 0);
		if (accepted(mode)) expect(summaries[0]?.usage).toEqual(usage);
		expect(reopened.getEntries().some((entry) => entry.type === "summaryUsage")).toBe(false);
		expect(reopened.getLeafId()).toBe(accepted(mode) ? summaries[0]?.id : destination);
		expect(reopened.getEntries()[1]).toMatchObject({ message: user("abandoned branch") });
	});

	it.each(["branch", "fork"] as const)("persists a proposed %s position before memory", (operation) => {
		for (const mode of failureModes) {
			const store = fresh();
			const destination = store.appendMessage(user("first"));
			const forkTarget = store.appendMessage(user("second"));
			store.appendMessage(user("third"));
			const leaf = store.getLeafId();
			const context = store.buildContext();
			const prefix = actual.readFileSync(store.filePath);
			const error = new Error(`${operation} position append failed: ${mode}`);
			let written: Buffer = Buffer.alloc(0);
			vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data) => {
				expect(store.getLeafId()).toBe(leaf);
				expect(JSON.parse(data as string)).toEqual({ type: "position", leafId: destination });
				written = failedBytes(data, mode);
				actual.appendFileSync(file, written);
				throw error;
			});
			expect(
				failureOf(() =>
					operation === "branch" ? store.branchTo(destination) : store.forkBefore(forkTarget),
				),
			).toBe(error);
			expect(store.getLeafId()).toBe(leaf);
			expect(store.buildContext()).toEqual(context);
			expect(actual.readFileSync(store.filePath)).toEqual(Buffer.concat([prefix, written]));
			expectWriteRefusal(store);
			const reopened = SessionStore.open(store.filePath);
			expect(reopened.getLeafId()).toBe(accepted(mode) ? destination : leaf);
			reopened.appendSessionName("after reopen");
			expect(SessionStore.open(store.filePath).getBranch()).toEqual(reopened.getBranch());
		}
	});

	it("assertWritable performs no I/O or branch walk, and ordinary writes do not read or repair", () => {
		const store = fresh();
		store.assertWritable();
		const first = store.appendMessage(user("first"));
		const reopened = SessionStore.open(store.filePath);
		const repair = vi.spyOn(reopened, "repairTornFinalLine");
		const branch = vi.spyOn(reopened, "getBranch").mockImplementation(() => {
			throw new Error("assertWritable must not walk history");
		});
		vi.mocked(fs.readFileSync).mockClear();
		for (let i = 0; i < 20; i++) reopened.assertWritable();
		expect(branch).not.toHaveBeenCalled();
		branch.mockRestore();
		reopened.setModel(model);
		reopened.appendSessionName("name");
		reopened.appendThinkingLevelChange("high");
		reopened.appendMessage(user("second"));
		reopened.forkBefore(first);
		reopened.appendSummaryUsage(usage);
		expect(fs.readFileSync).not.toHaveBeenCalled();
		expect(repair).not.toHaveBeenCalled();
	});
});

const tornVariants = [
	"complete CJK message",
	"partial CJK record",
	"invalid newline record",
	"complete model",
	"complete position",
	"header only",
] as const;
describe.each(["model", "name", "thinking", "position"] as const)(
	"torn tail before early %s write",
	(operation) => {
		it.each(tornVariants)("repairs %s once, preserving accepted bytes and cached entries", (variant) => {
			const original = fresh();
			const first = original.appendMessage(user("第一条消息 🔧"));
			original.appendMessage(user("第二条消息"));
			const intact = actual.readFileSync(original.filePath);
			let safePrefix = intact;
			if (variant === "complete CJK message") {
				actual.writeFileSync(original.filePath, intact.subarray(0, -1));
			} else if (variant === "partial CJK record") {
				actual.appendFileSync(
					original.filePath,
					failedBytes('{"type":"message","content":"中文"}\n', "partial"),
				);
			} else if (variant === "invalid newline record") {
				actual.appendFileSync(original.filePath, '{"type":"message","id":"invalid"}\n');
			} else if (variant === "complete model" || variant === "complete position") {
				const record = JSON.stringify(
					variant === "complete model"
						? { type: "session_model", provider: "openai", modelId: "previous", explicit: true }
						: { type: "position", leafId: first },
				);
				actual.appendFileSync(original.filePath, record);
				safePrefix = Buffer.concat([intact, Buffer.from(`${record}\n`)]);
			} else {
				const header = JSON.stringify(original.header);
				actual.writeFileSync(original.filePath, header);
				safePrefix = Buffer.from(`${header}\n`);
			}

			const store = SessionStore.open(original.filePath);
			const before = actual.readFileSync(store.filePath);
			const entries = [...store.getEntries()];
			const leaf = store.getLeafId();
			expect(store.tornFinalLine).toBe(true);
			store.assertWritable();
			store.buildContext();
			expect(actual.readFileSync(store.filePath)).toEqual(before); // opening/preflight stays read-only
			const repair = vi.spyOn(store, "repairTornFinalLine");
			vi.mocked(fs.readFileSync).mockClear();
			if (operation === "model") store.setModel(model);
			else if (operation === "name") store.appendSessionName("new name");
			else if (operation === "thinking") store.appendThinkingLevelChange("high");
			else store.branchTo(null);
			expect(store.tornFinalLine).toBe(false);
			expect(repair).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync).toHaveBeenCalledTimes(1);
			expect(store.getEntries().slice(0, entries.length)).toEqual(entries);
			if (operation === "model") expect(store.getLeafId()).toBe(leaf);
			else if (operation === "position") expect(store.getLeafId()).toBeNull();
			else expect(store.getEntry(store.getLeafId()!)?.parentId).toBe(leaf);
			store.appendMessage(user("next"));
			expect(repair).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync).toHaveBeenCalledTimes(1);
			expect(actual.readFileSync(store.filePath).subarray(0, safePrefix.length)).toEqual(safePrefix);
			const reopened = SessionStore.open(store.filePath);
			expect(reopened.getEntries()).toEqual(store.getEntries());
			expect(reopened.getLeafId()).toBe(store.getLeafId());
			expect(reopened.getModel()).toEqual(store.getModel());
			expect(reopened.buildContext()).toEqual(store.buildContext());
		});
	},
);

describe.each(["truncate", "terminate"] as const)("torn-tail %s failure", (repairKind) => {
	it.each(["before", "after"] as const)("invalidates on a failure %s the actual repair write", (when) => {
		for (const operation of ["explicit repair", "position"] as const) {
			const original = fresh();
			const first = original.appendMessage(user("第一条 🔧"));
			original.appendMessage(user("第二条"));
			const intact = actual.readFileSync(original.filePath);
			if (repairKind === "truncate") actual.appendFileSync(original.filePath, '{"type":');
			else actual.writeFileSync(original.filePath, intact.subarray(0, -1));
			const store = SessionStore.open(original.filePath);
			const leaf = store.getLeafId();
			const error = new Error(`${repairKind} failed ${when} write`);
			if (repairKind === "truncate") {
				vi.mocked(fs.truncateSync).mockImplementationOnce((file, length) => {
					if (when === "after") actual.truncateSync(file, length);
					throw error;
				});
			} else {
				vi.mocked(fs.appendFileSync).mockImplementationOnce((file, data) => {
					expect(data).toBe("\n");
					if (when === "after") actual.appendFileSync(file, data);
					throw error;
				});
			}
			expect(
				failureOf(() => (operation === "position" ? store.branchTo(first) : store.repairTornFinalLine())),
			).toBe(error);
			expect(store.getLeafId()).toBe(leaf);
			expect(store.getEntries()).toEqual(original.getEntries());
			expect(store.tornFinalLine).toBe(true);
			expectWriteRefusal(store);
			const reopened = SessionStore.open(store.filePath);
			expect(reopened.getLeafId()).toBe(leaf); // no position marker followed a failed repair
			expect(reopened.tornFinalLine).toBe(when === "before");
			reopened.appendMessage(user("after reopen"));
			expect(SessionStore.open(store.filePath).buildContext().messages).toEqual([
				user("第一条 🔧"),
				user("第二条"),
				user("after reopen"),
			]);
		}
	});
});

it("does not invalidate on a repair read failure before any write", () => {
	const original = fresh();
	original.appendMessage(user("kept"));
	actual.appendFileSync(original.filePath, '{"type":');
	const store = SessionStore.open(original.filePath);
	const error = new Error("read failed");
	vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
		throw error;
	});
	expect(failureOf(() => store.branchTo(null))).toBe(error);
	expect(store.getLeafId()).toBe(original.getLeafId());
	expect(() => store.assertWritable()).not.toThrow();
	store.branchTo(null);
	expect(SessionStore.open(store.filePath).getLeafId()).toBeNull();
});

it("buildContext(leafId) preflights another branch, compaction, or null without moving or writing", () => {
	const store = fresh();
	const first = store.appendMessage(user("root"));
	const callId = store.appendMessage(call);
	const resultId = store.appendMessage(result);
	const oldCompaction = store.appendCompaction("old branch", [user("old retained")], 100);
	store.branchTo(first);
	const currentCompaction = store.appendCompaction("current branch", [user("current retained")], 100);
	store.appendBranchSummary("accepted summary");
	store.appendMessage(user("current tail"));
	const receipt = store.appendSummaryUsage(usage);
	const leaf = store.getLeafId();
	const current = store.buildContext();
	const stats = store.stats();
	const bytes = actual.readFileSync(store.filePath);
	vi.mocked(fs.appendFileSync).mockClear();
	vi.mocked(fs.truncateSync).mockClear();
	vi.mocked(fs.readFileSync).mockClear();
	expect(store.buildContext(callId)).toEqual({
		messages: [user("root"), call],
		compacted: false,
		compactionBoundary: 0,
	});
	expect(store.buildContext(resultId).messages).toEqual([user("root"), call, result]);
	for (const [id, summary, retained] of [
		[oldCompaction, "old branch", "old retained"],
		[currentCompaction, "current branch", "current retained"],
	] as const) {
		expect(store.buildContext(id)).toEqual({
			messages: [summaryToMessage(summary), user(retained)],
			compacted: true,
			compactionBoundary: 2,
		});
	}
	expect(store.buildContext(null)).toEqual({ messages: [], compacted: false, compactionBoundary: 0 });
	expect(store.buildContext(undefined)).toEqual(current);
	expect(() => store.buildContext("missing")).toThrow(/not found/);
	expect(() => store.buildContext(receipt)).toThrow(/summary usage receipts are not branch targets/);
	expect(store.getLeafId()).toBe(leaf);
	expect(store.stats()).toEqual(stats);
	expect(store.buildContext()).toEqual(current);
	expect(actual.readFileSync(store.filePath)).toEqual(bytes);
	expect(fs.readFileSync).not.toHaveBeenCalled();
	expect(fs.appendFileSync).not.toHaveBeenCalled();
	expect(fs.truncateSync).not.toHaveBeenCalled();
});
