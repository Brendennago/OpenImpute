import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignGenotype, imputeVariant } from '../src/impute.js';
import { parseVcfLine, formatVcfLine } from '../src/vcf.js';
import { benchmarkSimulated, simulatePanel } from '../src/simulate.js';

test('alignGenotype handles strand flips and mismatches', () => {
  assert.deepEqual(alignGenotype('AG', 'A', 'G'), { dosage: 1, flipped: false });
  assert.deepEqual(alignGenotype('GG', 'A', 'G'), { dosage: 2, flipped: false });
  assert.deepEqual(alignGenotype('TC', 'A', 'G'), { dosage: 1, flipped: true });
  assert.deepEqual(alignGenotype('A', 'A', 'G'), { dosage: 0, flipped: false });
  assert.equal(alignGenotype('CC', 'A', 'T'), null); // ambiguous SNP, can't flip
  assert.equal(alignGenotype(null, 'A', 'G'), null);
});

test('VCF line round trip, including haploid and missing calls', () => {
  const line = 'chr22\t100\trs1\tA\tG\t.\tPASS\t.\tGT:DP\t0|1:5\t1:3\t./.:0';
  const v = parseVcfLine(line, 3);
  assert.deepEqual([...v.haps], [0, 1, 1, 1, 255, 255]);
  assert.equal(v.phased, false);
  assert.equal(parseVcfLine('chr22\t100\trs1\tAT\tG\t.\t.\t.\tGT\t0|1', 1), null); // indel skipped
  const sim = simulatePanel({ nSamples: 3, nSites: 2 }).variants[0];
  assert.deepEqual([...parseVcfLine(formatVcfLine(sim), 3).haps], [...sim.haps]);
});

test('imputation beats the allele-frequency baseline on a simulated panel', () => {
  const r = benchmarkSimulated({ testSamples: 2, maxTargets: 120 });
  assert.ok(r.concordance > 0.9, `concordance ${r.concordance}`);
  assert.ok(r.concordance > r.baselineConcordance + 0.1, `concordance ${r.concordance} vs baseline ${r.baselineConcordance}`);
  assert.ok(r.highConfidenceConcordance > 0.95, `high-confidence concordance ${r.highConfidenceConcordance}`);
});

test('falls back to allele frequency when there are no anchors', () => {
  const { variants } = simulatePanel({ nSamples: 20, nSites: 10 });
  const r = imputeVariant(variants[5], variants, new Map());
  assert.equal(r.method, 'allele-frequency-only');
  assert.equal(r.confidenceLabel, 'low');
});

test('haploid output for male chrX', () => {
  const { variants } = simulatePanel({ nSamples: 50, nSites: 50 });
  const r = imputeVariant(variants[10], variants, new Map(), { haploid: true });
  assert.equal(r.haploid, true);
  assert.equal(r.genotype.length, 1);
});
