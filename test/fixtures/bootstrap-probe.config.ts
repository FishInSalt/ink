import { defineConfig } from "vitest/config";
import config from "../../vitest.config.js";

export default defineConfig({
	...config,
	test: {
		...config.test,
		// Replace, do not merge: mergeConfig concatenates include arrays and
		// would recursively execute the parent bootstrap regression as well.
		include: ["test/fixtures/bootstrap-probe.case.ts"],
		provide: { bootstrapReport: process.env.INK_BOOTSTRAP_REPORT ?? "" },
	},
});

declare module "vitest" {
	export interface ProvidedContext {
		bootstrapReport: string;
		bootstrapControl?: { ready: string; release: string };
	}
}
