import type { TestProject } from "vitest/node";
import { createTestRunRoot } from "./test-run-root.js";

export default function setup(project: TestProject): () => void {
	const run = createTestRunRoot();
	let unsubscribe: (() => void) | undefined;
	try {
		project.provide("testRunRoot", run.root);
		// Cancellation may precede worker close: restore the coordinator's env
		// now, but leave the root available until Vitest calls global teardown.
		unsubscribe = project.vitest.onCancel(() => run.restoreEnvironment());
		return () => {
			unsubscribe?.();
			run.teardown();
		};
	} catch (error) {
		unsubscribe?.();
		run.teardown();
		throw error;
	}
}

declare module "vitest" {
	export interface ProvidedContext {
		testRunRoot: string;
	}
}
