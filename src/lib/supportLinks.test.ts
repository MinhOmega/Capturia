import { describe, expect, it } from "vitest";
import { buildIssueReportUrl, GITHUB_ISSUES_URL } from "./supportLinks";

// The one thing that must not regress: a report button that opens a URL GitHub
// refuses to serve is worse than no button, because the user only finds out
// after they have already decided to file the bug.
const MAX_URL_LENGTH = 7_500;

describe("buildIssueReportUrl", () => {
	it("points at this fork, not upstream", () => {
		expect(GITHUB_ISSUES_URL).toBe("https://github.com/MinhOmega/Capturia/issues");
		expect(buildIssueReportUrl({ title: "x" }).startsWith(`${GITHUB_ISSUES_URL}/new?`)).toBe(true);
	});

	it("round-trips a short report intact", () => {
		const url = new URL(buildIssueReportUrl({ title: "[Bug] ctx", bodyLines: ["a", "b"] }));
		expect(url.searchParams.get("title")).toBe("[Bug] ctx");
		expect(url.searchParams.get("body")).toBe("a\nb");
	});

	it("truncates an over-long body below the limit and says so", () => {
		const url = buildIssueReportUrl({
			title: "[Bug] ctx",
			bodyLines: Array.from({ length: 2_000 }, (_, i) => `stack frame ${i}`),
		});
		expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
		expect(new URL(url).searchParams.get("body")).toContain("[truncated:");
	});

	// Percent-encoding is why the budget can't be a character count: these expand
	// to nine bytes each, so a naive slice would sail past the limit.
	it("measures the encoded length, not the character count", () => {
		const url = buildIssueReportUrl({
			title: "[Bug] ctx",
			bodyLines: ["日本語のスタックトレース".repeat(2_000)],
		});
		expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
	});

	it("still returns an openable URL when there is nothing to report", () => {
		expect(buildIssueReportUrl({})).toBe(`${GITHUB_ISSUES_URL}/new`);
	});
});
