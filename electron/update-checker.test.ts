import { describe, expect, it, vi } from "vitest";
import { checkLatestRelease, compareVersions } from "./update-checker";

function releaseResponse(payload: unknown, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: vi.fn().mockResolvedValue(payload),
	};
}

describe("compareVersions", () => {
	it("implements semantic version ordering for stable and prerelease builds", () => {
		expect(compareVersions("v2.0.0", "1.9.9")).toBeGreaterThan(0);
		expect(compareVersions("1.9.0", "1.9.0-rc.2")).toBeGreaterThan(0);
		expect(compareVersions("1.9.0-rc.10", "1.9.0-rc.2")).toBeGreaterThan(0);
		expect(compareVersions("1.9.0+build.2", "v1.9.0+build.1")).toBe(0);
	});

	it("preserves precision for oversized core identifiers", () => {
		expect(compareVersions("9007199254740993.0.0", "9007199254740992.0.0")).toBeGreaterThan(0);
	});

	it.each([
		"01.0.0",
		"1.02.0",
		"1.0.03",
		"1.0.0-rc.01",
	])("rejects leading-zero numeric identifiers in %s", (version) => {
		expect(() => compareVersions(version, "1.0.0")).toThrow("invalid semantic version");
	});
});

describe("checkLatestRelease", () => {
	it("reports a newer official stable release", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v1.10.0",
				html_url: "https://github.com/MinhOmega/Capturia/releases/tag/v1.10.0",
				draft: false,
				prerelease: false,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).resolves.toEqual({
			kind: "available",
			currentVersion: "1.9.0",
			latestVersion: "1.10.0",
			releaseUrl: "https://github.com/MinhOmega/Capturia/releases/tag/v1.10.0",
		});
		expect(fetchLatest).toHaveBeenCalledWith(
			"https://api.github.com/repos/MinhOmega/Capturia/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({ Accept: "application/vnd.github+json" }),
			}),
		);
	});

	it("reports current when the installed version is equal or newer", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v1.9.0",
				html_url: "https://github.com/MinhOmega/Capturia/releases/tag/v1.9.0",
				draft: false,
				prerelease: false,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.1", fetchLatest })).resolves.toEqual({
			kind: "current",
			currentVersion: "1.9.1",
			latestVersion: "1.9.0",
		});
		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).resolves.toEqual({
			kind: "current",
			currentVersion: "1.9.0",
			latestVersion: "1.9.0",
		});
	});

	it("forwards the cancellation signal", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v1.9.0",
				html_url: "https://github.com/MinhOmega/Capturia/releases/tag/v1.9.0",
				draft: false,
				prerelease: false,
			}),
		);
		const controller = new AbortController();

		await checkLatestRelease({
			currentVersion: "1.9.0",
			fetchLatest,
			signal: controller.signal,
		});

		expect(fetchLatest).toHaveBeenCalledWith(
			"https://api.github.com/repos/MinhOmega/Capturia/releases/latest",
			expect.objectContaining({ signal: controller.signal }),
		);
	});

	it.each([
		{ draft: true, prerelease: false },
		{ draft: false, prerelease: true },
	])("rejects draft and prerelease payloads: %o", async ({ draft, prerelease }) => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v2.0.0",
				html_url: "https://github.com/MinhOmega/Capturia/releases/tag/v2.0.0",
				draft,
				prerelease,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).rejects.toThrow(
			"invalid GitHub release response",
		);
	});

	it("rejects a release URL outside the official repository", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v9.9.9",
				html_url: "https://example.com/capturia-9.9.9.exe",
				draft: false,
				prerelease: false,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).rejects.toThrow(
			"untrusted release URL",
		);
	});

	it.each([
		"https://github.com/MinhOmega/Capturia/releases/download/v9.9.9/app.zip",
		"https://github.com/MinhOmega/Capturia/releases/tag/v9.9.8",
		"https://github.com/MinhOmega/Capturia/releases/tag/v9.9.9?download=1",
		"https://github.com/MinhOmega/Capturia/releases/tag/v9.9.9#notes",
	])("rejects an invalid official-repository URL: %s", async (htmlUrl) => {
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v9.9.9",
				html_url: htmlUrl,
				draft: false,
				prerelease: false,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).rejects.toThrow(
			"untrusted release URL",
		);
	});

	it("rejects unsuccessful or malformed GitHub responses", async () => {
		const unavailable = vi.fn().mockResolvedValue(releaseResponse({}, 503));
		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest: unavailable }),
		).rejects.toThrow("GitHub release check failed (503)");

		const malformed = vi.fn().mockResolvedValue(releaseResponse({ tag_name: "v2.0.0" }));
		await expect(
			checkLatestRelease({ currentVersion: "1.9.0", fetchLatest: malformed }),
		).rejects.toThrow("invalid GitHub release response");
	});

	it("treats a repository with no releases (404) as current rather than an error", async () => {
		// GitHub 404s /releases/latest when nothing has been published. Throwing here
		// put a modal error dialog in front of anyone who pressed Check for Updates.
		const noReleases = vi.fn().mockResolvedValue(releaseResponse({}, 404));

		await expect(
			checkLatestRelease({ currentVersion: "2.0.0", fetchLatest: noReleases }),
		).resolves.toEqual({
			kind: "current",
			currentVersion: "2.0.0",
			latestVersion: "2.0.0",
		});
	});

	it("no longer trusts a release URL from the upstream repository", async () => {
		// The trust anchor moved to this fork with the API URL; a well-formed upstream
		// tag page must not survive the move, or the rebrand only went halfway.
		const fetchLatest = vi.fn().mockResolvedValue(
			releaseResponse({
				tag_name: "v9.9.9",
				html_url: "https://github.com/getopenscreen/openscreen/releases/tag/v9.9.9",
				draft: false,
				prerelease: false,
			}),
		);

		await expect(checkLatestRelease({ currentVersion: "1.9.0", fetchLatest })).rejects.toThrow(
			"untrusted release URL",
		);
	});
});

describe("checkLatestRelease with pre-release builds", () => {
	const release = (tag: string, extra: Record<string, unknown> = {}) => ({
		tag_name: tag,
		html_url: `https://github.com/MinhOmega/Capturia/releases/tag/${tag}`,
		draft: false,
		prerelease: tag.includes("-"),
		...extra,
	});

	it("reads this repository's release list and offers a newer RC", async () => {
		const fetchLatest = vi
			.fn()
			.mockResolvedValue(
				releaseResponse([release("v2.0.0-rc.3"), release("v2.0.0-rc.2"), release("v1.9.6")]),
			);

		await expect(
			checkLatestRelease({ currentVersion: "1.9.6", fetchLatest, includePrereleases: true }),
		).resolves.toEqual({
			kind: "available",
			currentVersion: "1.9.6",
			latestVersion: "2.0.0-rc.3",
			releaseUrl: "https://github.com/MinhOmega/Capturia/releases/tag/v2.0.0-rc.3",
		});
		expect(fetchLatest).toHaveBeenCalledWith(
			"https://api.github.com/repos/MinhOmega/Capturia/releases?per_page=30",
			expect.anything(),
		);
	});

	it("asks only for the latest stable when the setting is off", async () => {
		const fetchLatest = vi.fn().mockResolvedValue(releaseResponse(release("v1.9.6")));
		await checkLatestRelease({ currentVersion: "1.9.6", fetchLatest, includePrereleases: false });
		expect(fetchLatest).toHaveBeenCalledWith(
			"https://api.github.com/repos/MinhOmega/Capturia/releases/latest",
			expect.anything(),
		);
	});

	it("moves an RC install on to the next RC, then to the stable", async () => {
		const nextRc = vi.fn().mockResolvedValue(releaseResponse([release("v2.0.0-rc.3")]));
		await expect(
			checkLatestRelease({
				currentVersion: "2.0.0-rc.2",
				fetchLatest: nextRc,
				includePrereleases: true,
			}),
		).resolves.toMatchObject({ kind: "available", latestVersion: "2.0.0-rc.3" });

		const stable = vi
			.fn()
			.mockResolvedValue(releaseResponse([release("v2.0.0"), release("v2.0.0-rc.3")]));
		await expect(
			checkLatestRelease({
				currentVersion: "2.0.0-rc.3",
				fetchLatest: stable,
				includePrereleases: true,
			}),
		).resolves.toMatchObject({ kind: "available", latestVersion: "2.0.0" });
	});

	it("picks by version rather than list order, skipping drafts and non-version tags", async () => {
		const fetchLatest = vi
			.fn()
			.mockResolvedValue(
				releaseResponse([
					release("v1.9.7-rc.1"),
					release("v3.0.0", { draft: true }),
					release("nightly"),
					{ tag_name: "v4.0.0" },
					release("v2.0.1"),
				]),
			);

		await expect(
			checkLatestRelease({ currentVersion: "2.0.0", fetchLatest, includePrereleases: true }),
		).resolves.toMatchObject({ kind: "available", latestVersion: "2.0.1" });
	});

	it("reports current when nothing newer, or nothing at all, is published", async () => {
		const olderRc = vi.fn().mockResolvedValue(releaseResponse([release("v2.0.0-rc.3")]));
		await expect(
			checkLatestRelease({
				currentVersion: "2.0.0",
				fetchLatest: olderRc,
				includePrereleases: true,
			}),
		).resolves.toEqual({ kind: "current", currentVersion: "2.0.0", latestVersion: "2.0.0-rc.3" });

		const empty = vi.fn().mockResolvedValue(releaseResponse([]));
		await expect(
			checkLatestRelease({ currentVersion: "2.0.0", fetchLatest: empty, includePrereleases: true }),
		).resolves.toEqual({ kind: "current", currentVersion: "2.0.0", latestVersion: "2.0.0" });
	});

	it("still refuses a malformed list or a release URL outside this repository", async () => {
		const notAList = vi.fn().mockResolvedValue(releaseResponse(release("v9.9.9")));
		await expect(
			checkLatestRelease({
				currentVersion: "1.9.0",
				fetchLatest: notAList,
				includePrereleases: true,
			}),
		).rejects.toThrow("invalid GitHub release response");

		const foreign = vi.fn().mockResolvedValue(
			releaseResponse([
				release("v9.9.9-rc.1", {
					html_url: "https://github.com/someone-else/fork/releases/tag/v9.9.9-rc.1",
				}),
			]),
		);
		await expect(
			checkLatestRelease({
				currentVersion: "1.9.0",
				fetchLatest: foreign,
				includePrereleases: true,
			}),
		).rejects.toThrow("untrusted release URL");
	});
});
