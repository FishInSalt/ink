import type { TestProject } from "vitest/node";
import { createTestRunRoot } from "./test-run-root.js";

export default function setup(project: TestProject): () => void {
	const hadEnv = Object.hasOwn(project.config, "env");
	const originalEnv = project.config.env;
	const workerEnv = { ...originalEnv };
	// Vitest rebuilds worker environments from project.config.env on each run.
	// Its onCancel listeners are cleared on rerun, unlike this global setup.
	// Never redirect the coordinator: cancellation cannot restore it too early
	// or leave it redirected when a later run has no setup listener.
	const run = createTestRunRoot({ env: workerEnv });
	const teardown = () => {
		if (hadEnv) project.config.env = originalEnv;
		else Reflect.deleteProperty(project.config, "env");
		run.teardown();
	};
	try {
		project.config.env = workerEnv;
		project.provide("testRunRoot", run.root);
		return teardown;
	} catch (error) {
		teardown();
		throw error;
	}
}

declare module "vitest" {
	export interface ProvidedContext {
		testRunRoot: string;
	}
}
