import siteConfig from "@generated/docusaurus.config";

/**
 * Prefixes a root-absolute path under static/ with the site's baseUrl.
 *
 * This site is a GitHub Pages *project* page, so static files are served from
 * /Capturia/, not /. Docusaurus rewrites the paths it resolves itself — the
 * favicon, themeConfig.image, the navbar logo, router links — but a path written
 * by hand in JSX or emitted into Recreation/generated.ts is not one of those, and
 * silently 404s against the user page at the domain root.
 *
 * @docusaurus/useBaseUrl does the same job and is the right tool inside a
 * component; this exists because the scroll recreation assigns most of its
 * asset URLs imperatively (driver.ts), where a hook cannot be called.
 */
export function asset(path: string): string {
	return siteConfig.baseUrl + path.replace(/^\//, "");
}
