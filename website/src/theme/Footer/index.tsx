import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import type { ReactNode } from "react";

import styles from "./styles.module.css";

/**
 * Custom footer matching "OpenScreen Docs Site.dc.html" 1:1 — a 1.4fr/1fr/1fr
 * three-column grid (brand + description, Project, Community) that the
 * default Docusaurus footer (Links/Logo/Copyright split) can't produce, so
 * this is a full swizzle-eject rather than a themeConfig-driven layout.
 */
export default function Footer(): ReactNode {
	const logoSrc = useBaseUrl("img/logo-icon.png");

	return (
		<footer className={styles.footer}>
			<div className={styles.inner}>
				<div className={styles.columns}>
					<div>
						<div className={styles.brand}>
							<img src={logoSrc} alt="" width={20} height={20} className={styles.brandLogo} />
							<span className={styles.brandName}>Capturia</span>
						</div>
						<p className={styles.brandDescription}>
							A free, open-source screen recorder and editor. MIT licensed.
						</p>
					</div>

					<div>
						<div className={styles.colTitle}>Project</div>
						<div className={styles.colLinks}>
							<Link href="https://github.com/MinhOmega/Capturia">GitHub</Link>
							<Link href="https://github.com/MinhOmega/Capturia/releases">Releases</Link>
						</div>
					</div>

					<div>
						<div className={styles.colTitle}>Community</div>
						<div className={styles.colLinks}>
							<Link href="https://github.com/MinhOmega/Capturia/blob/main/CONTRIBUTING.md">
								Contributing
							</Link>
							<Link href="https://github.com/MinhOmega/Capturia/blob/main/LICENSE">
								License (MIT)
							</Link>
						</div>
					</div>
				</div>

				<div className={styles.bottomBar}>
					<p>Capturia is released under the MIT license. Free, forever.</p>
				</div>
			</div>
		</footer>
	);
}
