# Legal review checklist (for counsel)

Prepared 2026-10-27 for a lawyer's review before Clipbench launches cloud AI features at **clipbench.app**. I'm not a lawyer: this lists what the product actually does and the questions it raises. The answers need professional advice.

Contact used on the site: **support@bullorbear.in**. Documents to review: [`/privacy`](src/pages/privacy.astro), [`/terms`](src/pages/terms.astro), [`/licenses`](src/pages/licenses.astro), [`public/ffmpeg/SOURCE.txt`](public/ffmpeg/SOURCE.txt), [MODEL_LICENSES.md](MODEL_LICENSES.md), [PHASE4_PLAN.md](PHASE4_PLAN.md).

## What the product does with data (facts for the review)

- **Local editing:** media is processed in the browser and isn't uploaded. Projects are stored in browser storage.
- **Optional cloud AI features:** what a feature needs (text; later voice samples and video) is sent to our server and to an AI provider. Uploads are deleted 24 h after the job ends. Job content is wiped after 30 days; a minimal record (feature, time, credits, cost) is kept.
- **Optional accounts:** an email address, via Supabase Auth with a passwordless sign-in link. Anonymous users are keyed by a salted SHA-256 of their IP address; the raw IP isn't stored.
- **Processors:**
  - Supabase: database, auth and storage, in India (ap-south-1)
  - Cloudflare: Turnstile bot check
  - AI providers as features launch: Anthropic, fal.ai, Modal (US)
  - Stock libraries: Pexels, Pixabay, Openverse (search terms)
  - Hugging Face and jsDelivr: model downloads (they see the visitor's IP)
- **No tracking:** no advertising, analytics trackers or sale of data.

## Questions for counsel

### 1. Who the operator is
- [ ] The legal name and address of the operator (bullorbear.in?) to name in the privacy policy and terms.
- [ ] Governing law and jurisdiction, and dispute resolution.
- [ ] Limitation-of-liability and indemnity wording. The terms currently say only "as-is, no warranty".

### 2. India: DPDP Act 2023 and DPDP Rules 2025
Core obligations apply from about May 2027 (sources differ; confirm against the notified Rules).
- [ ] Is the privacy page enough as the itemised **notice** (Rule 3)? Is first-use consent per feature the right **consent** basis for cloud processing? Is withdrawing consent as easy as giving it?
- [ ] **Children:** the site requires users to be **18+** for accounts and cloud features (a self-declaration in the sign-in dialog and consent notice). Is that adequate, or is verifiable parental consent or age verification (Rule 10) needed?
- [ ] **Grievance redressal:** the site promises acknowledgement in 7 days and resolution within 30 days, within the 90-day limit. Does a named grievance officer or DPO contact need to be published?
- [ ] **Breach notification** process (to the Board and to affected users), and record-keeping.
- [ ] **Cross-border transfer** to US AI providers. Is it permitted? Are any restrictions or notices required?
- [ ] **Retention:** are 24 h for uploads and 30 days for job content, keeping only minimal records, acceptable? Is a stated retention period needed for account data after inactivity?

### 3. India: IT Rules amendment on synthetic content (in force 2026-02-20)
- [ ] Clipbench will **generate** synthetic audio and visuals: cloned voices, dubbing, lip sync, AI images and video. The terms promise **visible labels plus embedded provenance metadata**. What exact label wording, placement and metadata standard (C2PA?) satisfies the rule? The engineering requirement is recorded in PHASE4_PLAN.md §5.
- [ ] Is Clipbench an "intermediary" for this purpose? Most output is downloaded by the user, not published on our platform. What takedown duties apply (3 h for content flagged by a court or the government; 2 h for non-consensual intimate imagery), and through which contact?
- [ ] The pending April 2026 draft on continuously visible labels: track its status.

### 4. EU and UK users (GDPR), if the site serves them
- [ ] Lawful bases (currently described: consent for cloud features; contract for accounts; legitimate interests for abuse prevention). Is an EU/UK representative needed?
- [ ] **Data processing agreements** with Supabase, Cloudflare and each AI provider, and **transfer mechanisms** (SCCs) for India and US processing.
- [ ] Browser storage: sign-in session, consent memory and settings are all strictly necessary or functional. Confirm no cookie banner is required.

### 5. Voice, likeness and content
- [ ] The voice-cloning and lip-sync consent statement ("this is my voice, or I have permission"). Do the confirmation records need to be kept, and for how long? This tension with the 30-day redaction is unresolved.
- [ ] The prohibited-use list and enforcement wording in the terms.
- [ ] The **Remove Logo / watermark** tools: risk of facilitating copyright infringement. The terms prohibit removing others' watermarks; is more needed?
- [ ] **Stock media:** do Openverse (CC) attribution duties pass to users clearly enough? The app shows the credit line.

### 6. Open-source and model licensing
- [ ] Shipping the **GPL-2.0+ FFmpeg core** (`@ffmpeg/core-mt` 0.12.10, one documented modification) to browsers with a written source offer. Is that compliant? Is the app's own code a separate work?
- [ ] Non-commercial models (NLLB-200, F5-TTS, RMBG-1.4) are **off** by default (`PUBLIC_ALLOW_NONCOMMERCIAL_MODELS`). Does a free site run by a business count as "commercial"?
- [ ] Re-verify the model licenses listed in MODEL_LICENSES.md before each Phase 4 feature launches.

### 7. Brand
- [ ] Trademark search for "Clipbench" and the clipbench.app domain.

## Already done in the product (for the lawyer's context)
- Privacy policy with rights, grievance timelines, processors, data location, retention and an 18+ rule; terms with prohibited uses, AI labelling, grievance and takedown contact; a public licenses page.
- A first-use consent notice per cloud feature (with an 18+ reminder), and 18+ plus terms acceptance shown at sign-in.
- Upload deletion after 24 h; job-content redaction after 30 days; salted-hash IPs; no trackers.
- Non-commercial models gated off; GPL notice and written source offer shipped with the FFmpeg core.

## Sources (law-firm and news commentary; confirm against the official texts)
- DPDP Rules 2025: [SCC Online](https://www.scconline.com/blog/post/2025/12/26/digital-personal-data-protection-rules-2025-key-highlights/), [Bass Berry](https://www.bassberry.com/news/indias-data-privacy-rules-what-your-business-needs-to-know/), [Taxmann](https://www.taxmann.com/post/blog/analysis-indias-dpdp-act-and-rules/), [Khaitan & Co](https://www.khaitanco.com/sites/default/files/2025-11/ERGO%20-%20Digital%20Personal%20%20Data%20Protection%20Rules%20-%2015%20November%202025.pdf), [Storyboard18](https://www.storyboard18.com/amp/digital/breaking-govt-notifies-final-dpdp-rules-sets-staggered-rollout-with-key-obligations-for-data-fiduciaries-84201.htm)
- IT Rules 2026 (synthetic content): [iPleaders](https://blog.ipleaders.in/it-rules-2026/), [Digital Policy Alert](https://digitalpolicyalert.org/event/37705-ministry-of-electronics-and-information-technology-adopted-information-technology-intermediary-guidelines-and-digital-media-ethics-code-amendment-rules-2026-addressing-synthetically-generated-information), [Hogan Lovells](https://www.hoganlovells.com/en/publications/india-introduces-mandatory-labelling-for-ai-and-3hour-takedown-for-illegal-content), [Freshfields](https://technologyquotient.freshfields.com/post/102mjwn/india-targets-deepfakes-and-ai-generated-content-key-changes-under-meitys-2026), [S.S. Rana](https://ssrana.in/articles/india-tightens-oversight-on-ai-generated-content-under-it-rules/)
