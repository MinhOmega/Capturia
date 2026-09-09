import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import {
	ApprovedExportPaths,
	cliExportDestinations,
	hasAllowedExportExtension,
} from "./exportPolicy";

const posix = nodePath.posix;
const win32 = nodePath.win32;

describe("hasAllowedExportExtension", () => {
	it("accepts the two containers the exporter produces", () => {
		expect(hasAllowedExportExtension("/tmp/take.mp4", posix)).toBe(true);
		expect(hasAllowedExportExtension("/tmp/take.GIF", posix)).toBe(true);
	});

	it("rejects everything else", () => {
		expect(hasAllowedExportExtension("/tmp/take.webm", posix)).toBe(false);
		expect(hasAllowedExportExtension("/home/me/.ssh/config", posix)).toBe(false);
		expect(hasAllowedExportExtension("/tmp/take", posix)).toBe(false);
	});
});

describe("ApprovedExportPaths", () => {
	it("approves only what was handed to it", () => {
		const registry = new ApprovedExportPaths(posix);
		expect(registry.isApproved("/home/me/Movies/take.mp4")).toBe(false);
		expect(registry.approve("/home/me/Movies/take.mp4")).toBe("/home/me/Movies/take.mp4");
		expect(registry.isApproved("/home/me/Movies/take.mp4")).toBe(true);
		// A sibling in the same directory is a different destination.
		expect(registry.isApproved("/home/me/Movies/other.mp4")).toBe(false);
	});

	it("does not let a traversal reach an unapproved destination", () => {
		const registry = new ApprovedExportPaths(posix);
		registry.approve("/home/me/Movies/take.mp4");
		expect(registry.isApproved("/home/me/Movies/../../../etc/take.mp4")).toBe(false);
		// ...but a noisy spelling of the approved path is still the approved path.
		expect(registry.isApproved("/home/me/Movies/./take.mp4")).toBe(true);
		expect(registry.isApproved("/home/me/Downloads/../Movies/take.mp4")).toBe(true);
	});

	it("refuses to approve what it would never write", () => {
		const registry = new ApprovedExportPaths(posix);
		// An extension check alone is not a destination check, so the extension
		// gate has to hold at approval time too.
		expect(registry.approve("/home/me/.ssh/config")).toBeNull();
		expect(registry.approve("relative/take.mp4")).toBeNull();
		expect(registry.approve("")).toBeNull();
		expect(registry.approve(null)).toBeNull();
		expect(registry.approve(42)).toBeNull();
		expect(registry.size).toBe(0);
	});

	it("never approves a path that only looks right", () => {
		const registry = new ApprovedExportPaths(posix);
		registry.approve("/home/me/Movies/take.mp4");
		expect(registry.isApproved("/home/me/Movies/take.mp4.sh")).toBe(false);
		expect(registry.isApproved("/home/me/.ssh/config.mp4")).toBe(false);
		expect(registry.isApproved(undefined)).toBe(false);
	});

	it("compares Windows destinations case-insensitively", () => {
		const registry = new ApprovedExportPaths(win32);
		registry.approve("C:\\Users\\Me\\Videos\\Take.mp4");
		expect(registry.isApproved("c:\\users\\me\\videos\\take.mp4")).toBe(true);
		expect(registry.isApproved("C:\\Users\\Me\\Videos\\Other.mp4")).toBe(false);
	});

	it("forgets everything on clear", () => {
		const registry = new ApprovedExportPaths(posix);
		registry.approve("/home/me/Movies/take.mp4");
		registry.clear();
		expect(registry.isApproved("/home/me/Movies/take.mp4")).toBe(false);
	});
});

describe("cliExportDestinations", () => {
	it("takes --out exactly as the user typed it", () => {
		expect(
			cliExportDestinations({ projectPath: "/w/demo.openscreen", outPath: "/w/out.gif" }),
		).toEqual(["/w/out.gif"]);
	});

	it("covers both containers the runner may derive when --out is omitted", () => {
		// The format can come from the project file, which only the renderer reads,
		// so both candidates are approved rather than resolving the format twice.
		expect(cliExportDestinations({ projectPath: "/w/demo.openscreen", outPath: null })).toEqual([
			"/w/demo.mp4",
			"/w/demo.gif",
		]);
		expect(cliExportDestinations({ projectPath: "/w/demo.json", outPath: null })).toEqual([
			"/w/demo.mp4",
			"/w/demo.gif",
		]);
	});

	it("strips exactly what CliExportRunner.replaceExtension strips", () => {
		// `path.parse` would drop the ".demo" here and miss the real destination.
		expect(cliExportDestinations({ projectPath: "/w/my.demo.openscreen", outPath: null })).toEqual([
			"/w/my.demo.mp4",
			"/w/my.demo.gif",
		]);
		// An extension the runner does not strip is kept, exactly as the runner keeps it.
		expect(cliExportDestinations({ projectPath: "/w/demo.txt", outPath: null })).toEqual([
			"/w/demo.txt.mp4",
			"/w/demo.txt.gif",
		]);
	});

	it("has nothing to approve without a project", () => {
		expect(cliExportDestinations({ projectPath: null, outPath: null })).toEqual([]);
		expect(cliExportDestinations({})).toEqual([]);
	});
});
