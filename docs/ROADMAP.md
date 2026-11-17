# OpenImpute Roadmap: Ease of Use, AI Integration & Launch

**Goal:** turn OpenImpute from a developer prototype into something a person who has never opened a terminal can use. They should be able to drop in their 23andMe or Ancestry file and get a plain-English answer in under a minute. Then launch it so people find it and star it.

**Audience:** people who are not technical. Assume the user:
- has a `.txt` or `.zip` file they downloaded from 23andMe/Ancestry, maybe after deleting their account
- does not know what an rsID, a VCF, or a reference panel is
- cares a lot about privacy (that's why "runs in your browser" matters)
- may be anxious about health results and needs careful, calm wording

---

## 0. Current state (audit, Nov 2026)

Problems that block everything else:

| # | Problem | Impact |
|---|---------|--------|
| 1 | **`src/` and `scripts/` are not in the repo.** Only config files were uploaded. `index.html` points to `/src/main.jsx`, which doesn't exist. | Nobody can run the app from GitHub. This has to be fixed first. |
| 2 | `package.json` script names (`convert_vcf_YAZL.js`, `merge_FULLY_STREAMING.js`) don't match the README (`convert_vcf.js`, `merge_panels.js`). | Confusing even for developers. |
| 3 | Users have to **build the reference panel themselves** (24 GB of Node heap, downloads from NCBI, tens of GB of disk). | Rules out 100% of non-technical users. |
| 4 | Setup means `npm install && npm run dev`. There's no hosted site. | Same as above. |
| 5 | The first search on a chromosome takes 10–30 s, and the whole ~500 MB panel ZIP must be stored first. | Feels broken to casual users. |
| 6 | Tailwind is loaded from a CDN in `index.html`. | Contradicts "100% offline" and isn't meant for production use. |
| 7 | Range Search is untested and probably broken, but it's still visible in the UI. | Erodes trust. |
| 8 | Users can only search by rsID. | Non-technical users think in terms like "lactose", "APOE", "caffeine", not `rs4988235`. |
| 9 | There's no accuracy benchmark. | Can't credibly say "this works", and that matters for both users and the launch. |
| 10 | Genome build and strand handling aren't documented (23andMe/Ancestry use GRCh37, and NCBI 1000G VCFs may be GRCh38). | Could silently give **wrong answers**. Needs checking. |

---

## Phase 1: Make it run (week 1)

- [ ] Commit `src/` and `scripts/`. Make the script names in `package.json` and the README match.
- [ ] Add a `CONTRIBUTING.md` and a one-command dev setup.
- [ ] Replace the Tailwind CDN with a build-time Tailwind install so the app really works offline.
- [ ] Hide Range Search behind an "experimental" flag until it's fixed.
- [ ] Check the genome build: make sure the panel coordinates match the build of the user's file (GRCh37), or lift over. Handle strand flips (A/T, C/G ambiguity).
- [ ] Add a basic CI workflow (lint + build + unit tests for the parser and the imputation math).

## Phase 2: Zero-setup for non-technical users (weeks 2–4)

### 2.1 Host the app
- Deploy to **GitHub Pages or Cloudflare Pages** at a short URL (e.g. `openimpute.app` or `<user>.github.io/OpenImpute`).
- Make it an installable **PWA** (service worker) so "works offline" is real and it can be "installed" like an app.
- Optional later: a **desktop app** (Tauri, small binary) for people who don't trust websites. It's the same code.

### 2.2 Ship a prebuilt reference panel (the biggest single change)
- Pre-build the panel once and host it. 1000 Genomes data is public, so redistribution is fine. Options: Cloudflare R2 (free egress), Hugging Face Datasets, or GitHub Releases (2 GB per-file limit, so split by chromosome).
- **Re-chunk the panel into small region blocks** (e.g. per chromosome × 1–2 Mb, with bit-packed genotypes: 2 bits per allele × ~2,500 samples).
  - The app downloads only the blocks it needs, using HTTP range requests or one file per block, and caches them in IndexedDB.
  - First result arrives in seconds instead of after a 500 MB download plus a 10–30 s decompression.
  - Keep a **"Download everything for full offline/privacy mode"** button for users who don't want the server to see which regions they look up. Explain the tradeoff in plain words: "We never see your DNA. In quick mode, our file server can see which *region* of the genome you looked up, but not your result."
- Move decompression and matching into a **Web Worker** so the page never freezes, and show a real progress bar.

### 2.3 Plain-language UX
A guided 3-step flow instead of a tool panel:

1. **"Add your DNA file."** Drag and drop. Accept the `.zip` directly (no unzipping). Auto-detect 23andMe, Ancestry, MyHeritage, FTDNA, or Living DNA. Show a reassuring line: *"Your file never leaves this device."* A demo with a public sample genome (a Personal Genome Project CC0 participant) lets people try it without their own data.
2. **"What do you want to know?"** Search by **gene, trait, or rsID** with autocomplete (e.g. "lactose tolerance → MCM6 / rs4988235"). Offer a curated starter list of ~30 well-understood, low-anxiety traits (caffeine metabolism, lactose, earwax type, bitter taste, eye colour, etc.).
3. **"Here's your result."**
   - Show which version of the variant they carry, and whether it was *measured* (on their chip) or *predicted* (imputed).
   - Confidence as a **traffic light** (High / Medium / Low) plus the exact %, with a "Why?" tooltip (e.g. "12 nearby markers agreed").
   - One or two plain sentences of context, with a link to more (ClinVar, dbSNP, SNPedia; check licences, since SNPedia is CC BY-NC-SA).
   - Export as PDF/CSV, plus a "share with your doctor" printout.

Other UX items:
- Friendly error messages: "This looks like a VCF file. OpenImpute currently needs a raw-data file from 23andMe/Ancestry. Here's how to download it."
- Step-by-step "How to download your raw data" guides with screenshots for each company.
- Accessibility: keyboard navigation, screen-reader labels, colour-blind-safe confidence colours, mobile layout.
- Keep a separate **"Advanced" mode** (window size, flanking SNP count, raw probabilities) for power users.

### 2.4 Safety & trust (needed for non-technical users)
- A clear **"Not medical advice"** notice. Gate high-stakes variants (BRCA, APOE, Lynch, etc.) behind a "This result can be upsetting. Learn more first" screen, with a link to finding a genetic counsellor.
- Never present imputed results as diagnostic. Always mark them "predicted".
- A privacy page: no analytics on DNA, no uploads, and a link to the source code.

## Phase 2.5: A bigger, better reference panel (weeks 3–6)

The current panel is 1000 Genomes (about 2,500 people), filtered to MAF ≥5% (about 7M variants). That limits which SNPs can be looked up at all, and how accurate rare-variant results are. Below are the openly downloadable upgrades, in order of value.

### Panel options

| Panel | Samples | Variants | Build | Can we redistribute it? | Notes |
|-------|---------|----------|-------|-------------------------|-------|
| 1000G Phase 3 (current) | ~2,500 | ~80M | GRCh37 | Yes | Low-coverage, older |
| **1000G high-coverage 30x (NYGC)** | ~3,200 (incl. 602 trios) | ~120M+ SNVs and indels, phased | GRCh38 | Yes (open) | **Recommended next step**: more people, better calls, already phased |
| **HGDP + 1kGP harmonised (gnomAD)** | ~4,100 | ~150M+ | GRCh38 | Yes (open) | **Best open panel**: adds about 900 people from about 80 under-represented populations, so it's more accurate for non-European users |
| Simons Genome Diversity Project | ~300 | | GRCh38 | Yes | Small; only useful merged in for diversity |
| HRC / TOPMed / UK Biobank | 32k–150k+ | | | **No**: access-controlled, or server-only | Can't ship these in-app. Instead, *link out* to the Michigan/TOPMed servers for users who need research-grade results |

**Plan:** move to the **HGDP+1kGP harmonised panel**, with the 1000G 30x set as a fallback if phasing or QC is easier there. That's about 60% more reference people and much better coverage of African, South Asian, Middle Eastern, Oceanian and Native American ancestry.

### Other ways to increase how many SNPs we can answer for
1. **Lower the MAF cutoff.** The chunked, bit-packed block format from Phase 2.2 makes MAF ≥1% or even ≥0.5% practical, because users only download the blocks they need. That goes from about 7M variants to 15–25M.
2. **Liftover / build handling.** Consumer files are GRCh37 and the new panels are GRCh38. Lift the panel coordinates to GRCh37 once at build time, or lift the user's file on load, so no overlap is lost to coordinate mismatch.
3. **Fix strand and allele mismatches** (flip strand, then drop only ambiguous A/T and C/G SNPs that can't be resolved from allele frequency). Today these are probably being dropped or miscalled, which reduces the anchor SNPs available.
4. **Map rsIDs through dbSNP merge history.** Many chip rsIDs have been merged or renamed, and a lookup table lets a search for an old or new rsID find the variant. This is cheap and recovers a lot.
5. **Support indels and multi-allelic sites.** The current approach is mostly biallelic SNPs.
6. **Use a real genetic map** (HapMap or 1000G-derived cM maps) instead of one constant recombination rate. This improves weighting, so more SNPs reach "High" confidence.
7. **Use more of the user's own data.** Accept more vendors (MyHeritage, FTDNA, Living DNA) and allow **merging two kits** (e.g. 23andMe + Ancestry). Different chips overlap only partly, so combining kits gives many more anchor SNPs.
8. **Report coverage honestly.** For any lookup, say: "on your chip", "predicted (High/Med/Low)", or "not in the reference panel". The benchmark from Phase 3 should be split by panel and MAF tier, so it's clear what each upgrade actually buys.

### Pipeline work
- Rewrite `scripts/` as a reproducible pipeline: download, QC, liftover, normalise (`bcftools norm`), MAF tiers, then bit-packed region blocks plus a manifest with checksums.
- Run it once (on a cloud VM; it needs more RAM than a laptop) and publish the blocks to R2 or Hugging Face with a version number, so the app can say "Panel v2 (HGDP+1kGP, 4,091 people)".
- Record the data licence and citations for each panel in `docs/DATA_SOURCES.md`.

## Phase 3: Prove it works (weeks 3–5, runs alongside Phase 2)

- [ ] **Accuracy benchmark:** take 1000G samples, mask them down to the 23andMe v5 / Ancestry v2 SNP sets, impute the hidden SNPs with that sample left out of the panel (leave-one-out), and report concordance by MAF bin and by ancestry.
- [ ] Compare against Beagle/Minimac on the same task (they'll win, but showing *how close* the browser gets is the story).
- [ ] Publish the results in the README and in `docs/BENCHMARK.md`, with a script anyone can re-run.
- [ ] Use the results to **calibrate confidence**: a "90% confidence" label should be right about 90% of the time.

## Phase 4: AI integration (weeks 4–6)

### 4.1 Extract a reusable core
Split the logic into a package `@openimpute/core` that runs in both the browser and Node. It would contain the parsers, panel block reader, imputation, and sex detection. Everything below builds on this.

### 4.2 MCP server (works with Claude Desktop, Claude Code, Cursor, ChatGPT desktop and other MCP clients)
`openimpute-mcp` runs **locally**, so the DNA stays on the user's machine. Tools:

| Tool | What it does |
|------|--------------|
| `load_dna_file(path)` | Parses the raw file and returns a summary (vendor, SNP count, inferred sex, build) |
| `lookup_variant(rsid \| gene \| trait)` | Returns the measured genotype if it's present, otherwise imputes it |
| `impute_region(chr, start, end)` | Batch imputation (once Range Search is fixed) |
| `explain_variant(rsid)` | Returns curated, cited context so the model doesn't make things up |

- Package it as a **one-click Claude Desktop Extension (`.mcpb`)**, which is key for non-technical users: double-click to install, no JSON config.
- Submit it to the official MCP registry and other MCP directories.

### 4.3 Agent Skill (`skills/openimpute/SKILL.md`)
A Claude Skill that teaches the model *how to use OpenImpute responsibly*:
- When to call which tool, and to always say whether a result is "measured" or "predicted" plus its confidence
- Wording rules: no diagnoses, suggest a genetic counsellor for high-impact variants, cite sources
- A bundled script (`scripts/impute.mjs`) so the skill also works in Claude Code without the MCP server
- Publish it as a plugin in a marketplace repo, so users can install it with one command

Example user flow: *"Here's my 23andMe file. Do I have the lactose tolerance variant?"* → the AI loads the file locally, finds the SNP isn't on the chip, imputes it with 94% confidence, and explains the result in plain language with a caveat.

## Phase 5: Launch & growth (week 6 onward)

### 5.1 Get the repo ready before any promotion
- [ ] README rewrite: one-line pitch, **animated GIF/screenshot at the top**, a big **"Try it in your browser →"** link, "Your DNA never leaves your device", a 3-step how-to, and a comparison table.
- [ ] GitHub topics (`dna`, `genomics`, `23andme`, `privacy`, `imputation`, `bioinformatics`, `mcp`, `claude-skill`), a social preview image, badges, a first tagged release.
- [ ] 5–10 `good first issue` items (new vendor parsers, translations, trait entries), so visitors can become contributors.
- [ ] A short demo video (60–90 s) using the public sample genome.

### 5.2 The hook
**Timely angle:** after 23andMe's 2025 bankruptcy and sale, millions of people downloaded their raw data and deleted their accounts. They now hold a file and have no private way to use it.
> *"You downloaded your 23andMe data. Here's a free, open-source way to explore it without uploading it anywhere."*

Secondary angles: "Genotype imputation running entirely in your browser" (technical crowd), and "Ask Claude about your DNA, privately" (AI crowd).

### 5.3 Channels (in order)
| When | Channel | Angle |
|------|---------|-------|
| Soft launch | r/23andme, r/AncestryDNA, r/genetics, r/SNPedia-type communities | Ask for feedback, not stars. Follow each sub's self-promotion rules. |
| Launch day (Tue–Thu morning US time) | **Show HN** | The technical story: Li & Stephens in the browser, chunked panel, benchmark numbers |
| Same week | r/privacy, r/selfhosted, r/bioinformatics, r/javascript, Lobsters | Privacy / local-first / technical write-up |
| +1 week | Product Hunt | Non-technical, consumer angle |
| +1–2 weeks | MCP and Claude communities, MCP directories, r/ClaudeAI | MCP server + Skill |
| Ongoing | Bluesky/X/Mastodon (genomics and bioinformatics people), a blog post on dev.to or Medium, YouTube/TikTok short-form demos | "What your DNA file can tell you" (no medical overpromising) |
| Ongoing | PRs to **awesome lists**: awesome-bioinformatics, awesome-privacy, awesome-mcp-servers, awesome-claude-skills | Steady trickle of stars |
| Later | Write to genetic genealogy bloggers/YouTubers, and university genetics courses (a teaching tool for imputation) | Credibility + backlinks |

### 5.4 Write-ups to prepare
1. **"How I built genotype imputation that runs in your browser"**: technical, with diagrams and benchmark charts. For HN and dev.to.
2. **"What to do with your 23andMe raw data, privately"**: a consumer guide. For Reddit and SEO.
3. **"Giving Claude safe access to your DNA with MCP"**: for the AI audience.

### 5.5 Targets (realistic)
- Launch week: 100–300 stars, if Show HN gets traction
- 3 months: 500+ stars, 5+ outside contributors, the MCP server listed in the major directories
- Track: stars, demo-site visits (privacy-respecting analytics on page views only, nothing on DNA data), and issues opened by non-developers. That last one shows you're reaching the target audience.

---

## Suggested order of work

1. Push the missing source (blocker)
2. Build/strand check + CI
3. Hosted PWA + prebuilt chunked panel + Web Worker
3b. Panel v2: HGDP+1kGP, liftover, strand fixes, rsID merge map, lower MAF tiers
4. Guided 3-step UX with gene/trait search and the demo genome
5. Benchmark + confidence calibration
6. `@openimpute/core` → MCP server + `.mcpb` → Agent Skill
7. README/GIF/release → soft launch → Show HN → Product Hunt → AI directories → awesome lists

## Open questions for the maintainer
- Domain name and hosting budget (R2/Pages are free at this scale)?
- How far into health topics to go: traits only at launch, or include clinical variants behind the warning screen?
- Is a desktop app (Tauri) worth it, or is the PWA enough?
- Licence of the curated trait/explanation content (it needs to be compatible with AGPL, or kept as separate CC-BY data)?
