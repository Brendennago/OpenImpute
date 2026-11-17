---
name: openimpute
description: Inspect and explain a person's consumer raw DNA file (23andMe, AncestryDNA, MyHeritage, FTDNA). Use when the user shares or mentions a raw genotype file and asks what genotype they have at an rsID, gene or region, wants a summary of their file (SNP count, call rate, inferred sex, build), or wants to look up SNPs their chip didn't measure (imputation via OpenImpute).
---

# OpenImpute: working with raw DNA files

Use the bundled script to read the user's file. **Don't guess genotypes, and don't read huge raw files into context.**

```bash
node scripts/dna.mjs summary <file>                 # vendor, build, SNP count, call rate, inferred sex
node scripts/dna.mjs lookup  <file> rs4988235 rs1801133
node scripts/dna.mjs region  <file> 1 11845000 11870000   # measured SNPs in a region (file's build, usually GRCh37)
```

`<file>` can be the `.txt` or the `.zip` the vendor provides. Output is JSON.

## Workflow

1. Run `summary` first, and tell the user what file it is (vendor, build, number of SNPs, call rate).
2. For questions about specific variants, run `lookup`. Each result has a `status`:
   - `measured`: directly genotyped by the chip. Report the genotype.
   - `no_call`: on the chip, but the chip couldn't read it. Say so; don't guess.
   - `not_on_chip`: not measured. Explain that it can be **imputed** (predicted from nearby SNPs and a reference panel) with the OpenImpute web app: https://brendennago.github.io/OpenImpute/. Then say the result will be a prediction with a confidence score.
3. For a gene, find its coordinates **in the same build as the file** (usually GRCh37), then run `region`.

## How to report results

- Always say whether a genotype is **measured** or **imputed/predicted**, and give the confidence for imputed ones.
- Watch for strand: consumer files report alleles on the + strand of the reference. Papers and SNPedia sometimes use the other strand (e.g. A/G vs T/C). Check the alleles against dbSNP before interpreting.
- Give sources (dbSNP, ClinVar, gnomAD, the primary paper) for any claim about what a variant does.
- Explain effect sizes honestly. Most common variants have small effects.
- For high-impact clinical genes (e.g. BRCA1/2, APOE ε4, Lynch syndrome genes, HFE), give the facts calmly. Note that consumer chips and imputation are not diagnostic, and that clinical confirmation and a genetic counsellor are the right next step.
- Do not make diagnoses or treatment recommendations.

## Background, when the user asks

- Consumer chips genotype about 600k–700k SNPs. Imputation predicts other variants by finding reference genomes whose haplotypes match the user's around the target (OpenImpute uses a Li & Stephens-style weighted haplotype match against 1000 Genomes).
- Accuracy is highest for common variants in regions with dense chip coverage, and lower for rare variants and poorly covered regions (e.g. CYP2D6, HLA).
