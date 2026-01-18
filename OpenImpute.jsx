import React, { useState, useEffect, useRef } from 'react';
import { Search, Upload, FileText, Trash2, AlertCircle, CheckCircle, Loader2, Database, List, Settings, Info, Check, Download, Package } from 'lucide-react';
import * as zip from '@zip.js/zip.js';

// Configure zip.js to not use web workers
zip.configure({ useWebWorkers: false });

// --- IndexedDB Helpers ---
const DB_NAME = 'OpenImputeDB_v3';
const STORE_NAME = 'files';
const REFERENCE_STORE = 'referencePanel';
const DB_VERSION = 1;

const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = (e) => reject(e.target.error);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(REFERENCE_STORE)) {
        db.createObjectStore(REFERENCE_STORE);
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
  });
};

const saveToStore = async (storeName, key, data) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(data, key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
};

const getFromStore = async (storeName, key) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
};

const deleteFromStore = async (storeName, key) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
};

const getAllKeysFromStore = async (storeName) => {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAllKeys();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
};

// --- Math Helpers ---
const genotypeToDosage = (geno, ref, alt) => {
  if (!geno || geno.length < 2) return null;
  const alleles = geno.toUpperCase().split('').filter(a => a !== '/');
  if (alleles.length !== 2) return null;
  
  let dosage = 0;
  for (const allele of alleles) {
    if (allele === alt?.toUpperCase()) dosage++;
  }
  return dosage;
};

const calculateCorrelation = (vec1, vec2) => {
  const n = vec1.length;
  if (n !== vec2.length || n === 0) return 0;

  let sum1 = 0, sum2 = 0, sum1Sq = 0, sum2Sq = 0, pSum = 0;
  
  for (let i = 0; i < n; i++) {
    sum1 += vec1[i];
    sum2 += vec2[i];
    sum1Sq += vec1[i] * vec1[i];
    sum2Sq += vec2[i] * vec2[i];
    pSum += vec1[i] * vec2[i];
  }

  const num = pSum - (sum1 * sum2 / n);
  const den = Math.sqrt((sum1Sq - sum1 * sum1 / n) * (sum2Sq - sum2 * sum2 / n));

  if (den === 0) return 0;
  return num / den;
};

// --- Imputation Engine with Chromosome-Based Storage ---
class ImputationEngine {
  constructor() {
    this.index = null;           // { tier, totalVariants, chromosomes: { '1': { count, minPos, maxPos }, ... } }
    this.tier = null;
    this.isReady = false;
    this.loadedChromosomes = {}; // Cache: { '1': { variants: [...], rsidMap: {...} }, ... }
  }

  getTotalVariantCount() {
    return this.index?.totalVariants || 0;
  }

  getChromosomeCount() {
    return this.index?.chromosomes ? Object.keys(this.index.chromosomes).length : 0;
  }

  // Load reference panel from ZIP - stores metadata only, loads genotypes on-demand
  async loadZip(zipBlob, onProgress) {
    console.log('Loading reference panel...');
    
    try {
      const zipReader = new zip.ZipReader(new zip.BlobReader(zipBlob));
      const entries = await zipReader.getEntries();
      
      const indexEntry = entries.find(e => e.filename === 'index.json');
      const metadataEntry = entries.find(e => e.filename === 'metadata.csv');
      const genotypesEntry = entries.find(e => e.filename === 'genotypes.txt');
      
      if (!metadataEntry || !genotypesEntry) {
        throw new Error('Invalid reference panel: missing metadata.csv or genotypes.txt');
      }
      
      // Load index if present
      let baseIndex = {};
      if (indexEntry) {
        const indexText = await indexEntry.getData(new zip.TextWriter());
        baseIndex = JSON.parse(indexText);
      }
      this.tier = baseIndex.tier || 'common';
      
      const metaSize = metadataEntry.uncompressedSize;
      const genoSize = genotypesEntry.uncompressedSize;
      console.log(`Metadata: ${(metaSize/1024/1024).toFixed(1)}MB, Genotypes: ${(genoSize/1024/1024).toFixed(1)}MB`);
      
      onProgress?.({ stage: 'parsing', message: 'Processing metadata (genotypes loaded on-demand)...' });
      
      // PHASE 1: Parse metadata ONLY - no genotypes yet
      // Track which line number each variant is on for later genotype lookup
      const metadataBlob = await metadataEntry.getData(new zip.BlobWriter());
      
      const chromosomeData = {}; // chr -> { variants: [...], rsidToIdx: {} }
      const lineToChromIdx = []; // lineNumber -> { chr, idx } for genotype mapping
      
      const CHUNK_SIZE = 5 * 1024 * 1024;
      let metaOffset = 0;
      let metaBuffer = '';
      let isFirstLine = true;
      let lineCount = 0;
      
      while (metaOffset < metadataBlob.size) {
        const chunk = metadataBlob.slice(metaOffset, Math.min(metaOffset + CHUNK_SIZE, metadataBlob.size));
        metaBuffer += await chunk.text();
        
        const lines = metaBuffer.split('\n');
        metaBuffer = lines.pop() || '';
        
        const startIdx = isFirstLine ? 1 : 0;
        isFirstLine = false;
        
        for (let i = startIdx; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          const parts = line.split(',');
          if (parts.length < 6) continue;
          
          const [rsid, chr, pos, ref, alt, maf] = parts;
          const rsidClean = rsid.trim().toLowerCase();
          const chrClean = chr.trim().replace(/^chr/i, '');
          
          if (!chromosomeData[chrClean]) {
            chromosomeData[chrClean] = { variants: [], rsidToIdx: {} };
          }
          
          const idx = chromosomeData[chrClean].variants.length;
          chromosomeData[chrClean].variants.push({
            rsid: rsidClean,
            pos: parseInt(pos),
            ref: ref.trim(),
            alt: alt.trim(),
            maf: parseFloat(maf),
            genoLineNum: lineCount // Store which line has the genotypes
          });
          chromosomeData[chrClean].rsidToIdx[rsidClean] = idx;
          lineToChromIdx.push({ chr: chrClean, idx });
          lineCount++;
        }
        
        metaOffset += CHUNK_SIZE;
        
        if (lineCount % 500000 < 5000) {
          onProgress?.({ stage: 'parsing', message: `Indexed ${(lineCount/1000000).toFixed(1)}M variants...` });
        }
        await new Promise(r => setTimeout(r, 0));
      }
      
      // Handle remaining buffer
      if (metaBuffer.trim()) {
        const parts = metaBuffer.split(',');
        if (parts.length >= 6) {
          const [rsid, chr, pos, ref, alt, maf] = parts;
          const rsidClean = rsid.trim().toLowerCase();
          const chrClean = chr.trim().replace(/^chr/i, '');
          if (!chromosomeData[chrClean]) {
            chromosomeData[chrClean] = { variants: [], rsidToIdx: {} };
          }
          const idx = chromosomeData[chrClean].variants.length;
          chromosomeData[chrClean].variants.push({
            rsid: rsidClean,
            pos: parseInt(pos),
            ref: ref.trim(),
            alt: alt.trim(),
            maf: parseFloat(maf),
            genoLineNum: lineCount
          });
          chromosomeData[chrClean].rsidToIdx[rsidClean] = idx;
          lineToChromIdx.push({ chr: chrClean, idx });
          lineCount++;
        }
      }
      
      console.log(`Indexed ${lineCount.toLocaleString()} variants across ${Object.keys(chromosomeData).length} chromosomes`);
      
      // PHASE 2: Store the ZIP blob for later genotype extraction
      onProgress?.({ stage: 'saving', message: 'Saving reference data...' });
      
      // Store the original ZIP blob for on-demand genotype access
      await saveToStore(REFERENCE_STORE, 'zipBlob', zipBlob);
      console.log('✓ Stored ZIP blob for on-demand genotype access');
      
      // Build and save index
      const index = {
        tier: this.tier,
        totalVariants: lineCount,
        chromosomes: {},
        hasLazyGenotypes: true // Flag indicating genotypes need to be loaded on-demand
      };
      
      let savedChromosomes = 0;
      const totalChromosomes = Object.keys(chromosomeData).length;
      
      for (const [chr, data] of Object.entries(chromosomeData)) {
        // Sort by position
        data.variants.sort((a, b) => a.pos - b.pos);
        
        // Rebuild rsidToIdx after sorting
        data.rsidToIdx = {};
        data.variants.forEach((v, i) => {
          data.rsidToIdx[v.rsid] = i;
        });
        
        index.chromosomes[chr] = {
          count: data.variants.length,
          minPos: data.variants[0]?.pos || 0,
          maxPos: data.variants[data.variants.length - 1]?.pos || 0
        };
        
        // Save metadata only (no genotypes yet)
        await saveToStore(REFERENCE_STORE, `chr_${chr}_meta`, data);
        savedChromosomes++;
        
        onProgress?.({ 
          stage: 'saving', 
          message: `Saved chr${chr} metadata (${savedChromosomes}/${totalChromosomes})`,
          progress: savedChromosomes / totalChromosomes
        });
        
        console.log(`✓ Saved chr${chr}: ${data.variants.length.toLocaleString()} variants (metadata only)`);
        
        delete chromosomeData[chr];
        await new Promise(r => setTimeout(r, 0));
      }
      
      // Save index
      await saveToStore(REFERENCE_STORE, 'index', index);
      this.index = index;
      this.isReady = true;
      
      console.log(`✓ Reference panel indexed: ${index.totalVariants.toLocaleString()} variants`);
      console.log('Note: Genotypes will be loaded on-demand during imputation');
      onProgress?.({ stage: 'done', message: 'Complete! Genotypes load on-demand.' });
      
      await zipReader.close();
      return true;
      
    } catch (error) {
      console.error('Error loading reference panel:', error);
      throw error;
    }
  }

  // Load genotypes for a specific region of a chromosome (much faster than whole chromosome)
  async loadGenotypesForRegion(chr, centerPos, windowSize = 5000000) {
    console.log(`Loading genotypes for chr${chr}:${centerPos} ± ${windowSize/1000}kb...`);
    
    const zipBlob = await getFromStore(REFERENCE_STORE, 'zipBlob');
    if (!zipBlob) {
      console.error('ZIP blob not found in storage');
      return null;
    }
    
    const chromMeta = await getFromStore(REFERENCE_STORE, `chr_${chr}_meta`);
    if (!chromMeta) {
      console.error(`Chromosome ${chr} metadata not found`);
      return null;
    }
    
    // Find variants in the window
    const minPos = centerPos - windowSize;
    const maxPos = centerPos + windowSize;
    
    const neededLines = new Set();
    const lineToVariantIdx = new Map();
    const variantsInWindow = [];
    
    chromMeta.variants.forEach((v, idx) => {
      if (v.pos >= minPos && v.pos <= maxPos && v.genoLineNum !== undefined) {
        neededLines.add(v.genoLineNum);
        lineToVariantIdx.set(v.genoLineNum, idx);
        variantsInWindow.push(idx);
      }
    });
    
    console.log(`Need ${neededLines.size} genotype lines in window (vs ${chromMeta.variants.length} total)`);
    
    if (neededLines.size === 0) {
      return chromMeta; // No genotypes to load
    }
    
    // Find min and max line numbers to optimize streaming
    const sortedLineNums = Array.from(neededLines).sort((a, b) => a - b);
    const minLineNum = sortedLineNums[0];
    const maxLineNum = sortedLineNums[sortedLineNums.length - 1];
    
    // Extract genotypes from ZIP
    const zipReader = new zip.ZipReader(new zip.BlobReader(zipBlob));
    const entries = await zipReader.getEntries();
    const genotypesEntry = entries.find(e => e.filename === 'genotypes.txt');
    
    if (!genotypesEntry) {
      await zipReader.close();
      return null;
    }
    
    const genotypesBlob = await genotypesEntry.getData(new zip.BlobWriter());
    
    const CHUNK_SIZE = 10 * 1024 * 1024;
    let offset = 0;
    let buffer = '';
    let lineNum = 0;
    let foundCount = 0;
    
    // Stream through, but stop once we've passed maxLineNum
    while (offset < genotypesBlob.size && lineNum <= maxLineNum + 1000) {
      const chunk = genotypesBlob.slice(offset, Math.min(offset + CHUNK_SIZE, genotypesBlob.size));
      buffer += await chunk.text();
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (neededLines.has(lineNum)) {
          const variantIdx = lineToVariantIdx.get(lineNum);
          chromMeta.variants[variantIdx].genotypes = line.trim();
          foundCount++;
          
          if (foundCount >= neededLines.size) break;
        }
        lineNum++;
      }
      
      if (foundCount >= neededLines.size) break;
      offset += CHUNK_SIZE;
    }
    
    await zipReader.close();
    console.log(`✓ Loaded ${foundCount} genotypes for region`);
    
    // Cache partial data
    if (!this.loadedChromosomes[chr]) {
      this.loadedChromosomes[chr] = chromMeta;
    }
    
    return chromMeta;
  }

  // Load genotypes for a specific chromosome from the stored ZIP (full chromosome - slower)
  async loadChromosomeGenotypes(chr) {
    console.log(`Loading genotypes for chromosome ${chr}...`);
    
    // Get the stored ZIP blob
    const zipBlob = await getFromStore(REFERENCE_STORE, 'zipBlob');
    if (!zipBlob) {
      console.error('ZIP blob not found in storage');
      return false;
    }
    
    // Get chromosome metadata
    const chromMeta = await getFromStore(REFERENCE_STORE, `chr_${chr}_meta`);
    if (!chromMeta) {
      console.error(`Chromosome ${chr} metadata not found`);
      return false;
    }
    
    // Build a set of line numbers we need
    const neededLines = new Set();
    const lineToVariantIdx = new Map();
    chromMeta.variants.forEach((v, idx) => {
      if (v.genoLineNum !== undefined) {
        neededLines.add(v.genoLineNum);
        lineToVariantIdx.set(v.genoLineNum, idx);
      }
    });
    
    console.log(`Need ${neededLines.size} genotype lines for chr${chr}`);
    
    // Extract genotypes from ZIP, only keeping the lines we need
    const zipReader = new zip.ZipReader(new zip.BlobReader(zipBlob));
    const entries = await zipReader.getEntries();
    const genotypesEntry = entries.find(e => e.filename === 'genotypes.txt');
    
    if (!genotypesEntry) {
      await zipReader.close();
      return false;
    }
    
    // Stream through genotypes, extracting only needed lines
    const genotypesBlob = await genotypesEntry.getData(new zip.BlobWriter());
    
    const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks
    let offset = 0;
    let buffer = '';
    let lineNum = 0;
    let foundCount = 0;
    
    while (offset < genotypesBlob.size && foundCount < neededLines.size) {
      const chunk = genotypesBlob.slice(offset, Math.min(offset + CHUNK_SIZE, genotypesBlob.size));
      buffer += await chunk.text();
      
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (neededLines.has(lineNum)) {
          const variantIdx = lineToVariantIdx.get(lineNum);
          chromMeta.variants[variantIdx].genotypes = line.trim();
          foundCount++;
        }
        lineNum++;
      }
      
      offset += CHUNK_SIZE;
      await new Promise(r => setTimeout(r, 0)); // Let UI breathe
    }
    
    // Handle remaining buffer
    if (buffer && neededLines.has(lineNum)) {
      const variantIdx = lineToVariantIdx.get(lineNum);
      chromMeta.variants[variantIdx].genotypes = buffer.trim();
      foundCount++;
    }
    
    await zipReader.close();
    
    console.log(`✓ Loaded ${foundCount} genotypes for chr${chr}`);
    
    // DON'T save to IndexedDB - chromosome data with genotypes is too large
    // Just cache it in memory for this session
    this.loadedChromosomes[chr] = chromMeta;
    
    return true;
  }

  // Load from IndexedDB on startup - just loads the index, not chromosome data
  async loadFromIndexedDB() {
    try {
      const index = await getFromStore(REFERENCE_STORE, 'index');
      
      if (!index) {
        console.log('No reference panel found in IndexedDB');
        return false;
      }
      
      this.index = index;
      this.tier = index.tier;
      this.isReady = true;
      
      console.log(`✓ Loaded reference panel index: ${index.totalVariants.toLocaleString()} variants, ${Object.keys(index.chromosomes).length} chromosomes`);
      if (index.hasLazyGenotypes) {
        console.log('Note: Genotypes will be loaded on-demand during imputation');
      }
      return true;
      
    } catch (err) {
      console.error('Failed to load from IndexedDB:', err);
      return false;
    }
  }

  // Get chromosome data - loads from IndexedDB on demand, with lazy genotype loading
  async getChromosomeData(chr) {
    const chrKey = chr.replace(/^chr/i, '');
    
    // Check memory cache first - if we have genotypes, use them
    if (this.loadedChromosomes[chrKey]?.variants?.[0]?.genotypes) {
      return this.loadedChromosomes[chrKey];
    }
    
    // Load genotypes from ZIP on demand
    console.log(`Loading chromosome ${chrKey}...`);
    const metaData = await getFromStore(REFERENCE_STORE, `chr_${chrKey}_meta`);
    if (metaData) {
      console.log(`Loading genotypes for chr${chrKey} on-demand from ZIP...`);
      const success = await this.loadChromosomeGenotypes(chrKey);
      if (success) {
        return this.loadedChromosomes[chrKey];
      }
    }
    
    console.log(`Chromosome ${chrKey} not found in database`);
    return null;
  }

  // Get variants in a position range
  async getVariantsInRange(chr, startPos, endPos) {
    const chromData = await this.getChromosomeData(chr);
    if (!chromData) return [];
    
    // Binary search for start position
    const variants = chromData.variants;
    let left = 0, right = variants.length - 1;
    
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (variants[mid].pos < startPos) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    
    // Collect variants in range
    const result = [];
    for (let i = left; i < variants.length && variants[i].pos <= endPos; i++) {
      result.push(variants[i]);
    }
    
    return result;
  }

  // Get a specific variant by rsid - searches metadata first to avoid loading genotypes unnecessarily
  async getVariant(rsid) {
    const rsidLower = rsid.toLowerCase();
    
    // First, search metadata-only stores to find which chromosome has this rsid
    // This avoids loading genotypes for chromosomes we don't need
    for (const chr of Object.keys(this.index?.chromosomes || {})) {
      // Try metadata-only store first
      let chromMeta = await getFromStore(REFERENCE_STORE, `chr_${chr}_meta`);
      
      // If no metadata store, check if we have full data cached
      if (!chromMeta && this.loadedChromosomes[chr]) {
        chromMeta = this.loadedChromosomes[chr];
      }
      
      // If no metadata store, check if we have full data in DB
      if (!chromMeta) {
        chromMeta = await getFromStore(REFERENCE_STORE, `chr_${chr}`);
      }
      
      if (chromMeta?.rsidToIdx?.[rsidLower] !== undefined) {
        console.log(`Found ${rsid} on chromosome ${chr}`);
        
        // Now load the full chromosome data with genotypes
        const fullData = await this.getChromosomeData(chr);
        if (fullData) {
          const idx = fullData.rsidToIdx[rsidLower];
          return { ...fullData.variants[idx], chr };
        }
      }
    }
    
    console.log(`${rsid} not found in any chromosome`);
    return null;
  }

  // Clear all reference data
  async clearReferenceData() {
    try {
      const keys = await getAllKeysFromStore(REFERENCE_STORE);
      for (const key of keys) {
        await deleteFromStore(REFERENCE_STORE, key);
      }
      
      this.index = null;
      this.tier = null;
      this.isReady = false;
      this.loadedChromosomes = {};
      
      console.log('✓ Reference panel cleared');
    } catch (err) {
      console.error('Failed to clear reference panel:', err);
    }
  }

  // Calculate r² between two variants using their genotype strings
  calculateR2(geno1, geno2) {
    if (!geno1 || !geno2) return { r2: 0, r: 0, n: 0 };
    
    const dosages1 = [];
    const dosages2 = [];
    
    const g1 = geno1.split('');
    const g2 = geno2.split('');
    
    for (let i = 0; i < Math.min(g1.length, g2.length); i++) {
      const d1 = parseInt(g1[i]);
      const d2 = parseInt(g2[i]);
      if (!isNaN(d1) && !isNaN(d2)) {
        dosages1.push(d1);
        dosages2.push(d2);
      }
    }
    
    if (dosages1.length < 30) return { r2: 0, r: 0, n: 0 };
    
    const r = calculateCorrelation(dosages1, dosages2);
    return { r2: r * r, r: r, n: dosages1.length };
  }

  // Find all reference variants in a window around target position
  getVariantsInWindow(chromData, targetPos, windowSize) {
    const variants = chromData.variants;
    const result = [];
    
    // Binary search for start
    let left = 0, right = variants.length - 1;
    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (variants[mid].pos < targetPos - windowSize) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }
    
    // Collect variants in window
    for (let i = left; i < variants.length && variants[i].pos <= targetPos + windowSize; i++) {
      result.push({ ...variants[i], idx: i });
    }
    
    return result;
  }

  // HMM-based imputation using Li & Stephens haplotype copying model
  // Key insight: Your genome is a mosaic of reference haplotypes
  // We find which reference samples you match best across flanking variants,
  // then use their genotypes at the target to predict yours
  async impute(targetRsid, userGenomeData) {
    console.log('=== IMPUTATION START ===');
    console.log('Target:', targetRsid);
    
    if (!this.isReady) {
      console.log('ERROR: Reference panel not loaded');
      return { error: 'Reference panel not loaded' };
    }

    const rsidLower = targetRsid.toLowerCase();
    
    // Check if user already has this variant
    if (userGenomeData[rsidLower]) {
      console.log('User has this variant directly');
      return {
        rsid: rsidLower,
        genotype: userGenomeData[rsidLower].genotype,
        chromosome: userGenomeData[rsidLower].chromosome,
        position: userGenomeData[rsidLower].position,
        imputed: false,
        confidence: '1.000',
        confidencePercent: '100%',
        method: 'Direct genotype'
      };
    }

    // Find target variant in reference - first just get metadata to find position
    console.log('Looking up target in reference panel...');
    
    // Search metadata to find chromosome and position WITHOUT loading genotypes
    let targetChr = null;
    let targetPos = null;
    let targetMeta = null;
    
    for (const chr of Object.keys(this.index?.chromosomes || {})) {
      const chromMeta = await getFromStore(REFERENCE_STORE, `chr_${chr}_meta`);
      if (chromMeta?.rsidToIdx?.[rsidLower] !== undefined) {
        targetChr = chr;
        const idx = chromMeta.rsidToIdx[rsidLower];
        targetMeta = chromMeta.variants[idx];
        targetPos = targetMeta.pos;
        console.log(`Found ${rsidLower} on chromosome ${chr} at position ${targetPos}`);
        break;
      }
    }
    
    if (!targetChr) {
      console.log('ERROR: Variant not found in reference panel');
      return { error: `Variant ${targetRsid} not found in reference panel` };
    }

    // Detect if this is a hemizygous chromosome (X or Y for males)
    // We detect male by checking if user has any heterozygous calls on chrX
    const isHemizygous = (targetChr === 'X' || targetChr === 'Y') && this.detectMale(userGenomeData);
    console.log(`Chromosome ${targetChr}, hemizygous: ${isHemizygous}`);

    // Now load genotypes ONLY for the region we need (much faster!)
    const WINDOW_SIZE = 5000000; // 5Mb window
    console.log(`Loading genotypes for ${WINDOW_SIZE/1000}kb window around target...`);
    
    const chromData = await this.loadGenotypesForRegion(targetChr, targetPos, WINDOW_SIZE);
    if (!chromData) {
      console.log('ERROR: Could not load chromosome data');
      return { error: `Chromosome ${targetChr} data not available` };
    }
    
    // Get target variant with genotypes
    const targetIdx = chromData.rsidToIdx[rsidLower];
    const targetVariant = chromData.variants[targetIdx];
    
    if (!targetVariant?.genotypes) {
      console.log('ERROR: No genotype data for target');
      return { error: `No genotype data for ${targetRsid}` };
    }
    
    const nSamples = targetVariant.genotypes.length;
    console.log('Reference samples:', nSamples);

    // Find user variants in the window that are in reference
    console.log('Finding user variants in window...');
    const userVariantsInWindow = [];
    
    for (const [userRsid, userSnp] of Object.entries(userGenomeData)) {
      const userChr = userSnp.chromosome?.replace(/^chr/i, '');
      if (userChr !== targetChr) continue;
      
      // Check if in window
      const userPos = userSnp.position;
      if (Math.abs(userPos - targetPos) > WINDOW_SIZE) continue;
      
      const refIdx = chromData.rsidToIdx[userRsid.toLowerCase()];
      if (refIdx !== undefined) {
        const refVariant = chromData.variants[refIdx];
        
        // For hemizygous chromosomes, convert heterozygous calls to homozygous
        let userGenotype = userSnp.genotype;
        if (isHemizygous && userGenotype.length === 2 && userGenotype[0] !== userGenotype[1]) {
          // Male with "het" call on X - take first allele
          userGenotype = userGenotype[0] + userGenotype[0];
        }
        
        const userDosage = genotypeToDosage(userGenotype, refVariant.ref, refVariant.alt);
        
        if (userDosage !== null && refVariant.genotypes) {
          userVariantsInWindow.push({
            rsid: userRsid,
            pos: refVariant.pos,
            distance: Math.abs(refVariant.pos - targetPos),
            userDosage,
            refGenotypes: refVariant.genotypes,
            ref: refVariant.ref,
            alt: refVariant.alt
          });
        }
      }
    }

    console.log(`Found ${userVariantsInWindow.length} user variants in window`);

    if (userVariantsInWindow.length === 0) {
      return this.mafFallback(targetVariant, rsidLower, targetChr, targetPos, 'No variants in window', isHemizygous);
    }

    // Sort by distance to target
    userVariantsInWindow.sort((a, b) => a.distance - b.distance);
    
    // Use up to 50 closest flanking variants (more = better accuracy)
    const flankingVariants = userVariantsInWindow.slice(0, 50);
    console.log(`Using ${flankingVariants.length} flanking variants`);

    if (flankingVariants.length < 3) {
      return this.mafFallback(targetVariant, rsidLower, targetChr, targetPos, 'Insufficient flanking variants', isHemizygous);
    }

    // HMM-STYLE HAPLOTYPE MATCHING
    // For each reference sample, calculate how well user matches that sample
    // across all flanking variants, with distance-based weighting
    
    const sampleScores = new Array(nSamples).fill(0);
    const sampleCounts = new Array(nSamples).fill(0);
    
    // Recombination rate: probability of switching haplotypes per base pair
    const RECOMB_RATE = 1e-7;
    
    for (const flanking of flankingVariants) {
      const distanceWeight = Math.exp(-RECOMB_RATE * flanking.distance);
      
      for (let sampleIdx = 0; sampleIdx < nSamples; sampleIdx++) {
        const refDosage = parseInt(flanking.refGenotypes[sampleIdx]);
        if (isNaN(refDosage)) continue;
        
        const dosageDiff = Math.abs(flanking.userDosage - refDosage);
        
        let emissionProb;
        if (dosageDiff === 0) {
          emissionProb = 0.95;
        } else if (dosageDiff === 1) {
          emissionProb = 0.40;
        } else {
          emissionProb = 0.05;
        }
        
        sampleScores[sampleIdx] += Math.log(emissionProb) * distanceWeight;
        sampleCounts[sampleIdx] += distanceWeight;
      }
    }

    // Convert to probabilities
    const validSamples = [];
    for (let i = 0; i < nSamples; i++) {
      if (sampleCounts[i] > 0) {
        const normalizedScore = sampleScores[i] / sampleCounts[i];
        validSamples.push({
          idx: i,
          score: Math.exp(normalizedScore),
          targetDosage: parseInt(targetVariant.genotypes[i])
        });
      }
    }

    if (validSamples.length === 0) {
      return this.mafFallback(targetVariant, rsidLower, targetChr, targetPos, 'No valid reference samples', isHemizygous);
    }

    validSamples.sort((a, b) => b.score - a.score);

    // Calculate genotype probabilities
    const genotypeProbs = [0, 0, 0];
    let totalWeight = 0;
    
    for (const sample of validSamples) {
      if (isNaN(sample.targetDosage)) continue;
      
      const weight = sample.score;
      genotypeProbs[sample.targetDosage] += weight;
      totalWeight += weight;
    }

    if (totalWeight === 0) {
      return this.mafFallback(targetVariant, rsidLower, targetChr, targetPos, 'No weighted votes', isHemizygous);
    }

    // Normalize
    const probs = genotypeProbs.map(p => p / totalWeight);
    const maxProb = Math.max(...probs);
    const predictedDosage = probs.indexOf(maxProb);

    // Build genotype string
    const ref = targetVariant.ref;
    const alt = targetVariant.alt;
    let genotype;
    
    if (isHemizygous) {
      // For hemizygous (male X/Y), show single allele
      if (predictedDosage === 0) genotype = ref;
      else if (predictedDosage === 2) genotype = alt;
      else genotype = ref; // For het prediction on hemizygous, default to ref
    } else {
      // Normal diploid
      if (predictedDosage === 0) genotype = `${ref}${ref}`;
      else if (predictedDosage === 1) genotype = `${ref}${alt}`;
      else genotype = `${alt}${alt}`;
    }

    // Calculate confidence
    const entropy = -probs.reduce((sum, p) => p > 0 ? sum + p * Math.log2(p) : sum, 0);
    const maxEntropy = Math.log2(3);
    const certainty = 1 - (entropy / maxEntropy);
    
    const flankingBonus = Math.min(flankingVariants.length / 30, 1.0); // Increased divisor
    const avgDistance = flankingVariants.reduce((sum, v) => sum + v.distance, 0) / flankingVariants.length;
    const distanceBonus = Math.exp(-avgDistance / 5000000);
    
    const confidence = Math.min(certainty * 0.5 + flankingBonus * 0.3 + distanceBonus * 0.2, 0.95);

    const topSamples = validSamples.slice(0, 5);

    return {
      rsid: rsidLower,
      genotype,
      chromosome: `chr${targetChr}`,
      position: targetPos,
      ref,
      alt,
      imputed: true,
      hemizygous: isHemizygous,
      confidence: confidence.toFixed(3),
      confidencePercent: `${(confidence * 100).toFixed(1)}%`,
      method: `Haplotype matching (${flankingVariants.length} flanking variants)`,
      flankingVariants: flankingVariants.length,
      avgDistance: `${(avgDistance / 1000).toFixed(0)}kb`,
      referenceSamplesUsed: validSamples.length,
      topMatchingSamples: topSamples.slice(0, 3).map((s, i) => ({
        rank: i + 1,
        score: s.score.toFixed(4),
        genotype: s.targetDosage
      })),
      genotypeProbabilities: isHemizygous ? {
        ref: `${((probs[0] + probs[1] * 0.5) * 100).toFixed(1)}%`,
        alt: `${((probs[2] + probs[1] * 0.5) * 100).toFixed(1)}%`
      } : {
        homRef: `${(probs[0] * 100).toFixed(1)}%`,
        het: `${(probs[1] * 100).toFixed(1)}%`,
        homAlt: `${(probs[2] * 100).toFixed(1)}%`
      }
    };
  }

  // Detect if user is male by checking chrX heterozygosity
  detectMale(userGenomeData) {
    let hetCount = 0;
    let totalX = 0;
    
    for (const [rsid, snp] of Object.entries(userGenomeData)) {
      const chr = snp.chromosome?.replace(/^chr/i, '');
      if (chr !== 'X') continue;
      
      totalX++;
      const geno = snp.genotype;
      if (geno && geno.length === 2 && geno[0] !== geno[1]) {
        hetCount++;
      }
      
      if (totalX >= 100) break; // Sample first 100 X variants
    }
    
    // Males should have almost no heterozygous calls on X (except pseudoautosomal regions)
    const hetRate = totalX > 0 ? hetCount / totalX : 0;
    console.log(`chrX het rate: ${(hetRate * 100).toFixed(1)}% (${hetCount}/${totalX})`);
    
    return hetRate < 0.1; // Less than 10% het = likely male
  }

  // MAF-based fallback when haplotype matching fails
  mafFallback(targetVariant, rsidLower, targetChr, targetPos, reason, isHemizygous = false) {
    const maf = targetVariant?.maf || 0.5;
    const p = maf;
    const q = 1 - maf;
    
    // Hardy-Weinberg equilibrium
    const probs = [q * q, 2 * p * q, p * p];
    const maxProb = Math.max(...probs);
    const predictedDosage = probs.indexOf(maxProb);
    
    const ref = targetVariant?.ref || '?';
    const alt = targetVariant?.alt || '?';
    let genotype;
    
    if (isHemizygous) {
      // For hemizygous, just pick ref or alt based on MAF
      genotype = maf < 0.5 ? ref : alt;
    } else {
      if (predictedDosage === 0) genotype = `${ref}${ref}`;
      else if (predictedDosage === 1) genotype = `${ref}${alt}`;
      else genotype = `${alt}${alt}`;
    }
    
    return {
      rsid: rsidLower,
      genotype,
      chromosome: `chr${targetChr}`,
      position: targetPos,
      ref,
      alt,
      imputed: true,
      hemizygous: isHemizygous,
      confidence: '0.150',
      confidencePercent: '15.0%',
      method: 'MAF-based (haplotype matching failed)',
      warning: `Low confidence: ${reason}`,
      maf: maf.toFixed(4),
      genotypeProbabilities: isHemizygous ? {
        ref: `${(q * 100).toFixed(1)}%`,
        alt: `${(p * 100).toFixed(1)}%`
      } : {
        homRef: `${(probs[0] * 100).toFixed(1)}%`,
        het: `${(probs[1] * 100).toFixed(1)}%`,
        homAlt: `${(probs[2] * 100).toFixed(1)}%`
      }
    };
  }
}

// --- Main Component ---
const OpenImpute = () => {
  const [currentFile, setCurrentFile] = useState(null);
  const [recentFiles, setRecentFiles] = useState([]);
  const [searchResults, setSearchResults] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [parsedData, setParsedData] = useState(null);
  const [cache, setCache] = useState({});
  const [cacheHit, setCacheHit] = useState(false);
  
  const [searchMode, setSearchMode] = useState('single');
  const [stepSize, setStepSize] = useState(100);
  
  const [referencePanelLoaded, setReferencePanelLoaded] = useState(false);
  const [referenceStatus, setReferenceStatus] = useState('not_loaded');
  const [loadProgress, setLoadProgress] = useState(null);
  const [imputationEngine] = useState(() => new ImputationEngine());
  
  const fileInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const refPanelInputRef = useRef(null);

  // Parse user DNA file
  const parseFile = (content) => {
    try {
      const lines = content.split('\n');
      const snpMap = {};
       
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#') || line.startsWith('RSID')) continue;
        
        const parts = line.split(/\s+/);
        if (parts.length >= 4) {
          const rsid = parts[0].toLowerCase();
          const chromosome = parts[1];
          const position = parseInt(parts[2]);
          const genotype = parts.length === 4 ? parts[3] : parts[3] + parts[4];
          snpMap[rsid] = { rsid, chromosome, position, genotype };
        }
      }
      return { success: true, data: snpMap, totalSNPs: Object.keys(snpMap).length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  // Handle reference panel upload
  const handleReferencePanelUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.name.endsWith('.zip')) {
      setError('Please upload a .zip reference panel file');
      return;
    }

    setIsLoading(true);
    setReferenceStatus('processing');
    setError(null);
    setLoadProgress({ stage: 'starting', message: 'Starting...' });

    try {
      await imputationEngine.loadZip(file, (progress) => {
        setLoadProgress(progress);
      });
      
      setReferencePanelLoaded(true);
      setReferenceStatus('loaded');
      setLoadProgress(null);
    } catch (err) {
      console.error('Error loading reference panel:', err);
      setError(`Failed to load reference panel: ${err.message}`);
      setReferenceStatus('error');
      setLoadProgress(null);
    } finally {
      setIsLoading(false);
    }
  };

  // Load from storage on startup
  useEffect(() => {
    const loadFromStorage = async () => {
      try {
        const storedCache = window.localStorage.getItem('imputation_cache_v3');
        if (storedCache) setCache(JSON.parse(storedCache));
        
        const storedFiles = window.localStorage.getItem('recent_files');
        if (storedFiles) setRecentFiles(JSON.parse(storedFiles));
        
        // Try to load reference from IndexedDB
        const loaded = await imputationEngine.loadFromIndexedDB();
        if (loaded) {
          setReferencePanelLoaded(true);
          setReferenceStatus('loaded');
        }
      } catch (err) {
        console.log('Storage initialization error:', err);
      }
    };
    
    loadFromStorage();
  }, []);

  const saveCache = async (newCache) => {
    try {
      window.localStorage.setItem('imputation_cache_v3', JSON.stringify(newCache));
      setCache(newCache);
    } catch (err) {
      console.error('Failed to save cache:', err);
    }
  };

  // Handle DNA file upload
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsLoading(true);
    setError(null);
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target.result;
      const result = parseFile(content);
      
      if (result.success) {
        setParsedData(result.data);
        
        try {
          await saveToStore(STORE_NAME, file.name, result.data);
        } catch (dbErr) {
          console.error("Failed to save to DB:", dbErr);
        }

        const fileInfo = {
          name: file.name,
          size: file.size,
          snpCount: result.totalSNPs,
          uploadedAt: new Date().toISOString()
        };
        
        setCurrentFile(fileInfo);
        saveCache({});
        
        const updated = [fileInfo, ...recentFiles.filter(f => f.name !== file.name)].slice(0, 5);
        setRecentFiles(updated);
        window.localStorage.setItem('recent_files', JSON.stringify(updated));
      } else {
        setError(result.error);
      }
      setIsLoading(false);
    };
    
    reader.onerror = () => {
      setError('Failed to read file');
      setIsLoading(false);
    };
    
    reader.readAsText(file);
  };

  // Handle search
  const handleSearch = async () => {
    const rawQuery = searchInputRef.current?.value;
    
    if (!rawQuery?.trim()) {
      setError('Please enter a search query');
      return;
    }
    
    if (!parsedData) {
      setError('Please upload a DNA file first');
      return;
    }

    setIsLoading(true);
    setError(null);
    setCacheHit(false);
    setSearchResults(null);
    
    const query = rawQuery.trim().toLowerCase();

    try {
      if (searchMode === 'range') {
        // Range search: chr1:12345-67890
        const rangeMatch = query.match(/^(?:chr)?(\w+):(\d+)-(\d+)$/);
        
        if (!rangeMatch) {
          setError("Invalid range format. Use: chr1:12345-67890");
          setIsLoading(false);
          return;
        }

        const targetChrom = rangeMatch[1];
        const startPos = parseInt(rangeMatch[2]);
        const endPos = parseInt(rangeMatch[3]);
        
        // Get user's genotyped SNPs in range
        const userResults = Object.values(parsedData).filter(snp => {
          const snpChrom = snp.chromosome.replace(/^chr/i, '');
          return snpChrom === targetChrom && snp.position >= startPos && snp.position <= endPos;
        }).map(snp => ({ ...snp, imputed: false, confidencePercent: '100%' }));

        // If reference panel loaded, also get imputable variants
        if (referencePanelLoaded && imputationEngine.isReady) {
          const refVariants = await imputationEngine.getVariantsInRange(targetChrom, startPos, endPos);
          const userRsids = new Set(Object.keys(parsedData));
          
          console.log(`Found ${refVariants.length} reference variants in range, ${userResults.length} user variants`);
          
          // Try to impute variants user doesn't have (limit to avoid slowness)
          const toImpute = refVariants
            .filter(v => !userRsids.has(v.rsid))
            .slice(0, Math.min(50, Math.ceil((endPos - startPos) / stepSize)));
          
          for (const variant of toImpute) {
            const result = await imputationEngine.impute(variant.rsid, parsedData);
            if (!result.error && result.imputed) {
              userResults.push({
                rsid: variant.rsid,
                chromosome: `chr${targetChrom}`,
                position: variant.pos,
                genotype: result.genotype,
                imputed: true,
                confidence: result.confidence,
                confidencePercent: result.confidencePercent
              });
            }
          }
        }

        setSearchResults(userResults.sort((a, b) => a.position - b.position));
        
      } else {
        // Single SNP search
        // Skip cache for now to test new algorithm (can re-enable later)
        // if (cache[query]) {
        //   setSearchResults({ ...cache[query], cached: true });
        //   setCacheHit(true);
        //   setIsLoading(false);
        //   return;
        // }
        
        if (parsedData[query]) {
          const result = { ...parsedData[query], imputed: false, cached: false };
          setSearchResults(result);
          setIsLoading(false);
          return;
        }

        if (!referencePanelLoaded) {
          setError("Variant not in your data. Upload a reference panel to enable imputation.");
          setIsLoading(false);
          return;
        }
        
        console.log('Starting imputation for:', query);
        const imputedResult = await imputationEngine.impute(query, parsedData);
        console.log('Imputation result:', imputedResult);
        
        if (imputedResult.error) {
          setError(imputedResult.error);
        } else {
          setSearchResults(imputedResult);
          // Don't cache for now during testing
          // const newCache = { ...cache, [query]: imputedResult };
          // saveCache(newCache);
        }
      }
    } catch (err) {
      setError(err.message);
    }
    
    setIsLoading(false);
  };

  const handleRecentClick = async (file) => {
    setError(null);
    try {
      setIsLoading(true);
      const dbData = await getFromStore(STORE_NAME, file.name);
      
      if (dbData) {
        setParsedData(dbData);
        setCurrentFile(file);
        const updated = [file, ...recentFiles.filter(f => f.name !== file.name)].slice(0, 5);
        setRecentFiles(updated);
        window.localStorage.setItem('recent_files', JSON.stringify(updated));
        setIsLoading(false);
        return;
      }
    } catch (e) {
      console.log("Cache miss", e);
    }

    setIsLoading(false);
    setError(`Cache missing for ${file.name}. Please select the file again.`);
    fileInputRef.current?.click();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold text-white mb-3">
            OpenImpute
          </h1>
          <p className="text-slate-300 text-lg">Fast LD-Based Genotype Imputation</p>
          <p className="text-slate-400 text-sm mt-2">
            100% Offline | Chromosome-Optimized Storage | Instant Startup
          </p>
        </div>

        {/* Reference Panel Status */}
        <div className={`mb-6 p-4 rounded-xl border ${
          referencePanelLoaded 
            ? 'bg-green-900/20 border-green-700' 
            : 'bg-amber-900/20 border-amber-700'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Package className={`w-5 h-5 ${referencePanelLoaded ? 'text-green-400' : 'text-amber-400'}`} />
              <div>
                <p className="text-white font-semibold">
                  {referencePanelLoaded ? 'Reference Panel Active' : 'Reference Panel Missing'}
                </p>
                <p className="text-slate-400 text-sm">
                  {referencePanelLoaded 
                    ? `${imputationEngine.tier} tier | ${imputationEngine.getTotalVariantCount().toLocaleString()} variants | ${imputationEngine.getChromosomeCount()} chromosomes`
                    : 'Upload a reference panel ZIP to enable imputation'}
                </p>
              </div>
            </div>
            
            <div className="flex gap-2">
              {referencePanelLoaded && (
                <button
                  onClick={async () => {
                    await imputationEngine.clearReferenceData();
                    setReferencePanelLoaded(false);
                    setReferenceStatus('not_loaded');
                  }}
                  className="bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Clear
                </button>
              )}
              {!referencePanelLoaded && (
                <>
                  <input
                    ref={refPanelInputRef}
                    type="file"
                    accept=".zip"
                    onChange={handleReferencePanelUpload}
                    className="hidden"
                  />
                  <button
                    onClick={() => refPanelInputRef.current?.click()}
                    disabled={isLoading}
                    className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    <Upload className="w-4 h-4" />
                    Upload .zip
                  </button>
                </>
              )}
            </div>
          </div>
          
          {loadProgress && (
            <div className="mt-3">
              <div className="flex items-center gap-2 text-amber-300 mb-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">{loadProgress.message}</span>
              </div>
              {loadProgress.progress !== undefined && (
                <div className="w-full bg-slate-700 rounded-full h-2">
                  <div 
                    className="bg-amber-500 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${loadProgress.progress * 100}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-900/30 border border-red-700 rounded-xl flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
            <p className="text-red-200">{error}</p>
          </div>
        )}

        {/* DNA File Section */}
        {!parsedData ? (
          <div className="bg-slate-800/50 backdrop-blur rounded-xl p-8 border border-slate-700 text-center">
            <Upload className="w-16 h-16 text-purple-400 mx-auto mb-4 opacity-50" />
            <h2 className="text-2xl font-bold text-white mb-2">Get Started</h2>
            <p className="text-slate-300 mb-6">Upload your raw DNA data file (23andMe / Ancestry)</p>
            
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2 mx-auto"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
              {isLoading ? 'Processing...' : 'Upload New File'}
            </button>

            {recentFiles.length > 0 && (
              <div className="mt-8 text-left">
                <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
                  <FileText className="w-4 h-4" /> Recent Files
                </h3>
                <div className="space-y-2">
                  {recentFiles.map((file, i) => (
                    <div key={i} className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg">
                      <button
                        onClick={() => handleRecentClick(file)}
                        className="text-left flex-1 hover:text-purple-300 transition-colors"
                      >
                        <p className="text-white font-medium">{file.name}</p>
                        <p className="text-slate-400 text-sm">
                          {file.snpCount?.toLocaleString() || '?'} SNPs | {new Date(file.uploadedAt).toLocaleDateString()}
                        </p>
                      </button>
                      <button
                        onClick={() => {
                          const updated = recentFiles.filter(f => f.name !== file.name);
                          setRecentFiles(updated);
                          window.localStorage.setItem('recent_files', JSON.stringify(updated));
                        }}
                        className="text-slate-400 hover:text-red-400 p-2"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {/* Current File */}
            <div className="bg-slate-800/50 backdrop-blur rounded-xl p-4 border border-slate-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-green-400" />
                  <div>
                    <p className="text-white font-medium">{currentFile?.name}</p>
                    <p className="text-slate-400 text-sm">{Object.keys(parsedData).length.toLocaleString()} SNPs loaded</p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setParsedData(null);
                    setCurrentFile(null);
                    setSearchResults(null);
                  }}
                  className="text-slate-400 hover:text-white transition-colors"
                >
                  Change File
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
              <div className="flex gap-4 mb-4">
                <button
                  onClick={() => setSearchMode('single')}
                  className={`pb-2 text-sm font-semibold transition-colors ${searchMode === 'single' ? 'text-purple-400 border-b-2 border-purple-400' : 'text-slate-400 hover:text-white'}`}
                >
                  Single SNP
                </button>
                <button
                  onClick={() => setSearchMode('range')}
                  className={`pb-2 text-sm font-semibold transition-colors ${searchMode === 'range' ? 'text-purple-400 border-b-2 border-purple-400' : 'text-slate-400 hover:text-white'}`}
                >
                  Range Search
                </button>
              </div>

              <div className="flex gap-3">
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder={searchMode === 'range' ? "chr19:44900000-45000000" : "rs429358"}
                  className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-4 py-3 text-white placeholder-slate-400 focus:outline-none focus:border-purple-500"
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <button
                  onClick={handleSearch}
                  disabled={isLoading}
                  className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
                  Search
                </button>
              </div>
              
              {searchMode === 'range' && (
                <p className="text-slate-400 text-sm mt-2">
                  {!referencePanelLoaded && <span className="text-amber-400">Upload reference panel to enable imputation in range</span>}
                </p>
              )}
            </div>

            {/* Results */}
            {searchResults && (
              <div className="bg-slate-800/50 backdrop-blur rounded-xl p-6 border border-slate-700">
                {Array.isArray(searchResults) ? (
                  // Range results
                  <div>
                    <div className="flex items-center gap-3 mb-4">
                      <List className="w-6 h-6 text-blue-400" />
                      <h3 className="text-xl font-bold text-white">Range Results</h3>
                      <span className="text-slate-400 text-sm">
                        {searchResults.length} SNPs ({searchResults.filter(s => s.imputed).length} imputed)
                      </span>
                    </div>
                    <div className="overflow-auto max-h-96 border border-slate-700 rounded-lg">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-700 text-slate-300 sticky top-0">
                          <tr>
                            <th className="px-4 py-2">RSID</th>
                            <th className="px-4 py-2">Position</th>
                            <th className="px-4 py-2">Genotype</th>
                            <th className="px-4 py-2">Confidence</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-700">
                          {searchResults.map((snp, i) => (
                            <tr key={i} className={snp.imputed ? 'bg-purple-900/20' : ''}>
                              <td className="px-4 py-2 text-white font-mono">
                                {snp.rsid}
                                {snp.imputed && <span className="ml-2 text-xs bg-purple-500/30 text-purple-200 px-1 rounded">IMP</span>}
                              </td>
                              <td className="px-4 py-2 text-slate-300 font-mono">{snp.position?.toLocaleString()}</td>
                              <td className="px-4 py-2 text-white font-bold">{snp.genotype}</td>
                              <td className="px-4 py-2 text-slate-300">{snp.confidencePercent}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  // Single result
                  <div>
                    <div className="flex items-center gap-3 mb-4">
                      <CheckCircle className="w-6 h-6 text-green-400" />
                      <h3 className="text-xl font-bold text-white">Result</h3>
                      {searchResults.imputed && <span className="bg-purple-500/20 text-purple-300 text-xs px-2 py-1 rounded">Imputed</span>}
                      {searchResults.cached && <span className="bg-blue-500/20 text-blue-300 text-xs px-2 py-1 rounded">Cached</span>}
                      {searchResults.method && <span className="bg-slate-500/20 text-slate-300 text-xs px-2 py-1 rounded">{searchResults.method}</span>}
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p className="text-slate-400 text-sm">RSID</p>
                        <p className="text-white font-mono text-lg">{searchResults.rsid}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-sm">Genotype</p>
                        <p className="text-white font-mono text-lg font-bold">{searchResults.genotype}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-sm">Chromosome</p>
                        <p className="text-white font-mono">{searchResults.chromosome}</p>
                      </div>
                      <div>
                        <p className="text-slate-400 text-sm">Position</p>
                        <p className="text-white font-mono">{searchResults.position?.toLocaleString()}</p>
                      </div>
                      {searchResults.confidence && (
                        <div>
                          <p className="text-slate-400 text-sm">Confidence</p>
                          <p className={`font-bold text-xl ${
                            parseFloat(searchResults.confidence) > 0.7 ? 'text-green-400' :
                            parseFloat(searchResults.confidence) > 0.4 ? 'text-yellow-400' : 'text-orange-400'
                          }`}>{searchResults.confidencePercent}</p>
                        </div>
                      )}
                      {searchResults.proxiesUsed && (
                        <div>
                          <p className="text-slate-400 text-sm">Proxies Used</p>
                          <p className="text-white font-mono">
                            {searchResults.proxiesUsed} total
                            {searchResults.directProxies > 0 && <span className="text-green-400 ml-1">({searchResults.directProxies} direct)</span>}
                            {searchResults.chainedProxies > 0 && <span className="text-amber-400 ml-1">({searchResults.chainedProxies} chained)</span>}
                          </p>
                        </div>
                      )}
                    </div>

                    {searchResults.genotypeProbabilities && (
                      <div className="mt-4 p-4 bg-slate-700/30 rounded-lg">
                        <h4 className="text-white font-semibold mb-2 text-sm">Genotype Probabilities</h4>
                        <div className="space-y-2">
                          {['homRef', 'het', 'homAlt'].map((key, i) => (
                            <div key={key} className="flex items-center gap-3">
                              <span className="text-slate-400 text-sm w-16">{searchResults.ref && searchResults.alt ? 
                                [`${searchResults.ref}/${searchResults.ref}`, `${searchResults.ref}/${searchResults.alt}`, `${searchResults.alt}/${searchResults.alt}`][i] :
                                ['Ref/Ref', 'Ref/Alt', 'Alt/Alt'][i]}</span>
                              <div className="flex-1 bg-slate-800 rounded-full h-4 overflow-hidden">
                                <div 
                                  className={`h-full ${['bg-blue-500', 'bg-purple-500', 'bg-green-500'][i]}`}
                                  style={{ width: searchResults.genotypeProbabilities[key] }}
                                />
                              </div>
                              <span className="text-white text-sm w-12">{searchResults.genotypeProbabilities[key]}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {searchResults.topProxies && searchResults.topProxies.length > 0 && (
                      <div className="mt-4 p-4 bg-slate-700/30 rounded-lg">
                        <h4 className="text-white font-semibold mb-2 text-sm">Top Proxy SNPs</h4>
                        <div className="space-y-2">
                          {searchResults.topProxies.map((proxy, i) => (
                            <div key={i} className="flex justify-between items-center text-sm bg-slate-800/50 rounded px-2 py-1">
                              <div className="flex items-center gap-2">
                                <span className="text-slate-300 font-mono">{proxy.rsid}</span>
                                {proxy.type && (
                                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                                    proxy.type === 'direct' ? 'bg-green-500/20 text-green-300' : 'bg-amber-500/20 text-amber-300'
                                  }`}>
                                    {proxy.type}
                                  </span>
                                )}
                              </div>
                              <span className="text-slate-400">eff. r² = {proxy.r2}</span>
                            </div>
                          ))}
                        </div>
                        {searchResults.chainedProxies > 0 && (
                          <p className="text-slate-500 text-xs mt-2">
                            Chained proxies use transitive LD (proxy-of-proxy) for extended coverage
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default OpenImpute;
