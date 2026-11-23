// Simulated panels and leave-one-out benchmarking. Pure JS.
import { imputeVariant, MISSING } from './impute.js';

function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASES = ['A', 'C', 'G', 'T'];

/**
 * Simulate a phased panel: each haplotype is a mosaic of a few founder
 * haplotypes (recombination) with a little mutation noise, which gives
 * realistic-looking LD blocks.
 */
export function simulatePanel({
  nSamples = 300, nSites = 2000, founders = 24, spacing = 500,
  switchRate = 0.003, mutationRate = 0.002, seed = 1, chrom = 'chr22',
} = {}) {
  const r = rng(seed);
  const nHaps = 2 * nSamples;
  const freqs = Array.from({ length: nSites }, () => Math.min(0.5, 0.01 + r() * r()));
  const founderAlleles = Array.from({ length: founders }, () => new Uint8Array(nSites));
  for (let f = 0; f < founders; f++) for (let i = 0; i < nSites; i++) founderAlleles[f][i] = r() < freqs[i] ? 1 : 0;

  const variants = [];
  for (let i = 0; i < nSites; i++) {
    let ref = BASES[Math.floor(r() * 4)];
    let alt = BASES[Math.floor(r() * 4)];
    while (alt === ref) alt = BASES[Math.floor(r() * 4)];
    variants.push({ chrom, pos: 100_000 + i * spacing, id: `rs${1_000_000 + i}`, ref, alt, haps: new Uint8Array(nHaps), phased: true });
  }
  for (let h = 0; h < nHaps; h++) {
    let f = Math.floor(r() * founders);
    for (let i = 0; i < nSites; i++) {
      if (r() < switchRate) f = Math.floor(r() * founders);
      let a = founderAlleles[f][i];
      if (r() < mutationRate) a ^= 1;
      variants[i].haps[h] = a;
    }
  }
  const samples = Array.from({ length: nSamples }, (_, s) => `SIM${String(s).padStart(4, '0')}`);
  return { variants, samples };
}

/** Build a userSnps map for panel sample `s`, keeping only variants where isChip(v) is true. */
export function maskSampleToUser(variants, s, isChip) {
  const user = new Map();
  for (const v of variants) {
    if (!isChip(v)) continue;
    const a = v.haps[2 * s], b = v.haps[2 * s + 1];
    if (a === MISSING || b === MISSING) continue;
    const gt = (a ? v.alt : v.ref) + (b ? v.alt : v.ref);
    user.set(String(v.id).toLowerCase(), { rsid: v.id, chrom: v.chrom, pos: v.pos, genotype: gt });
  }
  return user;
}

/**
 * Leave-one-out benchmark: for each test sample, hide everything except "chip"
 * variants, impute the hidden ones without that sample in the panel, and
 * compare with the truth.
 */
export function benchmarkLeaveOneOut(variants, { testSamples, isChip, maxTargets = Infinity, options = {}, onProgress } = {}) {
  const targets = variants.filter((v) => !isChip(v)).slice(0, maxTargets);
  const mafBins = [[0, 0.01], [0.01, 0.05], [0.05, 0.2], [0.2, 0.51]];
  const bins = mafBins.map(([lo, hi]) => ({ maf: `${lo}-${hi === 0.51 ? 0.5 : hi}`, n: 0, correct: 0, baselineCorrect: 0, sumX: 0, sumY: 0, sumXY: 0, sumXX: 0, sumYY: 0 }));
  const calib = [0.5, 0.7, 0.9, 0.99, 1.01].map((c, i, a) => ({ range: i ? `${a[i - 1]}-${Math.min(c, 1)}` : `0-${c}`, hi: c, n: 0, correct: 0 }));
  const totals = { n: 0, correct: 0, baselineCorrect: 0, highN: 0, highCorrect: 0 };

  let done = 0;
  for (const s of testSamples) {
    const user = maskSampleToUser(variants, s, isChip);
    const excludeSamples = new Set([s]);
    for (const t of targets) {
      const a = t.haps[2 * s], b = t.haps[2 * s + 1];
      if (a === MISSING || b === MISSING) continue;
      const truth = a + b;
      let n = 0, alt = 0;
      for (let h = 0; h < t.haps.length; h++) {
        if ((h >> 1) === s || t.haps[h] === MISSING) continue;
        n++; alt += t.haps[h];
      }
      const p = n ? alt / n : 0;
      const maf = Math.min(p, 1 - p);
      const baseline = p < 0.5 ? (2 * p * (1 - p) > (1 - p) ** 2 ? 1 : 0) : ((2 * p * (1 - p) > p * p) ? 1 : 2);
      const res = imputeVariant(t, variants, user, { ...options, excludeSamples });
      const probs = Object.values(res.probabilities);
      const call = probs.indexOf(Math.max(...probs));
      const ok = call === truth;
      const bin = bins.find((_, i) => maf >= mafBins[i][0] && maf < mafBins[i][1]);
      bin.n++; bin.correct += ok; bin.baselineCorrect += baseline === truth;
      bin.sumX += res.dosage; bin.sumY += truth; bin.sumXY += res.dosage * truth;
      bin.sumXX += res.dosage ** 2; bin.sumYY += truth ** 2;
      totals.n++; totals.correct += ok; totals.baselineCorrect += baseline === truth;
      if (res.confidenceLabel === 'high') { totals.highN++; totals.highCorrect += ok; }
      const c = calib.find((x) => res.confidence < x.hi);
      c.n++; c.correct += ok;
    }
    onProgress?.(++done, testSamples.length);
  }

  const r2 = (b) => {
    const cov = b.sumXY / b.n - (b.sumX / b.n) * (b.sumY / b.n);
    const vx = b.sumXX / b.n - (b.sumX / b.n) ** 2;
    const vy = b.sumYY / b.n - (b.sumY / b.n) ** 2;
    return vx > 0 && vy > 0 ? (cov * cov) / (vx * vy) : null;
  };
  const pct = (a, b) => (b ? +(a / b).toFixed(4) : null);
  return {
    testSamples: testSamples.length,
    targetsPerSample: targets.length,
    genotypesScored: totals.n,
    concordance: pct(totals.correct, totals.n),
    baselineConcordance: pct(totals.baselineCorrect, totals.n),
    highConfidenceFraction: pct(totals.highN, totals.n),
    highConfidenceConcordance: pct(totals.highCorrect, totals.highN),
    byMaf: bins.filter((b) => b.n).map((b) => ({
      maf: b.maf, n: b.n, concordance: pct(b.correct, b.n), baseline: pct(b.baselineCorrect, b.n),
      dosageR2: r2(b) === null ? null : +r2(b).toFixed(4),
    })),
    calibration: calib.filter((c) => c.n).map((c) => ({ confidence: c.range, n: c.n, observedAccuracy: pct(c.correct, c.n) })),
  };
}

/** Benchmark on a simulated panel (no data download needed). */
export function benchmarkSimulated({ chipEvery = 8, testSamples = 10, maxTargets = 400, sim = {}, options = {} } = {}) {
  const { variants } = simulatePanel(sim);
  const chip = new Set(variants.filter((_, i) => i % chipEvery === 0));
  const ids = Array.from({ length: testSamples }, (_, i) => i);
  return benchmarkLeaveOneOut(variants, { testSamples: ids, isChip: (v) => chip.has(v), maxTargets, options });
}
