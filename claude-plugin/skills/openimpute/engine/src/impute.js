// Haplotype-matching genotype imputation (Li & Stephens-flavoured).
// Pure JS, runs in Node and the browser.
//
// Panel variants have the shape:
//   { chrom, pos, id, ref, alt, haps: Uint8Array(2 * nSamples), phased: boolean }
// haps[2*s] and haps[2*s+1] are sample s's two alleles (0 = ref, 1 = alt, 255 = missing).
// Haploid calls (male chrX) are stored as a homozygous pair.
//
// Positions only need to be consistent within the panel. User SNPs are matched
// to panel variants by rsID, so a GRCh37 raw file works with a GRCh38 panel.

export const MISSING = 255;
const COMP = { A: 'T', T: 'A', C: 'G', G: 'C' };

export const DEFAULTS = {
  maxAnchors: 50,      // nearest overlapping SNPs used as evidence
  windowBp: 1_000_000, // only consider anchors within ±windowBp of the target
  decayBp: 150_000,    // anchor weight for the haplotype pre-filter (and unphased mode) = exp(-distance / decayBp)
  errorRate: 0.01,     // genotype mismatch probability per anchor
  topHaplotypes: 120,  // haplotypes kept for the HMM (phased panels); cost grows with K²
  switchScaleBp: 100_000, // HMM: probability of switching template haplotype = 1 - exp(-d / switchScaleBp)
  priorWeight: 0.02,   // mix-in of the HWE prior from panel allele frequency
  dropAmbiguous: false // drop A/T and C/G anchors (strand can't be checked)
};

export const isAmbiguous = (ref, alt) => COMP[ref] === alt;

/**
 * Convert a user genotype string ("AG", "A") to alt-allele dosage for a panel
 * variant, fixing strand flips. Returns { dosage, flipped } or null if the
 * alleles can't be reconciled.
 */
export function alignGenotype(genotype, ref, alt) {
  if (!genotype) return null;
  const letters = genotype.length === 1 ? genotype + genotype : genotype;
  const count = (ls) => {
    let d = 0;
    for (const l of ls) {
      if (l === alt) d++;
      else if (l !== ref) return -1;
    }
    return d;
  };
  let d = count(letters);
  if (d >= 0) return { dosage: d, flipped: false };
  if (isAmbiguous(ref, alt)) return null;
  d = count([...letters].map((l) => COMP[l]));
  return d >= 0 ? { dosage: d, flipped: true } : null;
}

function alleleFreq(v) {
  let n = 0, a = 0;
  for (const h of v.haps) if (h !== MISSING) { n++; a += h; }
  return n ? a / n : 0;
}

function hwe(p) {
  const q = 1 - p;
  return [q * q, 2 * p * q, p * p];
}

/**
 * Pick anchors: panel variants (other than the target) that the user genotyped,
 * nearest first.
 */
export function selectAnchors(variants, target, userSnps, opts) {
  const out = [];
  let flips = 0, mismatches = 0, ambiguousDropped = 0;
  for (const v of variants) {
    if (v === target || v.pos === target.pos) continue;
    const dist = Math.abs(v.pos - target.pos);
    if (dist > opts.windowBp) continue;
    const u = userSnps.get(String(v.id).toLowerCase());
    if (!u || !u.genotype) continue;
    if (opts.dropAmbiguous && isAmbiguous(v.ref, v.alt)) { ambiguousDropped++; continue; }
    const al = alignGenotype(u.genotype, v.ref, v.alt);
    if (!al) { mismatches++; continue; }
    if (al.flipped) flips++;
    out.push({ v, dosage: al.dosage, dist, weight: Math.exp(-dist / opts.decayBp) });
  }
  out.sort((a, b) => a.dist - b.dist);
  return { anchors: out.slice(0, opts.maxAnchors), flips, mismatches, ambiguousDropped, available: out.length };
}

function logLik(diff, logE) {
  // diff = |user dosage - reference dosage|
  return diff === 0 ? logE.match : diff === 1 ? logE.one : logE.two;
}

/**
 * Impute the target variant for a user.
 * @param {object} target    panel variant to impute
 * @param {object[]} variants panel variants in the surrounding region (may include target)
 * @param {Map} userSnps     from parseRawDna().snps
 * @param {object} [options] see DEFAULTS, plus { haploid, samples: string[], populations: Map, excludeSamples: Set<number> }
 */
export function imputeVariant(target, variants, userSnps, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nHaps = target.haps.length;
  const nSamples = nHaps / 2;
  const excluded = opts.excludeSamples; // Set of sample indices (leave-one-out benchmarks)
  const sel = selectAnchors(variants, target, userSnps, opts);
  const { anchors } = sel;
  const p = alleleFreq(target);
  const prior = hwe(p);

  const base = {
    id: target.id, chrom: target.chrom, pos: target.pos, ref: target.ref, alt: target.alt,
    panelAltFreq: p,
    anchorsUsed: anchors.length,
    anchorsAvailable: sel.available,
    strandFlipsFixed: sel.flips,
    alleleMismatchesDropped: sel.mismatches,
  };

  let probs;
  let method;
  let effectiveMatches = 0;
  let topMatches = [];

  if (anchors.length === 0) {
    probs = prior.slice();
    method = 'allele-frequency-only';
  } else {
    const e = opts.errorRate;
    const logE = { match: Math.log(1 - e), one: Math.log(e), two: 2 * Math.log(e) };
    const phased = target.phased !== false && anchors.every((a) => a.v.phased !== false);
    const acc = [0, 0, 0];
    const sampleWeight = new Float64Array(nSamples);

    if (phased) {
      method = 'li-stephens-hmm';
      // 1) Score each haplotype by weighted homozygous mismatches (cheap filter).
      const score = new Float64Array(nHaps);
      for (const a of anchors) {
        if (a.dosage === 1) continue;
        const want = a.dosage === 2 ? 1 : 0;
        const haps = a.v.haps;
        for (let h = 0; h < nHaps; h++) {
          const x = haps[h];
          if (x !== MISSING && x !== want) score[h] += a.weight;
        }
      }
      const order = Array.from({ length: nHaps }, (_, i) => i)
        .filter((h) => target.haps[h] !== MISSING && !excluded?.has(h >> 1))
        .sort((x, y) => score[x] - score[y])
        .slice(0, Math.min(opts.topHaplotypes, nHaps));

      // 2) Diploid Li & Stephens HMM over ordered pairs of the top K haplotypes.
      //    Run forward from the left anchors and from the right anchors toward the
      //    target; the posterior at the target is proportional to their product.
      const K = order.length;
      const hapIdx = Int32Array.from(order);
      const left = anchors.filter((x) => x.v.pos < target.pos).sort((x, y) => x.v.pos - y.v.pos);
      const right = anchors.filter((x) => x.v.pos > target.pos).sort((x, y) => y.v.pos - x.v.pos);
      const em = [Math.exp(logE.match), Math.exp(logE.one), Math.exp(logE.two)];
      const sweep = (side) => {
        const alpha = new Float64Array(K * K).fill(1 / (K * K));
        const row = new Float64Array(K), col = new Float64Array(K);
        const alleles = new Uint8Array(K);
        let prevPos = null;
        const step = (toPos) => {
          if (prevPos === null) return;
          const rho = 1 - Math.exp(-Math.abs(toPos - prevPos) / opts.switchScaleBp);
          if (rho <= 0) return;
          row.fill(0); col.fill(0);
          let tot = 0;
          for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
            const x = alpha[i * K + j];
            row[i] += x; col[j] += x; tot += x;
          }
          const a = (1 - rho) * (1 - rho), b = ((1 - rho) * rho) / K, c = (rho / K) * (rho / K) * tot;
          for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) {
            alpha[i * K + j] = a * alpha[i * K + j] + b * (row[i] + col[j]) + c;
          }
        };
        for (const an of side) {
          step(an.v.pos);
          prevPos = an.v.pos;
          for (let i = 0; i < K; i++) alleles[i] = an.v.haps[hapIdx[i]];
          const e0 = Math.pow(em[0], an.weight), e1 = Math.pow(em[1], an.weight), e2 = Math.pow(em[2], an.weight);
          const ew = [e0, e1, e2];
          let z = 0;
          for (let i = 0; i < K; i++) {
            const x = alleles[i];
            for (let j = 0; j < K; j++) {
              const y = alleles[j];
              const k = i * K + j;
              if (x === MISSING || y === MISSING) { z += alpha[k]; continue; }
              alpha[k] *= ew[Math.abs(an.dosage - (x + y))];
              z += alpha[k];
            }
          }
          if (z > 0) for (let k = 0; k < K * K; k++) alpha[k] /= z;
        }
        step(target.pos);
        return alpha;
      };
      const fwd = sweep(left);
      const bwd = sweep(right);
      let z = 0;
      const post = new Float64Array(K * K);
      for (let k = 0; k < K * K; k++) { post[k] = fwd[k] * bwd[k]; z += post[k]; }
      let sumSq = 0;
      for (let i = 0; i < K; i++) {
        const h1 = hapIdx[i];
        for (let j = 0; j < K; j++) {
          const w = post[i * K + j] / z;
          if (!w) continue;
          const h2 = hapIdx[j];
          sumSq += w * w;
          acc[target.haps[h1] + target.haps[h2]] += w;
          sampleWeight[h1 >> 1] += w / 2;
          sampleWeight[h2 >> 1] += w / 2;
        }
      }
      effectiveMatches = sumSq ? 1 / sumSq : 0;
    } else {
      method = 'diploid-samples';
      const ll = new Float64Array(nSamples);
      let maxLL = -Infinity;
      for (let s = 0; s < nSamples; s++) {
        let l = 0;
        for (const a of anchors) {
          const x = a.v.haps[2 * s], y = a.v.haps[2 * s + 1];
          if (x === MISSING || y === MISSING) continue;
          l += a.weight * logLik(Math.abs(a.dosage - (x + y)), logE);
        }
        ll[s] = l;
        if (l > maxLL) maxLL = l;
      }
      let z = 0;
      for (let s = 0; s < nSamples; s++) {
        const t1 = target.haps[2 * s], t2 = target.haps[2 * s + 1];
        if (t1 === MISSING || t2 === MISSING || excluded?.has(s)) { ll[s] = 0; continue; }
        ll[s] = Math.exp(ll[s] - maxLL);
        z += ll[s];
      }
      let sumSq = 0;
      for (let s = 0; s < nSamples; s++) {
        if (!ll[s]) continue;
        const w = ll[s] / z;
        sumSq += w * w;
        acc[target.haps[2 * s] + target.haps[2 * s + 1]] += w;
        sampleWeight[s] = w;
      }
      effectiveMatches = sumSq ? 1 / sumSq : 0;
    }

    const a = opts.priorWeight;
    probs = acc.map((x, i) => (1 - a) * x + a * prior[i]);

    topMatches = Array.from(sampleWeight, (w, s) => [s, w])
      .filter(([, w]) => w > 0)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 10)
      .map(([s, w]) => ({
        sample: opts.samples?.[s] ?? s,
        population: opts.populations?.get(opts.samples?.[s]) ?? undefined,
        weight: +w.toFixed(4),
      }));
  }

  const dosage = probs[1] + 2 * probs[2];
  let best = 0;
  if (probs[1] > probs[best]) best = 1;
  if (probs[2] > probs[best]) best = 2;
  const letters = [target.ref + target.ref, target.ref + target.alt, target.alt + target.alt];
  const confidence = probs[best];

  const result = {
    ...base,
    method,
    genotype: letters[best],
    probabilities: { [letters[0]]: probs[0], [letters[1]]: probs[1], [letters[2]]: probs[2] },
    dosage,
    confidence,
    confidenceLabel: confidenceLabel(confidence, anchors.length),
    effectiveMatches,
    topMatches,
    anchors: anchors.map((x) => ({ id: x.v.id, pos: x.v.pos, distance: x.dist, weight: +x.weight.toFixed(4), userDosage: x.dosage })),
  };

  if (opts.haploid) {
    const pRef = probs[0] + probs[1] / 2;
    result.genotype = pRef >= 0.5 ? target.ref : target.alt;
    result.probabilities = { [target.ref]: pRef, [target.alt]: 1 - pRef };
    result.confidence = Math.max(pRef, 1 - pRef);
    result.confidenceLabel = confidenceLabel(result.confidence, anchors.length);
    result.haploid = true;
  }
  return result;
}

export function confidenceLabel(c, nAnchors) {
  if (nAnchors < 5) return 'low';
  if (c >= 0.9) return 'high';
  if (c >= 0.7) return 'medium';
  return 'low';
}
