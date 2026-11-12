import { writeFileSync } from "node:fs";
import path from "node:path";

const [dir, role] = process.argv.slice(2);
if (!dir || role !== "no-ready") throw new Error(`unknown lease control role: ${role}`);
if (!Object.hasOwn(globalThis, Symbol.for("ink.test.network-blocker")))
	throw new Error("lease worker missing inherited network preload");
if (!process.env.HOME?.startsWith(`${process.env.TMPDIR}/`))
	throw new Error("lease worker missing isolated HOME");
process.on("SIGTERM", () => {
	console.error("no-ready ignored SIGTERM");
});
console.error("no-ready role started, deliberately withholding ready");
writeFileSync(path.join(dir, "started"), "");
setInterval(() => {}, 1000);
