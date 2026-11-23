import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRawDna, summarize, normChrom } from '../src/parse.js';

test('parses 23andMe format', () => {
  const d = parseRawDna('# 23andMe\n# build 37\n# rsid\tchromosome\tposition\tgenotype\nrs1\t1\t100\tAG\nrs2\tX\t5\tA\nrs3\t2\t9\t--\nrs4\tMT\t1\tDI\n');
  assert.equal(d.vendor, '23andMe');
  assert.equal(d.build, 'GRCh37');
  assert.equal(d.snps.get('rs1').genotype, 'AG');
  assert.equal(d.snps.get('rs2').genotype, 'A');
  assert.equal(d.snps.get('rs3').genotype, null);
  assert.equal(d.snps.get('rs4').genotype, null);
});

test('parses AncestryDNA format with numeric chromosomes', () => {
  const d = parseRawDna('#AncestryDNA raw data download\nrsid\tchromosome\tposition\tallele1\tallele2\nrs1\t23\t100\tA\tG\nrs2\t1\t5\t0\t0\n');
  assert.equal(d.vendor, 'AncestryDNA');
  assert.equal(d.snps.get('rs1').chrom, 'X');
  assert.equal(d.snps.get('rs1').genotype, 'AG');
  assert.equal(d.snps.get('rs2').genotype, null);
  assert.match(d.build, /GRCh37/);
});

test('parses MyHeritage CSV format', () => {
  const d = parseRawDna('# MyHeritage DNA raw data.\nRSID,CHROMOSOME,POSITION,RESULT\n"rs1","1","100","CT"\n');
  assert.equal(d.vendor, 'MyHeritage');
  assert.equal(d.snps.get('rs1').genotype, 'CT');
});

test('summary and chromosome names', () => {
  assert.equal(normChrom('chr23'), 'X');
  assert.equal(normChrom('chrM'), 'MT');
  const s = summarize(parseRawDna('rs1\t1\t1\tAA\nrs2\t1\t2\t--\n'));
  assert.equal(s.totalSnps, 2);
  assert.equal(s.callRate, 0.5);
});
