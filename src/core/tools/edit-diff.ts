/**
 * Exact-match multi-edit machinery for the edit tool.
 *
 * Core multi-edit semantics match pi's exact-match path: every edits[].oldText
 * is matched against the ORIGINAL file content — not incrementally. Each must
 * match exactly once and must not overlap any other edit. Either all edits
 * apply or none do. pi's fuzzy fallback is intentionally not ported.
 */

export interface Edit {
	oldText: string;
	newText: string;
}

export interface AppliedEdit {
	oldText: string;
	newText: string;
	/** Index of the replacement in the ORIGINAL content. */
	start: number;
	end: number;
	/** 1-indexed line of `start` in the original content. */
	line: number;
	/** 1-indexed line of the replacement start in the NEW content. */
	newLine: number;
}

export type ApplyResult =
	| { ok: true; content: string; applied: AppliedEdit[] }
	| { ok: false; error: string };

export function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** Teach, don't just fail: errors explain what to do next. */
function describeFailure(index: number, count: number): string {
	if (count === 0) {
		return `edits[${index}].oldText was not found in the file. The match is exact — whitespace, indentation, and line breaks all matter. Read the file again, copy the text exactly (including leading whitespace), and make sure it is unique.`;
	}
	return `edits[${index}].oldText matches ${count} times. Include more surrounding lines (comments, blank lines) to make it unique.`;
}

export function applyEdits(original: string, edits: Edit[]): ApplyResult {
	const applied: AppliedEdit[] = [];

	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		if (!edit) continue;
		const { oldText, newText } = edit;
		if (oldText === "") {
			return { ok: false, error: `edits[${i}].oldText is empty — provide the exact text to replace.` };
		}
		if (oldText === newText) {
			return { ok: false, error: `edits[${i}].newText is identical to oldText — nothing would change.` };
		}
		const count = countOccurrences(original, oldText);
		if (count !== 1) {
			return { ok: false, error: describeFailure(i, count) };
		}
		const start = original.indexOf(oldText);
		const line = original.slice(0, start).split("\n").length;
		applied.push({ oldText, newText, start, end: start + oldText.length, line, newLine: line });
	}

	// Overlap check (sorted by start, adjacent pairs).
	applied.sort((a, b) => a.start - b.start);
	for (let i = 1; i < applied.length; i++) {
		const prev = applied[i - 1];
		const cur = applied[i];
		if (prev && cur && cur.start < prev.end) {
			return {
				ok: false,
				error:
					`edits overlap around original line ${cur.line}. Overlapping or nested edits are not allowed — ` +
					`merge them into a single edit that covers the whole region once.`,
			};
		}
	}

	// Rebuild the file from the original plus non-overlapping sorted ranges.
	// New-file starts account for every earlier edit's line-count delta.
	let lineDelta = 0;
	for (const edit of applied) {
		edit.newLine = edit.line + lineDelta;
		lineDelta += lineCount(edit.newText) - lineCount(edit.oldText);
	}

	let content = "";
	let cursor = 0;
	for (const edit of applied) {
		content += original.slice(cursor, edit.start) + edit.newText;
		cursor = edit.end;
	}
	content += original.slice(cursor);

	return { ok: true, content, applied };
}

export interface DiffLineNumbers {
	oldLine: number;
	newLine: number;
}

function lineCount(text: string): number {
	return text.split("\n").length;
}

/**
 * Simple line diff (LCS) between two small text fragments. Without `numbers`
 * this emits only changed lines, preserving the pre-header display contract.
 * With `numbers`, each contiguous changed block gets an Ink-specific header:
 * `@@ old <oldStart> new <newStart> @@`, where the starts are computed from
 * zero-based indices into the split fragments. An elided fragment emits the
 * unparseable `@@ diff elided @@` reset marker so renderers turn numbering off.
 */
export function diffLines(before: string, after: string, numbers?: DiffLineNumbers): string {
	const a = before.split("\n");
	const b = after.split("\n");
	// LCS table. Edit fragments are small; for pathological sizes, degrade gracefully.
	if (a.length * b.length > 1_000_000) {
		const summary = `- ${a.length} lines\n+ ${b.length} lines (diff elided)`;
		return numbers ? `@@ diff elided @@\n${summary}` : summary;
	}
	const table: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i]![j] =
				a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
		}
	}

	const out: string[] = [];
	let block: { oldStart: number; newStart: number; lines: string[] } | null = null;
	const flush = (): void => {
		if (block === null) return;
		if (numbers) {
			out.push(`@@ old ${numbers.oldLine + block.oldStart} new ${numbers.newLine + block.newStart} @@`);
		}
		out.push(...block.lines);
		block = null;
	};

	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			flush();
			i++;
			j++;
		} else {
			block ??= { oldStart: i, newStart: j, lines: [] };
			if (table[i + 1]![j]! >= table[i]![j + 1]!) {
				block.lines.push(`- ${a[i] ?? ""}`);
				i++;
			} else {
				block.lines.push(`+ ${b[j] ?? ""}`);
				j++;
			}
		}
	}
	if (i < a.length || j < b.length) {
		block ??= { oldStart: i, newStart: j, lines: [] };
		while (i < a.length) block.lines.push(`- ${a[i++] ?? ""}`);
		while (j < b.length) block.lines.push(`+ ${b[j++] ?? ""}`);
	}
	flush();
	return out.join("\n");
}

/** BOM helpers: strip for processing, restore on write. */
export function stripBom(text: string): { bom: string; text: string } {
	return text.charCodeAt(0) === 0xfeff ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

/** Detect the dominant line ending so CRLF files round-trip unchanged. */
export function detectLineEnding(text: string): "\r\n" | "\n" {
	const crlf = countOccurrences(text, "\r\n");
	const lf = countOccurrences(text, "\n") - crlf;
	return crlf > lf ? "\r\n" : "\n";
}

export function replaceLineEndings(text: string, ending: "\r\n" | "\n"): string {
	// Normalize any \r variant first, then apply the target ending exactly once.
	const lf = text.replace(/\r\n?/g, "\n");
	return ending === "\n" ? lf : lf.split("\n").join(ending);
}
