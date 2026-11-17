# OpenImpute Roadmap: Usability, Bigger Panel, AI Integration & Launch

**Goal:** make OpenImpute the easiest way to go *beyond* the ~600k SNPs on a consumer chip. Upload a 23andMe/Ancestry file, look up millions of variants your chip never measured, and see exactly how each prediction was made. No coding, no command line, no account, no server queue.

**Audience:** people who want a deeper, technical look at their own genome. That means genome hobbyists, quantified-self and biohacker types, SNPedia/Promethease users who've hit the limits of their chip, genetic genealogy enthusiasts, and bioinformatics students. They're curious and comfortable with terms like rsID, allele and LD, but most of them won't install Node, convert VCFs or run Beagle.

**Free to run:** OpenImpute stays a free app. All the computation runs in the user's browser, so there's no backend server to pay for. See [Hosting costs](#hosting-costs-short-answer-0).

---

## 0. Current state (audit, Nov 2026)

| # | Problem | Impact |
|---|---------|--------|
| 1 | **`src/` and `scripts/` are not in the repo.** `index.html` points to `/src/main.jsx`, which doesn't exist. | Nobody can run it from GitHub. This blocks everything else. |
| 2 | `package.json` script names (`convert_vcf_YAZL.js`, `merge_FULLY_STREAMING.js`) don't match the README. | Confusing. |
| 3 | Users have to build the reference panel themselves (24 GB of Node heap, tens of GB of downloads). | Almost nobody will do this. |
| 4 | There's no hosted site. Setup is `npm install && npm run dev`. | Same as above. |
| 5 | The first search on a chromosome takes 10–30 s, after the whole ~500 MB ZIP has been stored. | Feels broken. |
| 6 | Tailwind is loaded from the CDN script (meant for development only, and slow). | Should be built in. |
| 7 | Range Search is untested and probably broken, but it's visible. | Erodes trust. |
| 8 | Users can only search by rsID. | No gene/region browsing. |
| 9 | There's no accuracy benchmark. | No credibility with a technical audience. |
| 10 | Genome build and strand handling are unclear (consumer files are GRCh37, NCBI 1000G may be GRCh38). | Could silently give **wrong answers**. |

---

## Phase 1: Make it run (week 1)
- [ ] Commit `src/` and `scripts/`. Make the script names match the README.
- [ ] Install Tailwind at build time instead of loading it from the CDN.
- [ ] Hide Range Search behind an "experimental" flag until it's fixed.
- [ ] Check build and strand: make sure panel coordinates match GRCh37 (or lift over), and handle strand flips and ambiguous A/T and C/G SNPs.
- [ ] CI: lint, build, and unit tests for the parsers and the imputation math.
- [ ] `CONTRIBUTING.md`

## Phase 2: Zero setup (weeks 2–4)

### 2.1 Host it
- Deploy the app on **Vercel** (Hobby plan, free) at `openimpute.vercel.app`: connect the GitHub repo, and every push to `main` auto-deploys. Pull requests get preview URLs.
- **Keep the panel files off Vercel.** Hobby includes ~100 GB/month of bandwidth, which panel downloads would burn through after a few hundred users. Serve the panel from Cloudflare R2 or Hugging Face instead, and set CORS on that bucket to allow `openimpute.vercel.app`.

### 2.2 Prebuilt, chunked reference panel (the biggest single change)
- Build the panel once and host it as static files. Users never build it themselves.
- **Re-chunk it into region blocks** (per chromosome × 1–2 Mb, with bit-packed genotypes: 2 bits per allele per sample) plus a small index file.
  - The app fetches only the blocks it needs and caches them in IndexedDB.
  - First result arrives in seconds instead of after a 500 MB download plus 10–30 s of decompression.
- Move fetching, decompression and matching into a **Web Worker**, so the page never freezes, and show a real progress bar.

### 2.3 UX: no coding needed, with real depth
1. **Load a file.** Drag and drop, `.zip` accepted directly. Auto-detect 23andMe, Ancestry, MyHeritage, FTDNA or Living DNA, and show a summary: vendor, chip version, SNP count, inferred sex, build, call rate.
2. **Look something up.** Search by **rsID, gene, region (`chr15:28.3–28.4Mb`) or trait**, with autocomplete. Upload a list of rsIDs for batch lookups.
3. **Result view:**
   - The genotype, labelled *measured* (on the chip) or *imputed*
   - Genotype probabilities (AA/AB/BB), a dosage value, and a calibrated High/Med/Low confidence
   - **"How this was computed":** the anchor SNPs used, their distances and weights, the best-matching reference haplotypes, and the population breakdown of those matches. This is the part a technical audience will love, and nothing else makes it this visible.
   - A regional view: the user's measured SNPs vs imputed SNPs along the region, with gene track and LD context
   - Links to dbSNP, ClinVar, gnomAD and SNPedia
4. **Export** imputed results as CSV or **VCF (with dosages)**, so people can feed them into other tools (Promethease, polygenic score calculators, their own scripts).

Also:
- Clear error messages, e.g. "This looks like a VCF. Here's what we support."
- Guides showing how to download raw data from each vendor
- An **Advanced** panel to tune the window size, number of flanking SNPs and recombination settings, and to choose a population subset of the panel
- A sample genome (a public Personal Genome Project CC0 participant) so people can try it instantly
- A short "not medical advice" note on clinical variants

## Phase 2.5: A bigger, better reference panel (weeks 3–6)

The current panel is 1000 Genomes (about 2,500 people), filtered to MAF ≥5% (about 7M variants). That limits which SNPs can be looked up at all, and how accurate rare-variant results are.

| Panel | Samples | Variants | Build | Can we redistribute it? | Notes |
|-------|---------|----------|-------|-------------------------|-------|
| 1000G Phase 3 (current) | ~2,500 | ~80M | GRCh37 | Yes | Low-coverage, older |
| **1000G high-coverage 30x (NYGC)** | ~3,200 | ~120M+ SNVs and indels, phased | GRCh38 | Yes | Solid next step: more people, better calls, already phased |
| **HGDP + 1kGP harmonised (gnomAD)** | ~4,100 | ~150M+ | GRCh38 | Yes | **Best open panel**: adds ~900 people from ~80 under-represented populations, so it's more accurate for non-European users |
| Simons Genome Diversity Project | ~300 | | GRCh38 | Yes | Small; only useful merged in |
| HRC / TOPMed / UK Biobank | 32k–150k+ | | | **No** | Access-controlled or server-only. Link out to the Michigan/TOPMed servers for research-grade results |

**Plan:** move to **HGDP+1kGP**, with 1000G 30x as a fallback.

### More ways to increase how many SNPs we can compute
1. **Lower the MAF cutoff.** Chunking makes ≥1% or ≥0.5% practical: from ~7M to ~15–25M variants.
2. **Liftover.** Lift the panel to GRCh37 at build time, so no overlap is lost to coordinate mismatch.
3. **Fix strand and allele mismatches** instead of dropping those SNPs. That gives more anchor SNPs.
4. **Map rsIDs through dbSNP merge history,** so searches for old or renamed rsIDs still find the variant.
5. **Support indels and multi-allelic sites.**
6. **Use a real genetic map** (HapMap or 1000G cM maps) instead of a constant recombination rate. Better weighting means more SNPs reach "High" confidence.
7. **Merge multiple kits** (e.g. 23andMe + Ancestry). Different chips overlap only partly, so combining them gives many more anchor SNPs.
8. **Report coverage clearly:** "on your chip", "imputed (High/Med/Low)", or "not in the panel".

### Pipeline
- Rewrite `scripts/` as a reproducible pipeline: download, QC, liftover, `bcftools norm`, MAF tiers, then bit-packed blocks plus a manifest with checksums.
- Run it locally (no rental needed: a Mac mini M4 with 64 GB or an ROG Flow Z13 with 128 GB is plenty; disk space is the real limit, see below), and publish versioned blocks ("Panel v2: HGDP+1kGP, 4,091 people").
- Record licences and citations in `docs/DATA_SOURCES.md`.

## Phase 3: Prove it works (weeks 3–6, runs alongside)
- [ ] **Leave-one-out benchmark:** mask panel samples down to the 23andMe v5 / Ancestry v2 SNP sets, impute the rest, and report concordance and r² by MAF bin and population.
- [ ] Compare against Beagle and Minimac on the same task.
- [ ] Publish `docs/BENCHMARK.md` with charts and a script anyone can re-run.
- [ ] Calibrate confidence, so "90%" is right about 90% of the time.

A technical audience will judge the project on this page. It's also the core of the launch post.

## Phase 4: AI integration (weeks 5–7)

### 4.1 `@openimpute/core`
Split out the parsers, block reader, imputation and sex detection into one package that runs in both the browser and Node.

### 4.2 MCP server: `openimpute-mcp`
This lets Claude Desktop, Claude Code, Cursor and other MCP clients work with a user's genome file directly.

| Tool | What it does |
|------|--------------|
| `load_dna_file(path)` | Summary: vendor, SNP count, sex, build |
| `lookup_variant(rsid \| gene \| region)` | Measured genotype, or imputed with probabilities and the anchor SNPs used |
| `impute_region(chr, start, end)` | Batch imputation |
| `explain_variant(rsid)` | Curated, cited context (dbSNP, ClinVar, gnomAD frequencies) so the model doesn't invent facts |
| `export_vcf(...)` | Write imputed results to a VCF |

- Ship it as a **one-click Claude Desktop Extension (`.mcpb`)**, and also publish it on npm (`npx openimpute-mcp`).
- Submit it to the official MCP registry and other MCP directories.

### 4.3 Agent Skill: `skills/openimpute/SKILL.md`
- Teaches the model which tool to use when, to always report measured vs imputed results with their confidence, to cite sources and not diagnose, and how to explain things like LD and haplotype matching when asked.
- Bundles `scripts/impute.mjs` so the skill also works in Claude Code without MCP.
- Published as a plugin in a marketplace repo, so it installs with one command.

Example: *"Load my 23andMe file and tell me my genotypes across the MTHFR region, including the SNPs my chip missed."*

## Phase 5: Launch & growth (week 7 onward)

### 5.1 Get the repo ready
- [ ] README: a one-line pitch, a **GIF at the top**, a big **"Try it →"** link, a 3-step how-to, a **comparison table**, and a benchmark summary.
- [ ] GitHub topics (`genomics`, `imputation`, `bioinformatics`, `23andme`, `ancestrydna`, `snp`, `haplotype`, `mcp`, `claude-skill`), a social preview image, badges, and a tagged release.
- [ ] 5–10 `good first issue` items (vendor parsers, gene/trait entries, visualisations).
- [ ] A 60–90 s demo video using the sample genome.

### 5.2 The hook
> **"Your chip measured ~600k SNPs. OpenImpute predicts millions more in your browser, and shows you exactly how."**

Positioning:

| | Consumer report sites | Michigan / TOPMed servers | DIY Beagle/Minimac | **OpenImpute** |
|---|---|---|---|---|
| Imputes missing SNPs | ✗ | ✓ | ✓ | ✓ |
| Setup | none | account, VCF conversion, QC, queue | command line, panels, phasing | **none** |
| Time to first answer | instant | hours | hours | **seconds** |
| Shows how each call was made | ✗ | ✗ | partly | **✓** |
| Free and open source | varies | free, not open UI | ✓ | ✓ |

Angles for different crowds:
- *Technical:* "Li & Stephens-style imputation in the browser, with bit-packed chunked panels."
- *Genome hobbyists:* "Look up the SNPs your chip skipped."
- *AI crowd:* "Ask Claude about your genome with real imputation behind it."

### 5.3 Channels
| When | Channel | Angle |
|------|---------|-------|
| Soft launch | r/23andme, r/AncestryDNA, r/genetics, r/biohackers, r/QuantifiedSelf | "Look up SNPs your chip skipped." Ask for feedback. Follow each sub's rules. |
| Launch day (Tue–Thu morning US time) | **Show HN** | The engineering + benchmark story |
| Same week | r/bioinformatics, Biostars, r/javascript, Lobsters | Method, benchmark, browser performance |
| +1–2 weeks | r/ClaudeAI, MCP directories and communities | MCP server + Skill |
| Ongoing | Bluesky/X/Mastodon (genomics and bioinformatics people), dev.to/Medium posts, YouTube walkthroughs | Deep dives on specific genes/regions |
| Ongoing | PRs to **awesome lists**: awesome-bioinformatics, awesome-genomics, awesome-mcp-servers, awesome-claude-skills | Steady trickle of stars |
| Later | Genetics/bioinformatics instructors (a teaching tool for imputation and LD), genome hobbyist bloggers/YouTubers | Credibility + backlinks |

### 5.4 Write-ups to prepare
1. **"Genotype imputation in the browser: how it works and how accurate it is"**: the main launch post, built on the benchmark.
2. **"Getting more out of your raw DNA file: imputing the SNPs your chip skipped"**: for hobbyists, a walkthrough of a real region.
3. **"Giving Claude real genomics tools with MCP"**: for the AI audience.

### 5.5 Targets
- Launch week: 100–300 stars, if Show HN gets traction
- 3 months: 500+ stars, 5+ outside contributors, the MCP server listed in the major directories

---

## Hosting costs (short answer: ~$0)

Imputation runs in the user's browser, so there is **no server to pay for**. You only host static files:

| Item | Option | Cost |
|------|--------|------|
| Web app | **Vercel Hobby** (`openimpute.vercel.app`) | **Free** (the app itself is a few MB, well within limits) |
| Reference panel blocks (roughly 5–20 GB depending on MAF tier) | **Cloudflare R2**: 10 GB storage free, **bandwidth always free**, then ~$0.015/GB-month | **$0–$0.15/month** |
| | or **Hugging Face Datasets**: free hosting for public datasets | Free |
| | or **GitHub Releases** (2 GB per file, so split by chromosome) | Free |
| Panel build | Your own machine (Mac mini M4 64 GB or ROG Flow Z13 128 GB) | **$0**, plus an external SSD if you need more disk |
| Domain | `openimpute.vercel.app` | **Free** (a custom domain can be added later if wanted) |
| MCP server / Skill | Runs on the user's own machine; published to npm/GitHub | Free |

**Recommendation:** Vercel for the app, plus Cloudflare R2 *or* Hugging Face for the panel. Avoid AWS S3 or other hosts that charge for bandwidth, because a popular launch could run up a bill there. With R2 or Hugging Face, traffic spikes cost nothing.

---

## Building the panel locally

There's no need to rent a cloud machine. Memory isn't the bottleneck if the pipeline streams the data (`bcftools` processes VCFs one chromosome and one record at a time, using a few GB at most). The old 24 GB Node heap came from the script holding data in memory; a streaming rewrite removes that.

| | Mac mini M4 (64 GB) | ROG Flow Z13 (128 GB) |
|---|---|---|
| RAM | More than enough | More than enough |
| Tooling | `brew install bcftools htslib`; runs natively | **WSL2 (already set up)**: `sudo apt install bcftools tabix`. Keep data on the WSL ext4 filesystem, not `/mnt/c`, which is much slower |
| Best for | **The main build box**: quiet, low power, fine to leave running overnight | Faster for parallel jobs, but a laptop running flat-out for hours gets hot and loud |

**The real constraint is disk.** Raw HGDP+1kGP or 1000G-30x VCFs are hundreds of GB across all chromosomes, plus intermediate files. Plan for **~0.5–1 TB free**. A fast external USB-C / Thunderbolt NVMe SSD works fine. Process one chromosome at a time and delete the intermediates afterwards to keep the peak usage down.

Throughput: run 4–8 chromosomes in parallel (`xargs -P` / GNU `parallel`). Expect the full build to take hours, not days. The download is usually the slowest part.

## Suggested order of work
1. Push the missing source (blocker)
2. Build/strand check + CI
3. Hosted static app + prebuilt chunked panel + Web Worker
4. Panel v2: HGDP+1kGP, liftover, strand fixes, rsID merge map, lower MAF tiers
5. UX: gene/region search, the "how this was computed" view, VCF export, sample genome
6. Benchmark + confidence calibration
7. `@openimpute/core` → MCP server + `.mcpb` → Agent Skill
8. README/GIF/release → soft launch → Show HN → AI directories → awesome lists

## Open questions
- Use R2 or Hugging Face for the panel?
- Clinical variants at launch, or traits and genes only?
- What licence for the curated gene/trait notes (separate CC-BY data, or AGPL)?
