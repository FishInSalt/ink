/**
 * Clipboard reading — M13 batch 2 (images) + the §14.8 addendum (file
 * paths). pi reads the clipboard through pi-tui native bindings
 * (prebuilt .node) with xclip/wl-paste fallbacks; Ink has no native
 * bindings, so this port is command-based on every platform (design
 * §14.5, divergence D8):
 *
 *   darwin  — osascript JXA ObjC bridge: NSPasteboard PNG, TIFF→PNG via
 *             NSBitmapImageRep; emits base64 on stdout (no permission
 *             prompt, no native module).
 *   linux   — wl-paste --type image/png (Wayland/WSL-g) or
 *             xclip -selection clipboard -t image/png -o (X11).
 *   win32   — PowerShell Get-Clipboard -Format Image → PNG base64.
 *
 * Unsupported-but-decodable formats convert to PNG through photon before
 * returning. The result is bytes on disk + a path, never an inline block:
 * the tmp file keeps the message layer untouched (pi: same shape).
 *
 * §14.8: Finder/file-manager copies carry file URLs, never the file's
 * bytes — and the pasteboard's image representations are the file
 * *icon*, so the image reader must never see a file copy. The Ctrl+V
 * flow asks readClipboardFilePaths first (pi's order: paths → image →
 * text): darwin public.file-url per item (+ NSFilenamesPboardType
 * fallback), linux text/uri-list (wl-paste/xclip), win32 FileDropList.
 * Still command-based everywhere (D8).
 */

import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertImageBytesToPng } from "../core/image/image-convert.js";
import { detectSupportedImageMimeType } from "../core/tools/image-sniff.js";
import { runClipboardCommand } from "./clipboard-command.js";

export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (mimeType.split(";")[0]?.trim().toLowerCase()) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;

function baseMime(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

/** pi selectPreferredImageMimeType: preferred order first, then any image/*. */
function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMime(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	switch (mimeType.split(";")[0]?.trim().toLowerCase()) {
		case "image/png":
		case "image/jpeg":
		case "image/jpg":
		case "image/webp":
		case "image/gif":
			return true;
		default:
			return false;
	}
}

/** macOS: NSPasteboard PNG first, TIFF converted to PNG. Emits base64. */
const DARWIN_JXA = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
let out = '';
const png = pb.dataForType($.NSPasteboardTypePNG);
if (!png.isNil()) {
  out = png.base64EncodedStringWithOptions(0).js;
} else {
  const tiff = pb.dataForType($.NSPasteboardTypeTIFF);
  if (!tiff.isNil()) {
    const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (!rep.isNil()) {
      const pngType = $.NSBitmapImageFileTypePNG !== undefined ? $.NSBitmapImageFileTypePNG : $.NSPNGFileType;
      const pngData = rep.representationUsingTypeProperties(pngType, $.NSDictionary.dictionary);
      if (!pngData.isNil()) out = pngData.base64EncodedStringWithOptions(0).js;
    }
  }
}
out;`;

/** macOS file paths (§14.8): per-item public.file-url — NSURL.path
 *  percent-decodes — with a legacy NSFilenamesPboardType fallback for
 *  apps that offer none. Emits a JSON array; the reader treats non-JSON
 *  output as a bug signal (abort), never as "no files". */
const DARWIN_PATHS_JXA = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
const out = [];
const items = pb.pasteboardItems;
if (!items.isNil()) {
  for (let i = 0; i < items.count; i++) {
    const item = items.objectAtIndex(i);
    const urlStr = item.stringForType('public.file-url');
    if (!urlStr.isNil()) {
      const url = $.NSURL.URLWithString(urlStr);
      if (!url.isNil()) {
        const p = url.path;
        if (!p.isNil()) out.push(ObjC.unwrap(p));
      }
    }
  }
}
if (out.length === 0) {
  try {
    const legacy = pb.propertyListForType('NSFilenamesPboardType');
    if (!legacy.isNil()) {
      const arr = ObjC.deepUnwrap(legacy);
      if (Array.isArray(arr)) {
        for (const p of arr) if (typeof p === 'string' && p !== '') out.push(p);
      }
    }
  } catch (e) {}
}
JSON.stringify(out);`;

const WIN32_PS = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$img = [System.Windows.Forms.Clipboard]::GetImage();
if ($null -ne $img) {
  $ms = New-Object System.IO.MemoryStream;
  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);
  [Convert]::ToBase64String($ms.ToArray())
}`;

/** Native Windows file paths (§14.8): Get-Clipboard -Format FileDropList
 *  yields FileInfo objects whose bare output formats as a truncated
 *  table when piped — map .FullName (plain strings pass through). */
const WIN32_FILE_LIST_PS = `
$items = Get-Clipboard -Format FileDropList;
if ($null -ne $items) {
  foreach ($f in $items) {
    if ($f -is [System.IO.FileInfo]) { $f.FullName } else { $f.ToString() }
  }
}`;

export interface ReadClipboardImageOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** Test seam: replace the process spawner. */
	run?: typeof runClipboardCommand;
	/** Test seam: replace the PNG converter. */
	convert?: (bytes: Uint8Array) => Promise<Uint8Array | null>;
}

async function readViaDarwin(run: typeof runClipboardCommand): Promise<ClipboardImage | null | undefined> {
	const out = await run("osascript", ["-l", "JavaScript", "-e", DARWIN_JXA]);
	if (out === undefined) return undefined; // osascript missing/failed
	const base64 = out.toString("utf-8").trim();
	if (base64 === "") return null; // ran fine, no image on the pasteboard
	const bytes = new Uint8Array(Buffer.from(base64, "base64"));
	if (bytes.length === 0) return null;
	return { bytes, mimeType: detectSupportedImageMimeType(bytes) ?? "application/octet-stream" };
}

async function readViaDarwinPaths(run: typeof runClipboardCommand): Promise<string[] | null | undefined> {
	const out = await run("osascript", ["-l", "JavaScript", "-e", DARWIN_PATHS_JXA]);
	if (out === undefined) return undefined; // osascript missing/failed
	const text = out.toString("utf-8").trim();
	if (text === "") return null; // ran fine, nothing on the pasteboard
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("clipboard file-path read returned unusable output");
	}
	if (!Array.isArray(parsed)) throw new Error("clipboard file-path read returned unusable output");
	const paths = parsed.filter((p): p is string => typeof p === "string" && p !== "");
	return paths.length > 0 ? paths : null;
}

async function readViaWlPaste(run: typeof runClipboardCommand): Promise<ClipboardImage | null | undefined> {
	const list = await run("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (list === undefined) return undefined; // wl-clipboard absent

	const types = list
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) return null; // offered types carry no image at all

	// --no-newline: byte-exact even on TTY-attached clipboards (pi parity)
	const data = await run("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;
	return { bytes: new Uint8Array(data), mimeType: baseMime(selectedType) };
}

async function readViaXclip(run: typeof runClipboardCommand): Promise<ClipboardImage | null | undefined> {
	const targets = await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets !== undefined) {
		candidateTypes = targets
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	const preferred = selectPreferredImageMimeType(candidateTypes);
	if (targets !== undefined && !preferred) return null;
	const tryTypes = new Set(
		preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : SUPPORTED_IMAGE_MIME_TYPES,
	);

	for (const mimeType of tryTypes) {
		const data = await run("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data !== undefined && data.length > 0) {
			return { bytes: new Uint8Array(data), mimeType: baseMime(mimeType) };
		}
	}

	return undefined;
}

/** Parse a text/uri-list payload (§14.8, RFC 2483): one URI per line,
 *  "#" comments, percent-encoded file paths; a malformed escape skips
 *  the line, never the whole paste. Non-file schemes are skipped. */
export function parseUriList(text: string): string[] {
	const paths: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		if (!line.startsWith("file://")) continue;
		const rest = line.slice("file://".length);
		const slashAt = rest.indexOf("/");
		if (slashAt === -1) continue;
		const host = rest.slice(0, slashAt);
		if (host !== "" && host.toLowerCase() !== "localhost") continue;
		try {
			paths.push(decodeURIComponent(rest.slice(slashAt)));
		} catch {
			// malformed escape — skip the line
		}
	}
	return paths;
}

function isUriListType(types: string[]): boolean {
	return types.some((t) => t.split(";")[0]?.trim() === "text/uri-list");
}

async function readViaWlPastePaths(run: typeof runClipboardCommand): Promise<string[] | null | undefined> {
	const list = await run("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (list === undefined) return undefined; // wl-clipboard absent

	const types = list
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);
	if (!isUriListType(types)) return null; // no file list — no xclip retry (image-leg parity)

	const data = await run("wl-paste", ["--type", "text/uri-list", "--no-newline"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;
	const paths = parseUriList(data.toString("utf-8"));
	return paths.length > 0 ? paths : null;
}

async function readViaXclipPaths(run: typeof runClipboardCommand): Promise<string[] | null | undefined> {
	const targets = await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});
	if (targets === undefined) return undefined; // xclip absent

	const types = targets
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);
	if (!isUriListType(types)) return null;

	const data = await run("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;
	const paths = parseUriList(data.toString("utf-8"));
	return paths.length > 0 ? paths : null;
}

export function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}
	try {
		const release = readFileSync("/proc/version", "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

/** WSL fallback (pi parity): Windows screenshots never reach the WSL
 *  clipboard; PowerShell saves the Windows clipboard to a tmp file visible
 *  on both sides via wslpath. */
async function readViaPowerShellWsl(run: typeof runClipboardCommand): Promise<ClipboardImage | null> {
	const tmpFile = join(tmpdir(), `ink-wsl-clip-${randomUUID()}.png`);
	try {
		const winPathResult = await run("wslpath", ["-w", tmpFile], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
		if (winPathResult === undefined) return null;
		const winPath = winPathResult.toString("utf-8").trim();
		if (!winPath) return null;

		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = await run("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (result === undefined) return null;
		if (result.toString("utf-8").trim() !== "ok") return null;

		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) return null;
		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

/** Native Windows: Get-Clipboard → PNG base64 on stdout. */
async function readViaPowerShellNative(
	run: typeof runClipboardCommand,
): Promise<ClipboardImage | null | undefined> {
	const out = await run("powershell", ["-NoProfile", "-STA", "-Command", WIN32_PS], {
		timeoutMs: 5000,
	});
	if (out === undefined) return undefined;
	const base64 = out.toString("utf-8").trim();
	if (base64 === "") return null;
	const bytes = new Uint8Array(Buffer.from(base64, "base64"));
	if (bytes.length === 0) return null;
	return { bytes, mimeType: "image/png" };
}

async function readViaPowerShellPaths(run: typeof runClipboardCommand): Promise<string[] | null | undefined> {
	const out = await run("powershell", ["-NoProfile", "-STA", "-Command", WIN32_FILE_LIST_PS], {
		timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
	});
	if (out === undefined) return undefined;
	const paths = out
		.toString("utf-8")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	return paths.length > 0 ? paths : null;
}

/**
 * Read an image from the system clipboard. Null = no image (or unusable);
 * undefined = the platform reader itself is unavailable.
 */
export async function readClipboardImage(
	options?: ReadClipboardImageOptions,
): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;
	const run = options?.run ?? runClipboardCommand;
	const convert = options?.convert ?? convertImageBytesToPng;

	if (env.TERMUX_VERSION) {
		return null; // pi parity: Termux has no image clipboard
	}

	let image: ClipboardImage | null | undefined;

	if (platform === "darwin") {
		image = await readViaDarwin(run);
	} else if (platform === "linux") {
		const wsl = isWSL(env);
		if (isWaylandSession(env) || wsl) {
			image = await readViaWlPaste(run);
		}
		if (image === undefined) image = await readViaXclip(run);
		// Only under WSL does the PowerShell fallback make sense (pi parity;
		// review P2-2 — plain Linux never spawns powershell).
		if (!image && wsl) image = (await readViaPowerShellWsl(run)) ?? image;
	} else if (platform === "win32") {
		image = await readViaPowerShellNative(run);
	} else {
		return null;
	}

	if (!image) {
		return null;
	}

	// Convert unsupported formats (e.g. Windows DIB wrapped as BMP) to PNG.
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convert(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}

export interface ReadClipboardFilePathsOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** Test seam: replace the process spawner. */
	run?: typeof runClipboardCommand;
}

/**
 * Read file paths from the system clipboard (§14.8 — Finder and
 * file-manager copies). string[] = files; null = ran clean, no file
 * URLs (fall through to the image reader); undefined = the platform
 * reader is unavailable (also falls through; both legs share the same
 * command matrix, so a missing tool cannot hand the image leg an icon).
 * Throws when a reader ran but its output is unusable — the caller
 * aborts the paste instead of falling through (pi's "no fall-through to
 * the icon" test parity).
 */
export async function readClipboardFilePaths(
	options?: ReadClipboardFilePathsOptions,
): Promise<string[] | null | undefined> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;
	const run = options?.run ?? runClipboardCommand;

	if (env.TERMUX_VERSION) {
		return null; // pi parity: Termux has no file clipboard
	}

	if (platform === "darwin") {
		return readViaDarwinPaths(run);
	}
	if (platform === "linux") {
		let paths: string[] | null | undefined;
		if (isWaylandSession(env) || isWSL(env)) {
			paths = await readViaWlPastePaths(run);
		}
		if (paths === undefined) paths = await readViaXclipPaths(run);
		return paths;
	}
	if (platform === "win32") {
		return readViaPowerShellPaths(run);
	}
	return null;
}

/**
 * Persist a clipboard image to a tmp file and return its path — the Ctrl+V
 * flow inserts the path into the editor; the model reads the file like any
 * other attachment (the message layer never sees clipboard bytes).
 */
export function writeClipboardImageToTmp(image: ClipboardImage): string {
	const ext = extensionForImageMimeType(image.mimeType) ?? "png";
	const filePath = join(tmpdir(), `ink-clipboard-${randomUUID()}.${ext}`);
	writeFileSync(filePath, Buffer.from(image.bytes));
	return filePath;
}
