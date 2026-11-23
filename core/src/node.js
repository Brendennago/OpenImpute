// Node.js helpers: reading DNA files and reference panels from disk.
import { readFileSync, existsSync, statSync, readdirSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, gunzipSync, createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { parseRawDna, normChrom } from './parse.js';
import { parseVcfLine, parseVcfHeader } from './vcf.js';

/** Extract the first file from a .zip (stored or deflated). No external tools. */
export function unzipFirstFile(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let e = 0; e < count; e++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.startsWith('__MACOSX')) continue;
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
    if (method === 0) return { name, data };
    if (method === 8) return { name, data: inflateRawSync(data) };
    throw new Error(`Unsupported zip compression method ${method}`);
  }
  throw new Error('Zip file is empty');
}

export function readDnaFile(path) {
  let buf = readFileSync(path);
  if (buf.readUInt32LE(0) === 0x04034b50) buf = unzipFirstFile(buf).data;
  else if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  return parseRawDna(buf.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Reference panels

let bcftoolsOk;
export function hasBcftools() {
  if (bcftoolsOk === undefined) {
    try { bcftoolsOk = spawnSync('bcftools', ['--version']).status === 0; } catch { bcftoolsOk = false; }
  }
  return bcftoolsOk;
}

function lines(path) {
  const stream = createReadStream(path);
  const input = path.endsWith('.gz') || path.endsWith('.bgz') ? stream.pipe(createGunzip()) : stream;
  return createInterface({ input, crlfDelay: Infinity });
}

function bcftoolsLines(args) {
  const p = spawn('bcftools', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const rl = createInterface({ input: p.stdout, crlfDelay: Infinity });
  rl.done = new Promise((res, rej) => p.on('close', (c) => (c === 0 ? res() : rej(new Error(`bcftools ${args[0]} failed: ${err.trim()}`)))));
  return rl;
}

const hasIndex = (f) => existsSync(f + '.csi') || existsSync(f + '.tbi');

/**
 * Open a panel: either one VCF/VCF.gz/BCF file, or a directory produced by
 * scripts/panel/build_panel.sh (chr<N>.bcf + chr<N>.sites.tsv.gz per chromosome).
 */
export async function openPanel(path, { populationsFile } = {}) {
  const isDir = statSync(path).isDirectory();
  const fileFor = (chrom) => {
    if (!isDir) return path;
    const c = normChrom(chrom);
    for (const name of [`chr${c}.bcf`, `chr${c}.vcf.gz`, `chr${c}.vcf`, `${c}.bcf`, `${c}.vcf.gz`]) {
      if (existsSync(join(path, name))) return join(path, name);
    }
    return null;
  };
  const anyFile = isDir
    ? readdirSync(path).filter((f) => /\.(bcf|vcf\.gz|vcf)$/.test(f)).map((f) => join(path, f))[0]
    : path;
  if (!anyFile) throw new Error(`No panel files found in ${path}`);
  const isBcf = (f) => f.endsWith('.bcf');
  if (isBcf(anyFile) && !hasBcftools()) throw new Error('Reading .bcf panels needs bcftools (brew install bcftools / sudo apt install bcftools)');

  // Samples
  let samples;
  if (hasBcftools()) {
    samples = spawnSync('bcftools', ['query', '-l', anyFile], { maxBuffer: 1 << 26 }).stdout.toString().trim().split('\n');
  } else {
    for await (const line of lines(anyFile)) {
      if (line.startsWith('#CHROM')) { samples = parseVcfHeader(line); break; }
    }
  }
  if (!samples?.length) throw new Error(`Could not read sample names from ${anyFile}`);

  let populations;
  if (populationsFile) {
    populations = new Map();
    for (const l of readFileSync(populationsFile, 'utf8').split('\n')) {
      const [s, pop, superPop] = l.trim().split(/\s+/);
      if (s && pop && !/^(sample|#)/i.test(s)) populations.set(s, superPop ? `${pop} (${superPop})` : pop);
    }
  }

  async function findVariant(rsid, chromHint) {
    const id = rsid.toLowerCase();
    if (isDir) {
      const files = readdirSync(path).filter((f) => f.endsWith('.sites.tsv.gz'));
      const hinted = chromHint ? files.filter((f) => f === `chr${normChrom(chromHint)}.sites.tsv.gz`) : files;
      for (const f of hinted.length ? hinted : files) {
        for await (const line of lines(join(path, f))) {
          const t = line.indexOf('\t');
          if (line.slice(0, t).toLowerCase() === id) {
            const [, chrom, pos] = line.split('\t');
            return { chrom, pos: Number(pos) };
          }
        }
      }
      if (files.length) return null;
    }
    const files = isDir ? readdirSync(path).filter((f) => /\.(bcf|vcf\.gz|vcf)$/.test(f)).map((f) => join(path, f)) : [path];
    for (const f of files) {
      if (hasBcftools()) {
        const rl = bcftoolsLines(['query', '-i', `ID=="${rsid.replace(/[^A-Za-z0-9_:.]/g, '')}"`, '-f', '%CHROM\t%POS\n', f]);
        let hit = null;
        for await (const line of rl) { if (!hit && line) { const [chrom, pos] = line.split('\t'); hit = { chrom, pos: Number(pos) }; } }
        await rl.done;
        if (hit) return hit;
      } else {
        for await (const line of lines(f)) {
          if (line[0] === '#') continue;
          const parts = line.split('\t', 3);
          if (parts[2]?.toLowerCase() === id) return { chrom: parts[0], pos: Number(parts[1]) };
        }
      }
    }
    return null;
  }

  async function getRegion(chrom, start, end) {
    const f = fileFor(chrom);
    if (!f) return [];
    const out = [];
    const n = samples.length;
    const s0 = Math.max(1, Math.floor(start));
    if (hasBcftools() && (isBcf(f) || hasIndex(f))) {
      const rl = bcftoolsLines(['view', '-H', '-r', `${chrom}:${s0}-${Math.floor(end)}`, f]);
      for await (const line of rl) { const v = parseVcfLine(line, n); if (v) out.push(v); }
      await rl.done;
      return out;
    }
    for await (const line of lines(f)) {
      if (line[0] === '#') continue;
      const t1 = line.indexOf('\t'), t2 = line.indexOf('\t', t1 + 1);
      if (line.slice(0, t1) !== chrom) continue;
      const pos = Number(line.slice(t1 + 1, t2));
      if (pos < s0) continue;
      if (pos > end) break;
      const v = parseVcfLine(line, n);
      if (v) out.push(v);
    }
    return out;
  }

  return { path, samples, populations, findVariant, getRegion };
}
