#!/usr/bin/env node
// OpenImpute helper for AI agents: inspect consumer raw DNA files.
// No dependencies. Node 18+.
//
//   node dna.mjs summary <file>
//   node dna.mjs lookup  <file> <rsid> [rsid...]
//   node dna.mjs region  <file> <chrom> <start> <end>
//
// <file> may be a .txt/.csv raw data file, or a .zip (needs the `unzip` command).
// Output is JSON on stdout.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function readRaw(path) {
  if (path.toLowerCase().endsWith('.zip')) {
    try {
      return execFileSync('unzip', ['-p', path], { maxBuffer: 1 << 30 }).toString('utf8');
    } catch {
      fail(`Could not unzip ${path}. Unzip it manually and pass the .txt file.`);
    }
  }
  return readFileSync(path, 'utf8');
}

function fail(msg) {
  console.log(JSON.stringify({ error: msg }));
  process.exit(1);
}

const VENDOR_HINTS = [
  [/23andMe/i, '23andMe'],
  [/AncestryDNA/i, 'AncestryDNA'],
  [/MyHeritage/i, 'MyHeritage'],
  [/FamilyTreeDNA|FTDNA/i, 'FamilyTreeDNA'],
  [/Living ?DNA/i, 'LivingDNA'],
];

const CHROM_ALIASES = { '23': 'X', '24': 'Y', '25': 'XY', '26': 'MT', M: 'MT' };
const normChrom = (c) => {
  const s = String(c).replace(/^chr/i, '').toUpperCase();
  return CHROM_ALIASES[s] ?? s;
};

export function parse(text) {
  const lines = text.split(/\r?\n/);
  const header = [];
  const snps = new Map();
  let vendor = 'unknown';
  let build = 'unknown';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      header.push(line);
      for (const [re, name] of VENDOR_HINTS) if (re.test(line) && vendor === 'unknown') vendor = name;
      if (/build 37|GRCh37|hg19/i.test(line)) build = 'GRCh37';
      else if (/build 38|GRCh38|hg38/i.test(line)) build = 'GRCh38';
      else if (/build 36|hg18/i.test(line)) build = 'GRCh36';
      continue;
    }
    const cols = line.includes('\t') ? line.split('\t') : line.split(',').map((c) => c.replace(/^"|"$/g, ''));
    if (/^rsid$/i.test(cols[0])) continue; // column header row
    if (cols.length < 4) continue;
    let [rsid, chrom, pos, a, b] = cols;
    // AncestryDNA: rsid chrom pos allele1 allele2 ; 23andMe: rsid chrom pos genotype
    const genotype = (cols.length >= 5 && a.length === 1 && b.length === 1 ? a + b : a).toUpperCase();
    snps.set(rsid.toLowerCase(), {
      rsid,
      chrom: normChrom(chrom),
      pos: Number(pos),
      genotype: /^[-0]+$/.test(genotype) ? null : genotype,
    });
  }
  if (build === 'unknown' && snps.size > 0) build = 'GRCh37 (assumed; consumer files almost always are)';
  return { vendor, build, header, snps };
}

function inferSex(snps) {
  let x = 0, xHet = 0, y = 0, yCalled = 0;
  for (const s of snps.values()) {
    if (!s.genotype) {
      if (s.chrom === 'Y') y++;
      continue;
    }
    if (s.chrom === 'X') {
      x++;
      if (s.genotype.length === 2 && s.genotype[0] !== s.genotype[1]) xHet++;
    } else if (s.chrom === 'Y') {
      y++;
      yCalled++;
    }
  }
  const hetRate = x ? xHet / x : null;
  const yCallRate = y ? yCalled / y : null;
  let sex = 'unknown';
  if (hetRate !== null) sex = hetRate < 0.01 ? 'male (XY)' : 'female (XX)';
  return { sex, chrX_heterozygosity: hetRate && +hetRate.toFixed(4), chrY_call_rate: yCallRate && +yCallRate.toFixed(4) };
}

function summary(data) {
  const perChrom = {};
  let noCalls = 0;
  for (const s of data.snps.values()) {
    perChrom[s.chrom] = (perChrom[s.chrom] ?? 0) + 1;
    if (!s.genotype) noCalls++;
  }
  const total = data.snps.size;
  return {
    vendor: data.vendor,
    build: data.build,
    total_snps: total,
    no_calls: noCalls,
    call_rate: total ? +(1 - noCalls / total).toFixed(4) : 0,
    ...inferSex(data.snps),
    snps_per_chromosome: perChrom,
  };
}

function lookup(data, rsids) {
  return rsids.map((id) => {
    const s = data.snps.get(id.toLowerCase());
    if (!s) return { rsid: id, status: 'not_on_chip', note: 'Not measured. Use the OpenImpute web app to impute it.' };
    if (!s.genotype) return { ...s, status: 'no_call', note: 'On the chip, but the genotype could not be read (no-call).' };
    return { ...s, status: 'measured' };
  });
}

function region(data, chrom, start, end) {
  const c = normChrom(chrom);
  const hits = [...data.snps.values()]
    .filter((s) => s.chrom === c && s.pos >= start && s.pos <= end)
    .sort((a, b) => a.pos - b.pos);
  return { chrom: c, start, end, build: data.build, measured_snps: hits.length, snps: hits };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) {
    console.error('usage: dna.mjs summary|lookup|region <file> [...]');
    process.exit(2);
  }
  const data = parse(readRaw(file));
  if (data.snps.size === 0) fail('No SNPs parsed. Is this a 23andMe/AncestryDNA raw data file?');
  let out;
  if (cmd === 'summary') out = summary(data);
  else if (cmd === 'lookup') out = lookup(data, rest);
  else if (cmd === 'region') {
    const [chrom, start, end] = rest;
    if (!chrom || !start || !end) fail('usage: region <file> <chrom> <start> <end>');
    out = region(data, chrom, Number(start), Number(end));
  } else fail(`Unknown command ${cmd}`);
  console.log(JSON.stringify(out, null, 2));
}
