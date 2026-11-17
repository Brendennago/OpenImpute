# OpenImpute panel build configuration.
# Edit this file, then run ./build_panel.sh
#
# IMPORTANT: the download URLs below have NOT been verified from the
# environment this script was written in. `./build_panel.sh check` HEAD-requests
# every URL and stops if any of them are wrong. Fix them here if so.

# Where all downloads and outputs go. Needs ~0.5–1 TB free for the full panel.
# On WSL2 keep this on the Linux filesystem (e.g. ~/openimpute-panel),
# NOT under /mnt/c, which is far slower.
WORK_DIR="${WORK_DIR:-$HOME/openimpute-panel}"

# Chromosomes to build. Start with "22" for a quick test run.
CHROMS="${CHROMS:-1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 X}"

# How many chromosomes to process at once. 4 is safe on 64 GB; 8 on 128 GB.
JOBS="${JOBS:-4}"

# Threads per bcftools process (compression/decompression).
THREADS="${THREADS:-2}"

# MAF tiers to produce: name:min_maf
TIERS="${TIERS:-common:0.05 extended:0.01 rare:0.005}"

# Which panel to build: 1kg30x (1000 Genomes high-coverage, 3,202 samples)
# or hgdp1kg (gnomAD HGDP + 1KG, ~4,100 samples; set HGDP1KG_URL first).
PANEL="${PANEL:-1kg30x}"

# --- Panel sources (GRCh38, "chr"-prefixed contigs) ---------------------------
# {CHR} is replaced with the chromosome number/letter (1..22, X).
KG30X_BASE="https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000G_2504_high_coverage/working/20220422_3202_phased_SNV_INDEL_SV"
KG30X_URL="${KG30X_BASE}/1kGP_high_coverage_Illumina.chr{CHR}.filtered.SNV_INDEL_SV_phased_panel.vcf.gz"
# chrX uses a different filename in that release. Check the directory listing.
KG30X_URL_X="${KG30X_BASE}/1kGP_high_coverage_Illumina.chrX.filtered.SNV_INDEL_SV_phased_panel.v2.vcf.gz"

# Fill this in from https://gnomad.broadinstitute.org/downloads (HGDP + 1KG section).
HGDP1KG_URL="${HGDP1KG_URL:-}"

# --- rsID annotation ---------------------------------------------------------
# Panel VCFs don't carry rsIDs, so we annotate them from Ensembl's per-chromosome
# variation VCFs (GRCh38, contigs named "1".."22","X", renamed automatically).
ENSEMBL_RELEASE="${ENSEMBL_RELEASE:-113}"
DBSNP_URL="https://ftp.ensembl.org/pub/release-${ENSEMBL_RELEASE}/variation/vcf/homo_sapiens/homo_sapiens-chr{CHR}.vcf.gz"
