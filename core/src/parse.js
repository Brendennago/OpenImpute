// Parsers for consumer raw DNA files. Pure JS, no Node/browser APIs.

const VENDOR_HINTS = [
  [/23andMe/i, '23andMe'],
  [/AncestryDNA/i, 'AncestryDNA'],
  [/MyHeritage/i, 'MyHeritage'],
  [/FamilyTreeDNA|FTDNA/i, 'FamilyTreeDNA'],
  [/Living ?DNA/i, 'LivingDNA'],
];

const CHROM_ALIASES = { '23': 'X', '24': 'Y', '25': 'XY', '26': 'MT', M: 'MT' };

/** Normalise a chromosome name to "1".."22","X","Y","MT" (no "chr" prefix). */
export function normChrom(c) {
  const s = String(c).replace(/^chr/i, '').toUpperCase();
  return CHROM_ALIASES[s] ?? s;
}

/**
 * Parse a raw data file's text.
 * @returns {{vendor:string, build:string, snps: Map<string,{rsid,chrom,pos,genotype:string|null}>}}
 * Map keys are lower-cased rsIDs. genotype is e.g. "AG", "A" (haploid) or null (no-call).
 */
export function parseRawDna(text) {
  const snps = new Map();
  let vendor = 'unknown';
  let build = 'unknown';
  let start = 0;
  const n = text.length;
  while (start < n) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = n;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    if (line[0] === '#') {
      if (vendor === 'unknown') for (const [re, name] of VENDOR_HINTS) if (re.test(line)) { vendor = name; break; }
      if (/build 37|GRCh37|hg19/i.test(line)) build = 'GRCh37';
      else if (/build 38|GRCh38|hg38/i.test(line)) build = 'GRCh38';
      else if (/build 36|hg18/i.test(line)) build = 'GRCh36';
      continue;
    }
    const cols = line.includes('\t') ? line.split('\t') : line.split(',').map((c) => c.replace(/^"|"$/g, ''));
    if (cols.length < 4 || /^rsid$/i.test(cols[0])) continue;
    const [rsid, chrom, pos, a, b] = cols;
    if (vendor === 'unknown' && /^RSID/i.test(line)) vendor = 'MyHeritage';
    // AncestryDNA: rsid chrom pos allele1 allele2 ; 23andMe: rsid chrom pos genotype
    let gt = (cols.length >= 5 && a.length === 1 && b.length === 1 ? a + b : a).toUpperCase();
    if (!/^[ACGT]{1,2}$/.test(gt)) gt = null; // no-calls (--, 00), indels (DI, II) etc.
    snps.set(rsid.toLowerCase(), { rsid, chrom: normChrom(chrom), pos: Number(pos), genotype: gt });
  }
  if (build === 'unknown' && snps.size > 0) build = 'GRCh37 (assumed)';
  return { vendor, build, snps };
}

/** Infer sex from chrX heterozygosity. */
export function inferSex(snps) {
  let x = 0, het = 0;
  for (const s of snps.values()) {
    if (s.chrom !== 'X' || !s.genotype) continue;
    x++;
    if (s.genotype.length === 2 && s.genotype[0] !== s.genotype[1]) het++;
  }
  if (x < 50) return { sex: 'unknown', chrXHeterozygosity: x ? het / x : null };
  const rate = het / x;
  return { sex: rate < 0.01 ? 'male' : 'female', chrXHeterozygosity: rate };
}

export function summarize(parsed) {
  const perChrom = {};
  let noCalls = 0;
  for (const s of parsed.snps.values()) {
    perChrom[s.chrom] = (perChrom[s.chrom] ?? 0) + 1;
    if (!s.genotype) noCalls++;
  }
  const total = parsed.snps.size;
  return {
    vendor: parsed.vendor,
    build: parsed.build,
    totalSnps: total,
    noCalls,
    callRate: total ? 1 - noCalls / total : 0,
    ...inferSex(parsed.snps),
    snpsPerChromosome: perChrom,
  };
}
