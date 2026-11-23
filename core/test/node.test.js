import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDnaFile, openPanel } from '../src/node.js';
import { imputeVariant } from '../src/impute.js';
import { makeFixture } from './fixtures.js';

const CLI = fileURLToPath(new URL('../bin/openimpute.js', import.meta.url));
const fx = makeFixture();

test('reads .txt and .zip raw files identically', () => {
  const a = readDnaFile(fx.dnaPath), b = readDnaFile(fx.zipPath);
  assert.equal(a.snps.size, b.snps.size);
  assert.ok(a.snps.size > 100);
});

test('end to end: GRCh37-style raw file against a panel with different coordinates', async () => {
  const dna = readDnaFile(fx.zipPath);
  const panel = await openPanel(fx.panelPath);
  assert.equal(panel.samples.length, 200);
  let correct = 0, n = 0, flips = 0;
  for (let i = 3; i < fx.variants.length; i += 37) {
    if (i % fx.chipEvery === 0) continue;
    const id = fx.variants[i].id;
    const loc = await panel.findVariant(id);
    assert.ok(loc, `${id} should be found in the panel`);
    const region = await panel.getRegion(loc.chrom, loc.pos - 1e6, loc.pos + 1e6);
    const target = region.find((v) => v.id === id);
    const r = imputeVariant(target, region, dna.snps);
    assert.ok(r.anchorsUsed > 10, 'anchors are matched by rsID despite shifted positions');
    flips += r.strandFlipsFixed;
    const call = Object.values(r.probabilities);
    correct += call.indexOf(Math.max(...call)) === fx.truth.get(id);
    n++;
  }
  assert.ok(flips > 0, 'strand-flipped SNPs were corrected');
  assert.ok(correct / n > 0.85, `accuracy ${correct}/${n}`);
});

test('CLI impute and summary', () => {
  const hidden = fx.variants[101].id; // not on chip (101 % 8 != 0)
  const onChip = fx.variants[96].id;
  const json = JSON.parse(execFileSync('node', [CLI, 'impute', fx.dnaPath, '--panel', fx.panelPath, '--json', hidden, onChip, 'rs999'], { encoding: 'utf8' }));
  assert.equal(json[0].status, 'imputed');
  assert.ok(json[0].confidence > 0);
  assert.equal(json[1].status, 'measured');
  assert.equal(json[2].status, 'not_in_panel');
  const text = execFileSync('node', [CLI, 'summary', fx.zipPath], { encoding: 'utf8' });
  assert.match(text, /Vendor:\s+23andMe/);
});

test('CLI benchmark on a real-format panel file', () => {
  const out = execFileSync('node', [CLI, 'benchmark', '--panel', fx.panelPath, '--region', 'chr22:100000-400000', '--samples', '2', '--targets', '80', '--chip-spacing', '3000', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const r = JSON.parse(out);
  assert.ok(r.concordance > r.baselineConcordance);
});
