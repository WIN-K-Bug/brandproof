# Development evidence is not part of this package

Screenshots, inspector reports and run logs produced during development are not included in the public source. They were made on fictional,
synthetic data and can be regenerated here: the browser scripts in `scripts/browser/` write their screenshots into this folder, and
`npm run ui-smoke-judge`, `npm run ui-smoke-layout` and the others are described in `docs/verification.md`. Where a document refers to a file in this
folder, that file is a development artefact, not something the code needs.
