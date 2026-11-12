import { mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The guard must already exist at source-module evaluation, not be installed
// later by a test import. A TS annotation also proves the Node --import loader.
const preloaded: boolean = Object.hasOwn(globalThis, Symbol.for("ink.test.network-blocker"));
const fixture = mkdtempSync(join(tmpdir(), "ink-bootstrap-child-"));
rmdirSync(fixture);
console.log(JSON.stringify({ tmpdir: tmpdir(), fixture, preloaded, options: process.env.NODE_OPTIONS }));
