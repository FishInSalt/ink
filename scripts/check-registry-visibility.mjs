import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const PUBLISH_NOTICE =
	"npm publish returned success; registry verification is pending. Do not rerun publication.";
const BUDGET_MS = 600_000;
const REQUEST_MS = 15_000;
const MAX_BYTES = 256 * 1024;
const DELAYS = [5000, 10_000, 20_000, 30_000];

export class RegistryVerificationError extends Error {
	constructor(message, pending = false) {
		super(message);
		this.name = "RegistryVerificationError";
		this.pending = pending;
	}
}
class ProbeTimeout extends Error {}

function validate(config) {
	if (config === null || typeof config !== "object")
		throw new RegistryVerificationError("Invalid verifier configuration");
	if (config.packageName !== "ink-agent") throw new RegistryVerificationError("Invalid package identity");
	if (
		typeof config.version !== "string" ||
		config.version.length > 64 ||
		!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(config.version)
	) {
		throw new RegistryVerificationError("Invalid stable release version");
	}
	if (typeof config.commit !== "string" || !/^[a-f0-9]{40}$/i.test(config.commit)) {
		throw new RegistryVerificationError("Invalid expected source commit");
	}
	return {
		packageName: config.packageName,
		version: config.version,
		commit: config.commit.toLowerCase(),
		tarball: `https://registry.npmjs.org/ink-agent/-/ink-agent-${config.version}.tgz`,
	};
}
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function metadataVisible(data, expected) {
	if (!record(data)) throw new RegistryVerificationError("Registry metadata is not an object");
	let complete = true;
	for (const [field, value] of [
		["name", expected.packageName],
		["version", expected.version],
		["gitHead", expected.commit],
	]) {
		if (data[field] === undefined) complete = false;
		else if (data[field] !== value)
			throw new RegistryVerificationError(`Registry metadata ${field} mismatch`);
	}
	if (data.dist === undefined) complete = false;
	else if (!record(data.dist)) throw new RegistryVerificationError("Invalid registry distribution metadata");
	else if (data.dist.tarball === undefined) complete = false;
	else if (data.dist.tarball !== expected.tarball)
		throw new RegistryVerificationError("Registry tarball mismatch");
	return complete;
}

function cancelBody(body) {
	try {
		void body?.cancel().catch(() => {});
	} catch {
		/* Preserve the verification outcome. */
	}
}

/** The request deadline covers fetch AND body reads. Late work is observed and
 * cancelled; neither cleanup nor an untrusted response can replace the outcome. */
async function probe(expected, fetcher, timeoutMs, now) {
	const controller = new AbortController();
	const deadline = now() + timeoutMs;
	const overdue = () => controller.signal.aborted || now() >= deadline;
	let response;
	let reader;
	let timer;
	const expired = new Promise((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new ProbeTimeout());
		}, timeoutMs);
	});
	const work = (async () => {
		response = await fetcher(`https://registry.npmjs.org/ink-agent/${expected.version}`, {
			method: "GET",
			redirect: "manual",
			credentials: "omit",
			cache: "no-store",
			headers: { accept: "application/json", "cache-control": "no-cache" },
			signal: controller.signal,
		});
		if (overdue()) {
			cancelBody(response.body);
			throw new ProbeTimeout();
		}
		if (response.redirected || (response.status >= 300 && response.status < 400)) {
			throw new RegistryVerificationError("Registry redirect rejected");
		}
		if (response.status === 404 || response.status === 429 || response.status >= 500) {
			return { verified: false, reason: `HTTP ${response.status}` };
		}
		if (response.status !== 200)
			throw new RegistryVerificationError(`Registry HTTP ${response.status} rejected`);
		if (!response.body) throw new RegistryVerificationError("Registry metadata body is missing");
		reader = response.body.getReader();
		const chunks = [];
		let length = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (overdue()) throw new ProbeTimeout();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_BYTES) throw new RegistryVerificationError("Registry metadata exceeds the size limit");
			chunks.push(value);
		}
		let metadata;
		try {
			metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new RegistryVerificationError("Registry metadata is not valid JSON");
		}
		if (overdue()) throw new ProbeTimeout();
		return { verified: metadataVisible(metadata, expected), reason: "metadata incomplete" };
	})();
	try {
		return await Promise.race([work, expired]);
	} catch (error) {
		if (error instanceof RegistryVerificationError) throw error;
		return {
			verified: false,
			reason:
				error instanceof ProbeTimeout || controller.signal.aborted ? "request timeout" : "network failure",
		};
	} finally {
		clearTimeout(timer);
		controller.abort();
		if (reader) {
			try {
				void reader.cancel().catch(() => {});
			} catch {
				/* Best effort. */
			}
			try {
				reader.releaseLock();
			} catch {
				/* Pending reads must not mask the result. */
			}
		} else cancelBody(response?.body);
	}
}

/** Transport/time injection is for offline verification, never a configurable
 * registry endpoint. No auth, npm configuration, process spawning or publishing. */
export async function verifyRegistryVisibility(
	config,
	{
		fetch: fetcher = globalThis.fetch,
		now = () => performance.now(),
		sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		budgetMs = BUDGET_MS,
		requestTimeoutMs = REQUEST_MS,
	} = {},
) {
	const expected = validate(config);
	for (const value of [budgetMs, requestTimeoutMs]) {
		if (!Number.isSafeInteger(value) || value <= 0)
			throw new RegistryVerificationError("Invalid verification time budget");
	}
	const start = now();
	const deadline = start + budgetMs;
	let attempts = 0;
	let last = "not observed";
	while (true) {
		const remaining = deadline - now();
		if (remaining <= 0) break;
		const result = await probe(expected, fetcher, Math.min(requestTimeoutMs, remaining), now);
		attempts += 1;
		const observed = now();
		if (result.verified && observed < deadline) return { ...expected, attempts, elapsedMs: observed - start };
		last = result.verified ? "response arrived at the deadline" : result.reason;
		const pause = deadline - observed;
		if (pause <= 0) break;
		await sleep(Math.min(DELAYS[Math.min(attempts - 1, DELAYS.length - 1)], pause));
	}
	throw new RegistryVerificationError(
		`Registry metadata verification timed out after ${budgetMs / 1000}s (${attempts} probes; last: ${last})`,
		true,
	);
}

/** Reporting is secondary to verification: warnings never change its exit code.
 * Invalid input writes no summary; the workflow emits its fixed notice first. */
export async function runRegistryVisibility(
	env = process.env,
	{
		verify = verifyRegistryVisibility,
		stdout = (text) => console.log(text),
		stderr = (text) => console.error(text),
		appendSummary = (path, text) => appendFileSync(path, text, "utf8"),
	} = {},
) {
	const summary = (text) => {
		if (!env.GITHUB_STEP_SUMMARY) return;
		try {
			appendSummary(env.GITHUB_STEP_SUMMARY, text);
		} catch {
			stderr("Warning: could not write registry verification summary; see the verification result above.");
		}
	};
	let config;
	try {
		config = validate({ packageName: env.PACKAGE, version: env.VERSION, commit: env.EXPECTED_GIT_HEAD });
	} catch (error) {
		stderr(PUBLISH_NOTICE);
		stderr(error instanceof RegistryVerificationError ? error.message : "Invalid verifier configuration");
		return 1;
	}
	try {
		await verify(config);
		const message = `Registry metadata verified: ${config.packageName}@${config.version}, source ${config.commit}.`;
		stdout(message);
		stdout("Artifact integrity and provenance still require separate post-publication verification.");
		summary(
			`\n### Registry metadata verified\n\n${message}\n\nArtifact integrity and provenance require separate verification.\n`,
		);
		return 0;
	} catch (error) {
		stderr(PUBLISH_NOTICE);
		const detail =
			error instanceof RegistryVerificationError
				? error.message
				: "Registry verification failed unexpectedly";
		stderr(detail);
		summary(
			`\n### Registry verification ${error instanceof RegistryVerificationError && error.pending ? "pending" : "failed"}\n\n${PUBLISH_NOTICE}\n\n${detail}\n`,
		);
		return 1;
	}
}

if (
	process.argv[1] &&
	existsSync(process.argv[1]) &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	process.exitCode = await runRegistryVisibility();
}
