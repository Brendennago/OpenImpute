<div align="center">

# OpenImpute

**Your DNA chip measured ~600,000 SNPs. OpenImpute predicts millions more, and shows you how it did it.**

Genotype imputation for 23andMe / AncestryDNA raw data, running in your browser.
No command line, no account, no server queue.

[**▶ Try it in your browser**](https://brendennago.github.io/OpenImpute/) · [How it works](#how-the-imputation-works) · [Roadmap](docs/ROADMAP.md) · [Contributing](CONTRIBUTING.md)

![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Status](https://img.shields.io/badge/status-early%20development-orange)

</div>

---

## What it does

Consumer DNA tests only genotype a small, fixed set of markers. Most variants you read about (in papers, on SNPedia, in dbSNP) **aren't on your chip**. OpenImpute fills those gaps. Your measured SNPs are compared against a public reference panel of real human genomes (1000 Genomes). The tool finds the people whose DNA best matches yours around the variant, and predicts your genotype from theirs.

1. **Load** your raw data file (`.txt` or `.zip` from 23andMe, AncestryDNA, and similar).
2. **Search** for any rsID.
3. **Get** the genotype, labelled *measured* or *imputed*, with genotype probabilities and a confidence score.

## How it compares

| | Consumer report sites | Michigan / TOPMed servers | DIY Beagle / Minimac | **OpenImpute** |
|---|---|---|---|---|
| Imputes SNPs your chip missed | ✗ | ✓ | ✓ | ✓ |
| Setup | none | account, VCF conversion, QC, queue | command line, panels, phasing | **none** |
| Time to first answer | instant | hours | hours | **seconds to minutes** |
| Shows how each call was made | ✗ | ✗ | partly | **✓** (planned: full breakdown) |
| Free & open source | varies | free service | ✓ | ✓ |

OpenImpute is **not** a replacement for the Michigan or TOPMed servers if you need research-grade, genome-wide imputation. It's built for looking up specific variants quickly and transparently.

## How the imputation works

A haplotype-matching approach, loosely based on the Li & Stephens model:

1. Find the target SNP's position in the reference panel.
2. Load reference genotypes for a 5 Mb window around it.
3. Find your SNPs in that window that overlap with the panel.
4. Score how well each of the ~2,500 reference samples matches you across those flanking variants.
5. Weight each match by distance (closer SNPs matter more, with exponential decay based on recombination rate).
6. Each reference sample "votes" for the target genotype, weighted by how well it matches.
7. Return the most likely genotype with a confidence score and the full genotype probabilities.

For chrX in males (sex is inferred from chrX heterozygosity), it returns hemizygous single-allele calls.

## Reference panels

| Tier | Variants | Filter | Notes |
|------|----------|--------|-------|
| **Common** | ~7M | MAF ≥ 5% | Recommended, ~500 MB ZIP |
| Extended | ~12M | MAF ≥ 1% | Larger, slower |
| Full | all | none | Untested |

A larger, more diverse panel (HGDP + 1000 Genomes, ~4,100 people) with lower MAF tiers is planned. See the [roadmap](docs/ROADMAP.md#phase-25-a-bigger-better-reference-panel-weeks-3-6).

## Current limitations

- **Speed:** the first search on a chromosome takes 10–30 s while that region is decompressed. Later searches nearby are fast. Splitting the panel into small chunks is planned and should cut this to seconds.
- **Range Search** is experimental and probably broken. Use single-SNP search for now.
- Accuracy depends on how many of your SNPs fall near the target. Some regions (e.g. CYP2D6) are poorly covered by consumer chips, and imputation there is unreliable whatever method you use.
- Accuracy has been validated on simulated data (see [`core/`](core/README.md#accuracy)). Real-panel benchmarks are in progress.
- **Not medical advice.** Imputed genotypes are predictions.

## Supported files

```
rsid    chromosome    position    genotype
rs123   1             12345       AG
```

23andMe (v3–v5), AncestryDNA, and similar tab-separated raw data files (GRCh37).

## Running locally (developers)

```bash
npm install
npm run dev
```

Or click **Code → Codespaces → Create codespace** on GitHub to get a ready-to-run environment.

### Building reference panels yourself

You don't need to do this to use the app. It's only for regenerating or extending the panel. See [`scripts/panel/README.md`](scripts/panel/README.md) for the `bcftools`-based pipeline (macOS or Linux/WSL2, ~0.5–1 TB free disk).

## Command-line tool

The imputation engine is also available as a dependency-free Node.js CLI in [`core/`](core/README.md):

```bash
node core/bin/openimpute.js summary genome.zip
node core/bin/openimpute.js impute  genome.zip --panel <panel> rs429358 rs7412
node core/bin/openimpute.js benchmark --panel chr22.bcf --region chr22:20000000-21000000 --chip genome.zip
```

It uses a diploid Li & Stephens HMM, matches your SNPs to the panel by rsID (so GRCh37 files work with GRCh38 panels), and fixes strand flips. The `benchmark` command measures accuracy for *your* chip's SNP set.

## Use it with Claude

OpenImpute ships a Claude Code plugin with an Agent Skill. The skill bundles the engine, so Claude can summarise your raw DNA file, look up measured genotypes, impute missing ones against a local panel, and explain variants with sources:

```
/plugin marketplace add Brendennago/OpenImpute
/plugin install openimpute@openimpute
```

Then ask: *"Summarise my 23andMe file at ~/Downloads/genome.zip and impute rs429358 using the panel in ~/openimpute-panel/out/common."* An MCP server is planned.

## Contributing

Contributions are very welcome, especially new vendor file parsers, gene/trait lookup entries, visualisations, and benchmark work. See [CONTRIBUTING.md](CONTRIBUTING.md) and issues labelled `good first issue`.

## Data & citations

Reference data comes from the 1000 Genomes Project. See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## License

Code: [AGPL-3.0-or-later](LICENSE).
