# OpenImpute
A user-friendly, browser-based DNA imputation tool for analyzing direct-to-consumer genetic data (23andMe, Ancestry) locally.

## What This Does

You upload your raw DNA file (23andMe, Ancestry, etc.) and a reference panel. When you search for a SNP you don't have, it predicts your genotype based on the SNPs you do have nearby.

## How The Imputation Works

This uses a haplotype matching approach loosely based on the Li & Stephens model:

1. Find the target SNP's position in the reference panel
2. Load genotypes for a 5Mb window around the target (not the whole chromosome)
3. Find your SNPs within that window that overlap with the reference panel
4. For each reference sample, calculate how well your genotypes match theirs across the flanking variants
5. Weight matches by distance (closer SNPs matter more, using exponential decay based on recombination rate)
6. Each reference sample "votes" for the target genotype, weighted by how well they match you
7. Return the most likely genotype with a confidence score

For hemizygous chromosomes (X/Y in males), it detects sex by checking heterozygosity rate on chrX and returns single alleles instead of diploid calls.

## ⚠️ Speed Warning

**This is slow.** Here's what happens when you search for a SNP:

1. Search through 23 chromosome metadata files to find which chromosome has your SNP
2. Open the stored ZIP blob (hundreds of MB)
3. Stream through the compressed genotypes file looking for the specific line numbers needed
4. Decompress and parse ~10,000+ genotype lines for the 5Mb window
5. Run the matching algorithm across ~2,500 reference samples

First search on a chromosome takes 10-30+ seconds depending on your machine. Subsequent searches in the same region are faster since data is cached in memory.

The reference panel has ~7 million variants. The genotypes file alone is 17GB uncompressed. There's no way around the decompression time in a browser.

## ⚠️ Range Search Warning

The "Range Search" tab exists but **has not been tested with the current architecture** and is probably broken. Use single SNP search only for now.

## Features

- Runs 100% offline after initial setup
- Stores reference panel metadata in IndexedDB (~200MB)
- Loads genotypes on-demand from stored ZIP (no 17GB memory requirement)
- Detects male/female for proper X chromosome handling
- Uses up to 50 flanking variants for imputation
- Shows confidence scores and genotype probabilities

## Reference Panel Tiers

- **Common** (~7M variants, MAF ≥5%) - Recommended, ~500MB ZIP
- **Extended** (~12M variants, MAF ≥1%) - Larger, slower
- **Full** (all variants, no MAF filter) - Exists but completely untested, probably huge and may not work

## Installation

```bash
npm install
npm run dev
```

## Generating Reference Panels

### Step 1: Convert VCFs to per-chromosome ZIPs

```bash
node --max-old-space-size=24576 scripts/convert_vcf.js
```

This automatically downloads each chromosome's VCF from NCBI (if not already cached in `reference_panel/`), filters variants, and creates per-chromosome ZIPs for each tier in `public/reference_panels_by_chr/`.

Downloads are cached, so if you run it again it skips already-downloaded chromosomes.

### Step 2: Merge into final ZIPs

```bash
node scripts/merge_panels.js
```

This combines all per-chromosome ZIPs into the final reference panels in `public/reference_panels/`.

Output:
- `common_variants.zip` - ~500MB compressed, ~7M variants (MAF ≥5%)
- `extended_variants.zip` - ~800MB compressed, ~12M variants (MAF ≥1%)
- `full_variants.zip` - all variants, no MAF filter

## File Format Support

Accepts raw DNA files with this format:
```
rsid    chromosome    position    genotype
rs123   1             12345       AG
```

Works with 23andMe v5, AncestryDNA, and similar formats.

## Limitations

- Imputation accuracy depends heavily on how many of your SNPs overlap with the reference panel in the target region
- Some regions (like CYP2D6) are poorly covered on consumer chips, making imputation unreliable regardless of method
- This is not a replacement for proper imputation servers like Michigan or TOPMed if you need research-grade results
- Memory usage can spike when loading chromosome data

## License

AGPL-3.0-or-later
