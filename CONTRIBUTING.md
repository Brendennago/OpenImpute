# Contributing to OpenImpute

Thanks for helping! OpenImpute is a browser-based genotype imputation tool. Contributions from both developers and genetics people are welcome.

## Quick start

```bash
git clone https://github.com/Brendennago/OpenImpute.git
cd OpenImpute
npm install
npm run dev
```

Or open the repo in **GitHub Codespaces** (Code → Codespaces). The dev container installs everything for you.

You'll need a reference panel ZIP to test imputation. Download one from the [Releases page](https://github.com/Brendennago/OpenImpute/releases), or build one with [`scripts/panel/`](scripts/panel/README.md).

## Good places to start

- **Vendor parsers:** MyHeritage, FamilyTreeDNA, Living DNA, Nebula, and others. Each parser should detect the format from the header and output `{rsid, chrom, pos, genotype}`.
- **Gene/trait lookup entries:** map a gene or trait name to rsIDs, with a source link (dbSNP, ClinVar, a paper).
- **Visualisations:** a regional plot of measured vs imputed SNPs, and anchor-SNP weights.
- **Benchmarking:** leave-one-out concordance by MAF bin and population (see `docs/ROADMAP.md`, Phase 3).
- **Performance:** Web Worker offloading, and bit-packed panel blocks.

## Guidelines

- Run `npm run lint` before opening a PR.
- Keep PRs focused: one feature or fix per PR.
- For anything touching the imputation math, explain the change and, ideally, show before/after accuracy on a few known SNPs.
- **Never commit real personal genome files.** Use the sample/test data in the repo or public CC0 genomes (e.g. Personal Genome Project).
- Don't add wording that presents imputed results as diagnoses.

## Reporting bugs

Open an issue with:
- your browser and OS
- the vendor and chip version of your file (no need to share the file itself)
- the rsID you searched, and what you expected vs what you got
- any console errors (F12 → Console)

## License

By contributing, you agree your contributions are licensed under AGPL-3.0-or-later.
