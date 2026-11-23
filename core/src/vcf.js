// Minimal VCF text parsing for reference panels. Pure JS.
import { MISSING } from './impute.js';

/** Returns sample names from the #CHROM header line. */
export function parseVcfHeader(line) {
  return line.trim().split('\t').slice(9);
}

const isBase = (s) => s.length === 1 && 'ACGT'.includes(s);

/**
 * Parse one VCF data line into a panel variant. Only biallelic SNPs are kept;
 * returns null for anything else.
 */
export function parseVcfLine(line, nSamples) {
  // Find the first 9 tab-separated fields without splitting the whole line.
  const f = [];
  let i = 0;
  for (let k = 0; k < 9; k++) {
    const j = line.indexOf('\t', i);
    if (j === -1) return null;
    f.push(line.slice(i, j));
    i = j + 1;
  }
  const [chrom, pos, id, ref, alt, , , , format] = f;
  if (!isBase(ref) || !isBase(alt)) return null;
  const gtIdx = format.split(':').indexOf('GT');
  if (gtIdx === -1) return null;

  const haps = new Uint8Array(2 * nSamples);
  let phased = true;
  let s = 0;
  const n = line.length;
  while (s < nSamples && i <= n) {
    let j = line.indexOf('\t', i);
    if (j === -1) j = n;
    let gt = line.slice(i, j);
    if (gtIdx > 0 || gt.includes(':')) gt = gt.split(':')[gtIdx] ?? '.';
    const a = gt.charCodeAt(0) - 48;
    if (gt.length === 1) {
      // haploid call: store as homozygous pair
      const v = a === 0 || a === 1 ? a : MISSING;
      haps[2 * s] = v;
      haps[2 * s + 1] = v;
    } else {
      const b = gt.charCodeAt(2) - 48;
      if (gt[1] !== '|') phased = false;
      haps[2 * s] = a === 0 || a === 1 ? a : MISSING;
      haps[2 * s + 1] = b === 0 || b === 1 ? b : MISSING;
    }
    s++;
    i = j + 1;
  }
  if (s !== nSamples) return null;
  return { chrom, pos: Number(pos), id, ref, alt, haps, phased };
}

/** Serialise a variant back to a VCF line (used for tests and simulated panels). */
export function formatVcfLine(v) {
  const gts = [];
  for (let s = 0; s < v.haps.length / 2; s++) {
    const a = v.haps[2 * s], b = v.haps[2 * s + 1];
    gts.push(`${a === MISSING ? '.' : a}${v.phased === false ? '/' : '|'}${b === MISSING ? '.' : b}`);
  }
  return [v.chrom, v.pos, v.id, v.ref, v.alt, '.', 'PASS', '.', 'GT', ...gts].join('\t');
}
