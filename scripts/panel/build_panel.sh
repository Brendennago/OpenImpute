#!/usr/bin/env bash
# OpenImpute reference panel builder.
#
# Streams everything through bcftools one chromosome at a time, so it needs only
# a few GB of RAM per job. Disk space is the real limit.
#
# Usage:
#   ./build_panel.sh check        # verify tools, disk space and every URL
#   ./build_panel.sh build        # download + process all chromosomes in CHROMS
#   ./build_panel.sh chrom 22     # process one chromosome (used internally)
#   CHROMS=22 ./build_panel.sh build   # quick test run on chr22 only
#
# Output (in $WORK_DIR/out/<tier>/):
#   chr<N>.bcf (+ .csi)   biallelic SNPs with rsIDs, MAF >= tier cutoff, GRCh38
#   chr<N>.sites.tsv.gz   rsid  chrom  pos  ref  alt  af  (used for the app index)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

RAW="$WORK_DIR/raw"; TMP="$WORK_DIR/tmp"; OUT="$WORK_DIR/out"; LOGS="$WORK_DIR/logs"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

panel_url() {
  local chr="$1"
  case "$PANEL" in
    1kg30x)
      if [[ "$chr" == "X" ]]; then echo "$KG30X_URL_X"; else echo "${KG30X_URL//\{CHR\}/$chr}"; fi ;;
    hgdp1kg)
      [[ -n "$HGDP1KG_URL" ]] || die "Set HGDP1KG_URL in config.sh (see gnomAD downloads page)"
      echo "${HGDP1KG_URL//\{CHR\}/$chr}" ;;
    *) die "Unknown PANEL '$PANEL' (use 1kg30x or hgdp1kg)" ;;
  esac
}
dbsnp_url() { echo "${DBSNP_URL//\{CHR\}/$1}"; }

# Download a file plus its index, resumable, skipped if already complete.
fetch() {
  local url="$1" dest="$2"
  if [[ -s "$dest" && ! -e "$dest.part" ]]; then return 0; fi
  log "Downloading $(basename "$dest")"
  touch "$dest.part"
  curl -fL --retry 5 --retry-delay 10 -C - -o "$dest" "$url"
  rm -f "$dest.part"
  local idx
  for ext in tbi csi; do
    if curl -fsIL "$url.$ext" >/dev/null 2>&1; then
      curl -fL --retry 5 -o "$dest.$ext" "$url.$ext"; idx=1; break
    fi
  done
  [[ -n "${idx:-}" ]] || { log "No remote index for $(basename "$dest"); indexing locally"; bcftools index -t --threads "$THREADS" "$dest"; }
}

cmd_check() {
  local ok=1
  for t in bcftools tabix bgzip curl; do
    if command -v "$t" >/dev/null; then log "found $t: $(command -v "$t")"
    else log "MISSING: $t"; ok=0; fi
  done
  if [[ $ok == 0 ]]; then
    log "Install with:  macOS: brew install bcftools htslib   |   Ubuntu/WSL2: sudo apt install bcftools tabix curl"
  fi
  if command -v bcftools >/dev/null && ! bcftools plugin -l 2>/dev/null | grep -q fill-tags; then
    log "MISSING: bcftools fill-tags plugin (set BCFTOOLS_PLUGINS or reinstall bcftools)"; ok=0
  fi

  mkdir -p "$WORK_DIR"
  local free_gb
  free_gb=$(df -Pk "$WORK_DIR" | awk 'NR==2 {printf "%d", $4/1024/1024}')
  log "Free disk at $WORK_DIR: ${free_gb} GB"
  [[ "$WORK_DIR" == /mnt/* ]] && log "WARNING: $WORK_DIR is on a Windows drive; WSL2 I/O there is very slow."
  (( free_gb < 300 )) && log "WARNING: under 300 GB free; a full build may run out of space."

  for chr in $CHROMS; do
    for url in "$(panel_url "$chr")" "$(dbsnp_url "$chr")"; do
      if curl -fsIL --max-time 30 "$url" >/dev/null; then log "OK   $url"
      else log "FAIL $url"; ok=0; fi
    done
  done
  [[ $ok == 1 ]] && log "All checks passed." || die "Some checks failed. Fix config.sh and re-run."
}

cmd_chrom() {
  local chr="$1"
  mkdir -p "$RAW" "$TMP" "$OUT" "$LOGS"
  local panel="$RAW/panel.chr$chr.vcf.gz" snp="$RAW/dbsnp.chr$chr.vcf.gz"
  fetch "$(panel_url "$chr")" "$panel"
  fetch "$(dbsnp_url "$chr")" "$snp"

  # Ensembl names contigs "1"; the panel uses "chr1". Rename once.
  local snp_chr="$TMP/dbsnp.chr$chr.renamed.vcf.gz"
  if [[ ! -s "$snp_chr" ]]; then
    log "chr$chr: preparing rsID table"
    printf '%s\tchr%s\n' "$chr" "$chr" > "$TMP/rename.$chr.txt"
    bcftools view --threads "$THREADS" -G "$snp" -Ou \
      | bcftools norm -m -any -Ou \
      | bcftools view -v snps -Ou \
      | bcftools annotate --rename-chrs "$TMP/rename.$chr.txt" -x INFO -Oz -o "$snp_chr"
    bcftools index -t "$snp_chr"
  fi

  # Base: biallelic SNPs, PASS-only if FILTER is used, recomputed AF/MAF, rsIDs.
  local base="$TMP/base.chr$chr.bcf"
  if [[ ! -s "$base" ]]; then
    log "chr$chr: normalising, filtering to SNPs, annotating rsIDs"
    bcftools norm --threads "$THREADS" -m -any "$panel" -Ou \
      | bcftools view -v snps -m2 -M2 -f 'PASS,.' -Ou \
      | bcftools +fill-tags -Ou -- -t AF,AC,AN,MAF \
      | bcftools annotate -a "$snp_chr" -c ID -Ou \
      | bcftools view -i 'ID ~ "^rs"' -Ob -o "$base" --threads "$THREADS"
    bcftools index "$base"
  fi

  for tier in $TIERS; do
    local name="${tier%%:*}" maf="${tier##*:}"
    mkdir -p "$OUT/$name"
    local bcf="$OUT/$name/chr$chr.bcf"
    if [[ ! -s "$bcf" ]]; then
      log "chr$chr: tier $name (MAF >= $maf)"
      bcftools view --threads "$THREADS" -i "INFO/MAF>=$maf" "$base" -Ob -o "$bcf"
      bcftools index "$bcf"
      bcftools query -f '%ID\t%CHROM\t%POS\t%REF\t%ALT\t%INFO/AF\n' "$bcf" | bgzip > "$OUT/$name/chr$chr.sites.tsv.gz"
    fi
  done

  # Free disk: the raw panel is the largest file; keep it only if KEEP_RAW=1.
  [[ "${KEEP_RAW:-0}" == 1 ]] || rm -f "$panel" "$panel".tbi "$panel".csi
  log "chr$chr: done"
}

cmd_build() {
  mkdir -p "$LOGS"
  log "Building panel '$PANEL' for chromosomes: $CHROMS (jobs=$JOBS)"
  # shellcheck disable=SC2086
  printf '%s\n' $CHROMS | xargs -P "$JOBS" -I{} bash -c \
    '"$0" chrom {} > "$1/chr{}.log" 2>&1 && echo "chr{} ok" || echo "chr{} FAILED (see $1/chr{}.log)"' \
    "$SCRIPT_DIR/build_panel.sh" "$LOGS"
  log "Writing manifest"
  {
    echo "{"
    echo "  \"panel\": \"$PANEL\","
    echo "  \"build\": \"GRCh38\","
    echo "  \"created\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "  \"tiers\": \"$TIERS\""
    echo "}"
  } > "$OUT/manifest.json"
  (cd "$OUT" && find . -type f \( -name '*.bcf' -o -name '*.tsv.gz' \) -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
  log "Done. Outputs in $OUT"
}

case "${1:-}" in
  check) cmd_check ;;
  build) cmd_build ;;
  chrom) [[ -n "${2:-}" ]] || die "usage: $0 chrom <N>"; cmd_chrom "$2" ;;
  *) sed -n '2,17p' "$0"; exit 1 ;;
esac
