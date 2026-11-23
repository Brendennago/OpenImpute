---
name: openimpute
description: Inspect, look up and impute genotypes from a person's consumer raw DNA file (23andMe, AncestryDNA, MyHeritage, FTDNA). Use when the user shares or mentions a raw genotype file and asks what genotype they have at an rsID, wants a summary of their file (SNP count, call rate, inferred sex, build), or wants SNPs their chip didn't measure predicted (imputed) from a reference panel.
---

# OpenImpute: working with raw DNA files

Use the bundled engine (Node 18+, no install step). **Don't guess genotypes, and don't read large raw files into context.**

```bash
E=engine/bin/openimpute.js   # relative to this skill's directory
node $E summary <dna-file>                                 # vendor, build, SNP count, call rate, inferred sex
node $E lookup  <dna-file> rs4988235 rs1801133             # measured genotypes only
node $E impute  <dna-file> --panel <panel> --json rs429358 # measured, or imputed if not on the chip
```

- `<dna-file>` can be the vendor's `.txt` or `.zip`.
- `<panel>` is a reference panel: a VCF/VCF.gz/BCF file, or a directory built by OpenImpute's `scripts/panel/build_panel.sh`. Ask the user where theirs is. Reading `.bcf` needs `bcftools` installed.
- Add `--populations <file>` (a 1000 Genomes sample panel file) to see which populations the best-matching reference people come from.
- If there is no panel, run `lookup` and say that SNPs not on the chip can be imputed with the OpenImpute web app (https://brendennago.github.io/OpenImpute/) or by downloading a panel.

## Workflow

1. Run `summary` first and tell the user what the file is.
2. For specific variants, run `impute` (or `lookup` if there's no panel). Each result has a `status`:
   - `measured`: directly genotyped by the chip.
   - `imputed`: predicted. Report `genotype`, `confidence` / `confidenceLabel`, and the probabilities. Mention how much evidence it used (`anchorsUsed` nearby SNPs).
   - `no_call`: on the chip, but unreadable. Don't guess.
   - `not_in_panel`: neither measured nor imputable with this panel.
3. Male chrX results are haploid (a single allele). That's expected.

## How to report results

- Always say whether a genotype is **measured** or **imputed**, and give the confidence for imputed ones. Treat `low` confidence results as "unknown", not as answers.
- Alleles are reported on the reference + strand. Papers and SNPedia sometimes use the opposite strand (A/G vs T/C), so check against dbSNP before interpreting.
- Give sources (dbSNP, ClinVar, gnomAD, the primary paper) for any claim about what a variant does. Be honest about effect sizes; most common variants have small effects.
- For high-impact clinical genes (BRCA1/2, APOE ε4, Lynch syndrome genes, HFE, etc.), state the facts calmly. Make clear that chip data and imputation are not diagnostic and need clinical confirmation, and suggest a genetic counsellor. No diagnoses or treatment advice.

## Background, when the user asks

Consumer chips genotype about 600k–700k SNPs. OpenImpute predicts other variants with a diploid Li & Stephens hidden Markov model. It models the person's two haplotypes as mosaics of reference-panel haplotypes, uses the person's nearby measured SNPs as evidence, and reads off the genotype at the target. User SNPs are matched to the panel by rsID, with strand flips corrected, so GRCh37 files work with GRCh38 panels. Accuracy is highest for common variants in well-covered regions, and lower for rare variants and regions like HLA or CYP2D6.
