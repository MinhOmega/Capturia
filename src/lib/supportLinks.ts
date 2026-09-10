// Where a bug report actually lands. THIS fork's repo, not the project Capturia
// was forked from: the website download links and the update checker each shipped
// pointing upstream, and both sent real users somewhere that knew nothing about
// this app. Any URL added here gets the same scrutiny.
export const GITHUB_REPO_URL = "https://github.com/MinhOmega/Capturia";
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;

// GitHub answers a prefilled `/issues/new` with 414 once the URL grows past
// roughly 8 KB, and a diagnostic body -- a stack plus serialised details -- passes
// that on its own. Staying under the limit is what keeps the button working at
// all: an over-long URL doesn't degrade, it fails to open.
const MAX_URL_LENGTH = 7_500;

// Long enough to say what went wrong, short enough that even fully
// percent-encoded it cannot be the reason the URL is over the limit -- which is
// what lets the body be the only thing this module has to measure.
const MAX_TITLE_LENGTH = 200;

const TRUNCATION_NOTE =
	"\n\n[truncated: some diagnostic details were omitted to keep this link openable]";

function issueUrl(title: string, body: string): string {
	const params = new URLSearchParams();
	if (title) params.set("title", title);
	if (body) params.set("body", body);
	const query = params.toString();
	return query ? `${GITHUB_ISSUES_URL}/new?${query}` : `${GITHUB_ISSUES_URL}/new`;
}

/**
 * A prefilled "new issue" URL that GitHub will actually serve.
 *
 * The body is trimmed by binary search over the ENCODED length rather than by a
 * character budget, because `URLSearchParams` percent-encodes: a newline costs
 * three characters, a CJK frame in a stack trace nine. The encoded length is not
 * a function of the plain one, so slicing to a fixed count either overshoots the
 * limit or throws away detail that would have fit.
 */
export function buildIssueReportUrl(input: { title?: string; bodyLines?: string[] }): string {
	const title = (input.title?.trim() ?? "").slice(0, MAX_TITLE_LENGTH);
	const body = (input.bodyLines ?? []).join("\n").trim();

	const full = issueUrl(title, body);
	if (full.length <= MAX_URL_LENGTH) return full;

	// Longest prefix of the body that still fits once the note is appended.
	let low = 0;
	let high = body.length;
	let best = "";
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = `${body.slice(0, mid).trimEnd()}${TRUNCATION_NOTE}`;
		if (issueUrl(title, candidate).length <= MAX_URL_LENGTH) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	// `best` stays empty only if the note alone doesn't fit, which the title cap
	// above rules out -- but an empty body is still an openable issue, and a
	// report the user can type into beats no report.
	return issueUrl(title, best);
}
