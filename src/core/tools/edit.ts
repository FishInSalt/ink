import { readFile, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import {
	applyEdits,
	detectLineEnding,
	diffLines,
	type Edit,
	replaceLineEndings,
	stripBom,
} from "./edit-diff.js";
import { withFileLock } from "./file-lock.js";
import { resolveToCwd } from "./path-resolve.js";
import { editPresentation } from "./presentation.js";
import type { Tool } from "./types.js";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text to replace. Must match the original file exactly (whitespace and line breaks included) and be unique.",
	}),
	newText: Type.String({ description: "Replacement text." }),
});

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements, all matched against the ORIGINAL file (not incrementally). " +
				"Each oldText must be unique and must not overlap another edit; merge nearby changes into one edit instead.",
		}),
	},
	{ additionalProperties: false },
);

export interface EditToolOptions {
	cwd?: string;
}

type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/** Compatibility shim for model-emitted shapes pi also accepts. */
export function prepareEditArguments(args: Record<string, unknown>): Record<string, unknown> {
	let edits = args.edits;
	if (typeof edits === "string") {
		try {
			const parsed = JSON.parse(edits);
			if (Array.isArray(parsed)) edits = parsed;
			else if (isSingleEditInput(parsed)) edits = [parsed];
		} catch {}
	} else if (isSingleEditInput(edits)) {
		edits = [edits];
	}

	const oldText = args.oldText;
	const newText = args.newText;
	if (typeof oldText !== "string" || typeof newText !== "string") {
		return edits === args.edits ? args : { ...args, edits };
	}

	const list = Array.isArray(edits) ? [...edits] : [];
	list.push({ oldText, newText });
	const { oldText: _oldText, newText: _newText, ...rest } = args;
	return { ...rest, edits: list };
}

export function createEditTool(options: EditToolOptions = {}): Tool {
	const cwd = options.cwd ?? process.cwd();
	return {
		name: "edit",
		presentation: editPresentation,
		promptSnippet: "precise in-place edits; each oldText must match exactly and be unique.",
		description:
			"Edit a file with exact text replacement. Each edits[].oldText must match a unique, non-overlapping " +
			"region of the original file — include enough surrounding lines to make it unique. Read the file first and " +
			"copy text exactly (indentation matters). All edits are validated before a single write: if any oldText is " +
			"not found or matches more than once, nothing is written and the error tells you how to fix it. " +
			"Prefer several small precise edits over one huge replacement.",
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(args, signal) {
			const requested = String(args.path ?? "");
			const edits = (args.edits ?? []) as Edit[];
			if (edits.length === 0) {
				return { output: "Error: edits must contain at least one replacement.", isError: true };
			}
			const absolute = resolveToCwd(requested, cwd);

			return withFileLock(absolute, async () => {
				if (signal.aborted) return { output: "Error: aborted before edit", isError: true };

				let raw: string;
				try {
					raw = await readFile(absolute, "utf8");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { output: `Error reading ${requested}: ${message}`, isError: true };
				}

				const { bom, text } = stripBom(raw);
				const ending = detectLineEnding(text);
				const original = replaceLineEndings(text, "\n");
				const normalizedEdits = edits.map((e) => ({
					oldText: replaceLineEndings(e.oldText, "\n"),
					newText: replaceLineEndings(e.newText, "\n"),
				}));

				const result = applyEdits(original, normalizedEdits);
				if (!result.ok) {
					return { output: `Error: ${result.error}`, isError: true };
				}

				if (signal.aborted) return { output: "Error: aborted before write", isError: true };

				const finalContent = bom + replaceLineEndings(result.content, ending);
				try {
					await writeFile(absolute, finalContent, "utf8");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return { output: `Error writing ${requested}: ${message}`, isError: true };
				}

				const count = result.applied.length;
				const plural = count > 1 ? "s" : "";
				// prompt-audit P1: the model wrote oldText/newText and an exact
				// match means the outcome is fully known to it — the diff is a
				// zero-information restatement. The model gets one line; the diff
				// stays display-only and the fold owns its two-sided numbering.
				const sections = result.applied.map((e) =>
					diffLines(e.oldText, e.newText, { oldLine: e.line, newLine: e.newLine }),
				);
				const displayText = `Edited ${requested} (${count} edit${plural} applied):\n${sections.join("\n")}`;
				return {
					content: [{ type: "text", text: `Edited ${requested}: ${count} edit${plural} applied.` }],
					// output doubles as the pre-P1 display fallback (the read-image
					// pattern): content wins for the model, display wins for the UI.
					output: displayText,
					display: displayText,
				};
			});
		},
	};
}
