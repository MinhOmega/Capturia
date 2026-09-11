// This fork's own repo, not upstream's: asking getopenscreen/openscreen whether
// Capturia is out of date offered the user an OpenScreen release as "the update"
// and linked them to upstream's tag page. `OFFICIAL_RELEASE_PREFIX` is the trust
// anchor for `officialReleaseUrl` below, so every URL here is built from one `REPO`.
const REPO = "MinhOmega/Capturia";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
// `/releases/latest` never returns a prerelease, so the opt-in channel reads the list.
// Newest first; one page is far more than the handful of RCs ahead of any stable.
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const OFFICIAL_RELEASE_PREFIX = `/${REPO}/releases/tag/`;

interface ReleaseResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

type FetchLatestRelease = (
	url: string,
	init: {
		headers: Record<string, string>;
		signal?: AbortSignal;
	},
) => Promise<ReleaseResponse>;

interface ParsedVersion {
	major: bigint;
	minor: bigint;
	patch: bigint;
	prerelease: string[];
	normalized: string;
}

function parseVersion(value: string): ParsedVersion {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
		value.trim(),
	);
	if (!match) throw new Error(`invalid semantic version: ${value}`);
	const prerelease = match[4]?.split(".") ?? [];
	const coreIdentifiers = [match[1], match[2], match[3]];
	if (
		[...coreIdentifiers, ...prerelease].some(
			(identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier[0] === "0",
		)
	) {
		throw new Error(`invalid semantic version: ${value}`);
	}
	const major = BigInt(match[1]);
	const minor = BigInt(match[2]);
	const patch = BigInt(match[3]);
	const core = `${major}.${minor}.${patch}`;
	return {
		major,
		minor,
		patch,
		prerelease,
		normalized: prerelease.length > 0 ? `${core}-${prerelease.join(".")}` : core,
	};
}

function comparePrerelease(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0) {
		return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
	}
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const a = left[i];
		const b = right[i];
		if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
		if (a === b) continue;
		const aNumeric = /^\d+$/.test(a);
		const bNumeric = /^\d+$/.test(b);
		if (aNumeric && bNumeric) return BigInt(a) > BigInt(b) ? 1 : -1;
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		return a > b ? 1 : -1;
	}
	return 0;
}

export function compareVersions(left: string, right: string): number {
	const a = parseVersion(left);
	const b = parseVersion(right);
	for (const key of ["major", "minor", "patch"] as const) {
		if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
	}
	return comparePrerelease(a.prerelease, b.prerelease);
}

function officialReleaseUrl(value: string, tag: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("untrusted release URL");
	}
	const encodedTag = url.pathname.slice(OFFICIAL_RELEASE_PREFIX.length);
	let decodedTag = "";
	try {
		decodedTag = decodeURIComponent(encodedTag);
	} catch {
		throw new Error("untrusted release URL");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.port !== "" ||
		!url.pathname.startsWith(OFFICIAL_RELEASE_PREFIX) ||
		decodedTag !== tag ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("untrusted release URL");
	}
	return url.toString();
}

export type UpdateCheckResult =
	| {
			kind: "available";
			currentVersion: string;
			latestVersion: string;
			releaseUrl: string;
	  }
	| {
			kind: "current";
			currentVersion: string;
			latestVersion: string;
	  };

type Release = { tag_name: string; html_url: string };

/**
 * The highest-versioned published release in a `/releases` page, prereleases included, or
 * null when there is none. Drafts, and tags that are not a version, are skipped rather than
 * failing the page: one odd entry must not hide the release beside it.
 */
function newestRelease(payload: unknown): Release | null {
	if (!Array.isArray(payload)) throw new Error("invalid GitHub release response");
	let newest: (Release & { version: string }) | null = null;
	for (const entry of payload) {
		const release = entry as Record<string, unknown> | null;
		if (
			typeof release?.tag_name !== "string" ||
			typeof release.html_url !== "string" ||
			release.draft !== false
		) {
			continue;
		}
		let version: string;
		try {
			version = parseVersion(release.tag_name).normalized;
		} catch {
			continue;
		}
		if (!newest || compareVersions(version, newest.version) > 0) {
			newest = { tag_name: release.tag_name, html_url: release.html_url, version };
		}
	}
	return newest && { tag_name: newest.tag_name, html_url: newest.html_url };
}

export async function checkLatestRelease(options: {
	currentVersion: string;
	fetchLatest: FetchLatestRelease;
	signal?: AbortSignal;
	/** Settings → "Get pre-release builds": RCs count as updates too. */
	includePrereleases?: boolean;
}): Promise<UpdateCheckResult> {
	const response = await options.fetchLatest(
		options.includePrereleases ? RELEASES_API : LATEST_RELEASE_API,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			...(options.signal ? { signal: options.signal } : {}),
		},
	);
	// GitHub answers 404 — not an empty body — when a repo has published no releases
	// at all, which is this fork's state today. That is "nothing newer exists", not a
	// failure: letting it fall through to the throw below put a modal ERROR dialog
	// ("GitHub release check failed (404)") in front of every user who pressed Check
	// for Updates. Reported as `current` so the honest "you are up to date" shows
	// instead. Every other non-2xx still throws — a 5xx really is a failed check.
	if (response.status === 404) {
		const current = parseVersion(options.currentVersion);
		return {
			kind: "current",
			currentVersion: current.normalized,
			latestVersion: current.normalized,
		};
	}
	if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`);

	const payload = await response.json();
	let release: Release | null;
	if (options.includePrereleases) {
		release = newestRelease(payload);
	} else {
		if (
			typeof payload !== "object" ||
			payload === null ||
			typeof (payload as Record<string, unknown>).tag_name !== "string" ||
			typeof (payload as Record<string, unknown>).html_url !== "string" ||
			(payload as Record<string, unknown>).draft !== false ||
			(payload as Record<string, unknown>).prerelease !== false
		) {
			throw new Error("invalid GitHub release response");
		}
		release = payload as Release;
	}
	const current = parseVersion(options.currentVersion);
	// An empty list means nothing is published yet: the same answer as the 404 above.
	if (!release) {
		return {
			kind: "current",
			currentVersion: current.normalized,
			latestVersion: current.normalized,
		};
	}
	const latest = parseVersion(release.tag_name);
	const comparison = compareVersions(latest.normalized, current.normalized);
	if (comparison <= 0) {
		return {
			kind: "current",
			currentVersion: current.normalized,
			latestVersion: latest.normalized,
		};
	}

	return {
		kind: "available",
		currentVersion: current.normalized,
		latestVersion: latest.normalized,
		releaseUrl: officialReleaseUrl(release.html_url, release.tag_name),
	};
}
