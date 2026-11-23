# @openimpute/core

The OpenImpute imputation engine: parsers for consumer raw DNA files, plus a diploid **Li & Stephens HMM** that predicts genotypes your chip didn't measure from a phased reference panel. Plain JavaScript with no dependencies. It runs in Node 18+ and the browser.

## Command line

```bash
node bin/openimpute.js summary  genome.zip
node bin/openimpute.js lookup   genome.zip rs4988235
node bin/openimpute.js impute   genome.zip --panel ~/openimpute-panel/out/common rs429358 rs7412
node bin/openimpute.js bench-sim                      # accuracy on a simulated panel, no data needed
node bin/openimpute.js benchmark --panel chr22.bcf --region chr22:20000000-21000000 --chip genome.zip
```

`--panel` takes a VCF/VCF.gz/BCF file or a directory built by [`scripts/panel/build_panel.sh`](../scripts/panel/README.md). BCF files and indexed region queries use `bcftools` if it's installed; plain VCF and VCF.gz files are read directly.

`benchmark --chip genome.zip` masks panel people down to **exactly the SNPs on your chip**, then measures how accurately the rest are recovered (leave-one-out). That's an honest estimate for your file type.

## How it works

1. **Match by rsID.** Your SNPs are matched to panel variants by rsID, not position, so GRCh37 raw files work with GRCh38 panels. Alleles are checked, and strand flips are fixed (ambiguous A/T and C/G SNPs can't be flipped and are taken as-is).
2. **Anchors.** The nearest (default 50) of your measured SNPs within ±1 Mb of the target.
3. **Pre-filter.** Rank all panel haplotypes by distance-weighted mismatches at your homozygous anchors, and keep the top K (default 120).
4. **Diploid Li & Stephens HMM** over ordered pairs of those K haplotypes. Your two haplotypes are modelled as mosaics of reference haplotypes. The switch probability between anchors is `1 − exp(−d / 100 kb)`, and the emission allows for genotype error. Forward passes run from the left and right anchors toward the target, and their product gives the posterior over haplotype pairs at the target.
5. **Genotype probabilities** come from summing the posterior by the pair's alleles at the target, mixed with 2% of the Hardy–Weinberg prior from the panel allele frequency. You get a genotype, probabilities, a dosage, a calibrated confidence (High ≥ 90%, Medium ≥ 70%), and diagnostics: anchors used, effective number of matches, and the best-matching reference people.
6. **Male chrX** is reported as haploid.

With unphased panels it falls back to weighting whole diploid reference samples.

## Accuracy

**Simulated panel** (`bench-sim`: 300 people, mosaic haplotypes, 1 in 8 sites "on the chip", leave-one-out). These numbers check that the method works. They are **not** real-world accuracy:

| | Result |
|---|---|
| Concordance | ~93–98% (baseline of guessing the most common genotype: ~72%) |
| High-confidence calls | ~75% of calls, ~98–99% correct |
| Calibration | calls stated at 90–99% confidence are right ~97% of the time |

Real-panel numbers (1000 Genomes 30x, using real 23andMe/Ancestry SNP sets) will go into `docs/BENCHMARK.md` once the panel is built. Run `benchmark` on chr22 to get them.

## Library use

```js
import { parseRawDna, imputeVariant } from '@openimpute/core';
const dna = parseRawDna(text);                         // browser: text from a File
const result = imputeVariant(target, regionVariants, dna.snps);
```

Panel variants are `{ chrom, pos, id, ref, alt, haps: Uint8Array(2·nSamples), phased }`. Use `parseVcfLine`, or `openPanel()` from `@openimpute/core/node`.

## Tests

```bash
npm test
```

The tests cover the parsers (23andMe, AncestryDNA, MyHeritage), strand alignment, VCF parsing, `.zip` input, an end-to-end run with deliberately mismatched coordinates and strand-flipped SNPs, the CLI, and an accuracy floor on simulated data.
