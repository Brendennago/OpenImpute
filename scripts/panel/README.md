# Building the OpenImpute reference panel

You **don't** need this to use OpenImpute. It's only for (re)building the reference panel from public data.

## Requirements

- macOS (`brew install bcftools htslib`) or Linux / WSL2 (`sudo apt install bcftools tabix curl`)
- **Disk:** ~0.5–1 TB free for a full build, since raw VCFs are hundreds of GB. An external NVMe SSD is fine.
- **RAM:** a few GB per parallel job. Everything is streamed.
- **WSL2:** keep `WORK_DIR` on the Linux filesystem (`~/...`), **not** `/mnt/c/...`.

## Quick start

```bash
cd scripts/panel
# 1. Check tools, disk space and that every download URL works
CHROMS=22 ./build_panel.sh check
# 2. Test run on chromosome 22 (smallest, ~30–60 min including download)
CHROMS=22 ./build_panel.sh build
# 3. Full build (hours; leave it running overnight)
JOBS=4 ./build_panel.sh build
```

Settings live in [`config.sh`](config.sh) and can also be overridden with environment variables (`WORK_DIR`, `CHROMS`, `JOBS`, `THREADS`, `TIERS`, `PANEL`).

> ⚠️ The download URLs in `config.sh` were written from memory and haven't been verified yet. Run `check` first. If a URL fails, look up the current filename in the source directory and update `config.sh`.

## What it does (per chromosome)

1. Downloads the panel VCF (1000 Genomes 30x by default) and Ensembl's variant VCF for rsIDs. Downloads are resumable and skipped if already present.
2. Splits multi-allelic sites, keeps biallelic SNPs that pass filters, and recomputes AF/MAF.
3. Annotates rsIDs, and drops variants without one (the app searches by rsID).
4. Writes one BCF per MAF tier (`common` ≥5%, `extended` ≥1%, `rare` ≥0.5%), plus a `sites.tsv.gz` index.
5. Deletes the raw panel VCF to save disk (`KEEP_RAW=1` keeps it).

At the end it writes `out/manifest.json` and `out/SHA256SUMS`.

## Status / next steps

- [ ] Verify the URLs (`check`) and run chr22 end to end
- [x] **Genome build:** outputs are GRCh38 and consumer files are GRCh37. Solved in `core/`, which matches user SNPs to the panel by rsID, with allele/strand checks.
- [ ] Use the output directly: `node core/bin/openimpute.js impute genome.zip --panel $WORK_DIR/out/common rs...`
- [ ] Convert the outputs into the app's format (currently the per-chromosome ZIPs from the original `convert_vcf` script), and later into bit-packed region blocks (see `docs/ROADMAP.md`, Phase 2.2)
- [ ] HGDP + 1KG support: set `PANEL=hgdp1kg` and `HGDP1KG_URL` once the gnomAD path is confirmed
- [ ] Indels
