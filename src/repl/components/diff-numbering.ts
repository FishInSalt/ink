/**
 * Shared hunk-header parsing and two-sided line numbering for edit diff display.
 *
 * The edit tool emits one header per contiguous changed block:
 *   @@ old <oldStart> new <newStart> @@
 *
 * Older display strings may carry `@@ line N @@`; both sides start at N.
 * Removed lines consume the old counter; added lines the new one; context
 * lines consume both (they exist on both sides).
 * The helper returns numbers only; padding is a renderer concern.
 */

export interface DiffNumbering {
	old: number | null;
	new: number | null;
}

export interface HunkHeader {
	oldLine: number;
	newLine: number;
}

export function parseHunkHeader(line: string): HunkHeader | null {
	const legacy = /^@@ line (\d+) @@$/.exec(line);
	if (legacy) {
		const lineNumber = Number(legacy[1]);
		return { oldLine: lineNumber, newLine: lineNumber };
	}
	const twoSided = /^@@ old (\d+) new (\d+) @@$/.exec(line);
	if (twoSided) {
		return { oldLine: Number(twoSided[1]), newLine: Number(twoSided[2]) };
	}
	return null;
}

export function createDiffNumbering(header: HunkHeader | null): DiffNumbering {
	return header ? { old: header.oldLine, new: header.newLine } : { old: null, new: null };
}

export type DiffLineKind = "add" | "remove" | "context";

export function nextDiffLineNumber(state: DiffNumbering, kind: DiffLineKind): number | null {
	if (kind === "remove") {
		const number = state.old;
		if (count(number)) state.old = number + 1;
		return number;
	}
	if (kind === "add") {
		const number = state.new;
		if (count(number)) state.new = number + 1;
		return number;
	}
	const number = state.new;
	if (count(state.old)) state.old += 1;
	if (count(state.new)) state.new += 1;
	return number;
}

function count(value: number | null): value is number {
	return value !== null;
}
