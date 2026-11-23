#!/usr/bin/env node
// OpenImpute command-line tool.
import { parseArgs } from 'node:util';
import { summarize, inferSex, normChrom } from '../src/parse.js';
import { imputeVariant } from '../src/impute.js';
import { benchmarkSimulated, benchmarkLeaveOneOut } from '../src/simulate.js';
import { readDnaFile, openPanel } from '../src/node.js';

const HELP = `openimpute: genotype imputation for consumer raw DNA files

Usage:
  openimpute summary  <dna-file>
  openimpute lookup   <dna-file> <rsid>...                 measured genotypes only
  openimpute impute   <dna-file> --panel <path> <rsid>...  measured, or imputed if not on the chip
  openimpute bench-sim [--samples 10] [--targets 400]      accuracy on a simulated panel
  openimpute benchmark --panel <path> --region chr22:20000000-21000000
                       [--chip <dna-file>] [--chip-spacing 5000] [--samples 20]

Options:
  --panel <path>        VCF/VCF.gz/BCF file, or a directory from scripts/panel/build_panel.sh
  --populations <file>  sample-to-population table (e.g. 1000G sample panel file)
  --json                machine-readable output
  --window <bp>         anchor search window (default 1000000)
  --anchors <n>         max anchor SNPs (default 50)

<dna-file> can be the .txt or .zip from 23andMe, AncestryDNA, MyHeritage, FTDNA.
Not medical advice: imputed genotypes are predictions.`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    panel: { type: 'string' }, populations: { type: 'string' }, json: { type: 'boolean' },
    window: { type: 'string' }, anchors: { type: 'string' }, chrom: { type: 'string' },
    region: { type: 'string' }, chip: { type: 'string' }, 'chip-spacing': { type: 'string' },
    samples: { type: 'string' }, targets: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  },
});
const [cmd, ...args] = positionals;
const out = (x, text) => console.log(o.json ? JSON.stringify(x, null, 2) : text(x));
const die = (msg) => { console.error(`error: ${msg}`); process.exit(1); };
const pct = (x) => (x == null ? 'n/a' : `${(100 * x).toFixed(1)}%`);

const engineOpts = {};
if (o.window) engineOpts.windowBp = Number(o.window);
if (o.anchors) engineOpts.maxAnchors = Number(o.anchors);

async function main() {
  if (!cmd || o.help) return console.log(HELP);

  if (cmd === 'bench-sim') {
    const r = benchmarkSimulated({ testSamples: Number(o.samples ?? 10), maxTargets: Number(o.targets ?? 400), options: engineOpts });
    return out(r, formatBench);
  }

  if (cmd === 'benchmark') {
    if (!o.panel || !o.region) die('benchmark needs --panel and --region chr:start-end');
    const m = /^([^:]+):([\d,]+)-([\d,]+)$/.exec(o.region);
    if (!m) die('--region must look like chr22:20000000-21000000');
    const [chrom, start, end] = [m[1], Number(m[2].replace(/,/g, '')), Number(m[3].replace(/,/g, ''))];
    const panel = await openPanel(o.panel);
    const variants = await panel.getRegion(chrom, start, end);
    if (!variants.length) die(`no variants in ${o.region}`);
    let isChip;
    if (o.chip) {
      const chipIds = new Set(readDnaFile(o.chip).snps.keys());
      isChip = (v) => chipIds.has(String(v.id).toLowerCase());
    } else {
      const spacing = Number(o['chip-spacing'] ?? 5000);
      const chip = new Set();
      let last = -Infinity;
      for (const v of variants) {
        let a = 0, n = 0;
        for (const h of v.haps) if (h !== 255) { n++; a += h; }
        const maf = Math.min(a / n, 1 - a / n);
        if (maf >= 0.05 && v.pos - last >= spacing) { chip.add(v); last = v.pos; }
      }
      isChip = (v) => chip.has(v);
    }
    const nTest = Math.min(Number(o.samples ?? 20), panel.samples.length);
    const step = Math.max(1, Math.floor(panel.samples.length / nTest));
    const testSamples = Array.from({ length: nTest }, (_, i) => i * step);
    const r = benchmarkLeaveOneOut(variants, {
      testSamples, isChip, maxTargets: Number(o.targets ?? 2000), options: engineOpts,
      onProgress: (d, n) => process.stderr.write(`\r  sample ${d}/${n}`),
    });
    process.stderr.write('\n');
    r.region = o.region;
    r.chipVariants = variants.filter(isChip).length;
    r.panelVariants = variants.length;
    return out(r, formatBench);
  }

  const file = args.shift();
  if (!file) die(`${cmd} needs a DNA file`);
  const dna = readDnaFile(file);
  if (dna.snps.size === 0) die('no SNPs found. Is this a raw data file from 23andMe/AncestryDNA?');

  if (cmd === 'summary') {
    return out(summarize(dna), (s) => [
      `Vendor:     ${s.vendor}`, `Build:      ${s.build}`, `SNPs:       ${s.totalSnps.toLocaleString()}`,
      `Call rate:  ${pct(s.callRate)}`, `Sex:        ${s.sex}${s.chrXHeterozygosity != null ? ` (chrX heterozygosity ${s.chrXHeterozygosity.toFixed(3)})` : ''}`,
    ].join('\n'));
  }

  if (cmd === 'lookup') {
    const rows = args.map((id) => {
      const s = dna.snps.get(id.toLowerCase());
      if (!s) return { rsid: id, status: 'not_on_chip' };
      return { ...s, status: s.genotype ? 'measured' : 'no_call' };
    });
    return out(rows, (rs) => rs.map((r) => `${r.rsid}\t${r.status}${r.genotype ? `\t${r.genotype}\tchr${r.chrom}:${r.pos}` : ''}`).join('\n'));
  }

  if (cmd === 'impute') {
    if (!o.panel) die('impute needs --panel <path>');
    if (!args.length) die('give at least one rsID');
    const panel = await openPanel(o.panel, { populationsFile: o.populations });
    const { sex } = inferSex(dna.snps);
    const results = [];
    for (const id of args) {
      const measured = dna.snps.get(id.toLowerCase());
      const loc = await panel.findVariant(id, o.chrom ?? measured?.chrom);
      if (measured?.genotype) {
        const r = { id, status: 'measured', genotype: measured.genotype, chrom: measured.chrom, pos: measured.pos, build: dna.build };
        if (loc) r.inPanel = true;
        results.push(r);
        continue;
      }
      if (!loc) { results.push({ id, status: 'not_in_panel', note: 'Not on your chip and not in the reference panel.' }); continue; }
      const w = engineOpts.windowBp ?? 1_000_000;
      const region = await panel.getRegion(loc.chrom, loc.pos - w, loc.pos + w);
      const target = region.find((v) => v.pos === loc.pos && String(v.id).toLowerCase() === id.toLowerCase());
      if (!target) { results.push({ id, status: 'not_in_panel' }); continue; }
      const haploid = sex === 'male' && normChrom(loc.chrom) === 'X';
      const res = imputeVariant(target, region, dna.snps, { ...engineOpts, haploid, samples: panel.samples, populations: panel.populations });
      results.push({ status: 'imputed', panelBuild: 'panel coordinates', ...res });
    }
    return out(results, (rs) => rs.map(formatImpute).join('\n\n'));
  }

  die(`unknown command "${cmd}". Run openimpute --help`);
}

function formatImpute(r) {
  if (r.status === 'measured') return `${r.id}: ${r.genotype} (measured on your chip, chr${r.chrom}:${r.pos})`;
  if (r.status !== 'imputed') return `${r.id}: ${r.note ?? r.status}`;
  const probs = Object.entries(r.probabilities).map(([g, p]) => `${g} ${pct(p)}`).join('  ');
  const pops = r.topMatches.filter((m) => m.population).map((m) => m.population);
  const popSummary = pops.length ? `\n  Best-matching reference people: ${[...new Set(pops)].slice(0, 4).join(', ')}` : '';
  return [
    `${r.id}: ${r.genotype} (imputed, ${r.confidenceLabel} confidence ${pct(r.confidence)})`,
    `  ${r.chrom}:${r.pos} ${r.ref}>${r.alt}, panel alt frequency ${pct(r.panelAltFreq)}`,
    `  Probabilities: ${probs}`,
    `  Evidence: ${r.anchorsUsed} of your SNPs nearby (${r.anchorsAvailable} available), method ${r.method}` +
      (r.strandFlipsFixed ? `, ${r.strandFlipsFixed} strand flips fixed` : ''),
  ].join('\n') + popSummary;
}

function formatBench(r) {
  const lines = [
    `Leave-one-out benchmark${r.region ? ` on ${r.region} (${r.panelVariants} panel variants, ${r.chipVariants} used as chip)` : ' (simulated panel)'}`,
    `  ${r.testSamples} test people x ${r.targetsPerSample} hidden variants = ${r.genotypesScored} genotypes`,
    `  Concordance: ${pct(r.concordance)}   (baseline, guessing the most common genotype: ${pct(r.baselineConcordance)})`,
    `  High-confidence calls: ${pct(r.highConfidenceFraction)} of all, ${pct(r.highConfidenceConcordance)} correct`,
    '', '  By minor allele frequency:',
    ...r.byMaf.map((b) => `    MAF ${b.maf.padEnd(10)} n=${String(b.n).padEnd(6)} concordance ${pct(b.concordance).padEnd(7)} baseline ${pct(b.baseline).padEnd(7)} dosage r² ${b.dosageR2 ?? 'n/a'}`),
    '', '  Calibration (stated confidence vs observed accuracy):',
    ...r.calibration.map((c) => `    ${c.confidence.padEnd(10)} n=${String(c.n).padEnd(6)} observed ${pct(c.observedAccuracy)}`),
  ];
  return lines.join('\n');
}

main().catch((e) => die(e.message));
