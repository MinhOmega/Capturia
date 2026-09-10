# Capturia docs site

Docusaurus 3 site. Lives in `website/` inside the monorepo. Deployed to GitHub Pages via `.github/workflows/docs.yml`.

## Develop

```sh
cd website
npm install
npm run dev      # http://localhost:3000/Capturia/
```

## Build

```sh
npm run build    # outputs to website/build/
npm run serve    # serves the built site locally
```

## Type-check

```sh
npm run typecheck
```

## Notes

- Site URL: <https://minhvo.is-a.dev/Capturia/>
- The base URL is `/Capturia/` because this is a GitHub Pages *project* page, served
  from a path rather than a domain root. Anything Docusaurus resolves itself picks that
  up; a hand-written absolute href does not and will 404 against the user page.
- Docs migration from `docs/` (root) → `website/docs/` happens in a follow-up PR. For now only the intro page is published.