# Phase 4 plan: AI cloud features on daily free credits

Status: **plan for review. Nothing is built.** Prices come from 2026 sources (listed at the end) and must be re-checked against each provider's own pricing page before launch.

## 1. Goal and principles

Add the AI features that can't run in a browser: dubbing, voice cloning, script-to-video, AI images, lip sync and caption translation. They run on our own GPU and API budget, and every user gets **free credits that refill daily**. There's no paid plan.

1. **The free budget must be impossible to overspend.** Limits apply per user, per day, per feature, and globally. Each provider dashboard also gets a hard spending cap as the last line of defense.
2. **Clear about what leaves the device.** Everything up to Phase 3 runs locally. Phase 4 features upload only what the user sends to that feature. The user confirms this the first time, and uploads are deleted within 24 hours.
3. **Prefer self-hosted open models with commercial licenses.** They cost 10–50× less than turnkey APIs. Each license is verified (code *and* weights) before integration and added to `MODEL_LICENSES.md` and `/licenses`.
4. **Results land on the timeline as ordinary clips.** Cloud output becomes normal clips, tracks and generated assets that can be undone, edited and saved, exactly like Phase 3.
5. **Ship cheapest-first.** Each feature launches behind a flag. We measure real cost per active user, then tune the credit prices.

## 2. Credits

| | Proposal | Why |
|---|---|---|
| Credit value | **1 credit = $0.01 of our provider cost**, rounded up, with a 1.5× safety margin on estimates | Credits map directly to the budget |
| Signed-in allowance | **50 credits/day** (max $0.50/user/day) | Enough for ~10 min of dubbing, or 50 AI images, or many scripts |
| Without an account | **10 credits/day** per device+IP, AI images and text features only | Lets people try it without becoming an abuse loophole for GPU-heavy jobs |
| Reset | Daily at 00:00 UTC. **Unused credits don't roll over.** | Caps exposure per day |
| Global cap | `GLOBAL_DAILY_BUDGET_USD`, **start at $25/day** | When it's reached, cloud features pause until reset with a clear message; local features are unaffected |
| Per-feature caps | e.g. lip sync ≤ 2 min/day, dubbing ≤ 10 min/day, video generation off at first | Stops the most expensive features from eating the whole pool |

**How a job is charged:**
1. When a job is submitted, the server **reserves** the estimated credits, refusing if the balance is too low.
2. When the job finishes, the reservation **settles** at the actual cost (never above the estimate).
3. If the job fails on our side, the credits are **refunded**.

All of this is recorded in an append-only ledger, which also records the real provider cost. That cost is what the global cap counts.

**Budget math:**
- Worst case is `users × 50 × $0.01`.
- Expected cost is `AI-active users × average credits used × $0.01`. For example, 1,000 AI-active users each using 15 credits a day costs **$150/day**, so the $25 cap would pause features mid-day.
- The cap should rise only with evidence. The admin view (milestone M0) shows spend by feature and by hour, so it can be tuned on real data.

## 3. Feature pipelines

Credit numbers below are initial estimates, to be re-measured in each milestone.

| # | Feature | How it works | Model / provider (license) | Est. cost | Credits |
|---|---|---|---|---|---|
| 1 | **Caption translation** (brings back the feature gated in Phase 3) | Captions are sent as structured cues, and the model returns the same cue IDs translated, so timing is kept | Claude **Haiku 5.5** via the Anthropic API ($0.10 in / $0.50 out per million tokens) | < $0.001 per 10 min of captions | 1 per 200 cues |
| 2 | **AI script writer**: hooks, scripts, titles, descriptions, hashtags | A prompt or the existing transcript goes to the LLM, which returns structured output inserted as text, notes or captions | Claude Haiku 5.5 | ~$0.001 | 1 |
| 3 | **Script-to-video** (InVideo's core feature) | The LLM writes a scene plan. For each scene: footage from the **existing stock library**, a voiceover from **Kokoro in the browser (free)**, and captions from the voiceover timing. Music comes from Openverse. Everything is assembled on the timeline with existing operations, with optional AI images for scenes with no stock match | Haiku 5.5, plus #4 when needed | $0.001–0.03 | 2 + 1 per AI image |
| 4 | **AI images**: B-roll, backgrounds, thumbnails | Text → image, added as an image layer or used as a background | **FLUX.1 [schnell]** (Apache-2.0) on fal.ai (~$0.003 per megapixel) | ~$0.003 | 1 |
| 5 | **Voice cloning TTS** (brings back cloning commercially) | A 10–30 s voice sample plus text produces speech in that voice. The user must confirm they have the right to use the voice | **Chatterbox** (MIT, built-in watermark) or **CosyVoice2** (Apache-2.0), self-hosted on serverless **L4** GPUs (~$0.80/h) | ~$0.003/min of speech | 1 per min |
| 6 | **AI dubbing** | The transcript (local Whisper, free) is translated (#1), re-voiced segment by segment in the speaker's cloned voice (#5), and each segment's timing is fitted (time-stretched up to ±15%, done locally). Music and effects are kept through the **existing stem separation** (local). The result is a new voice track; the original is muted, not deleted | #1 + #5 | ~$0.005/min per language (ElevenLabs is ~$0.33–0.50/min; kept as a quality fallback) | 3 per min per language |
| 7 | **Lip sync**: mouth movement matches the new audio | Video + audio → lip-synced video, added as a generated clip | **LatentSync** (Apache-2.0 per its mirror; weights to be verified) or **MuseTalk** (MIT code; weights license conflicts — verify), on serverless **A10/L40S** GPUs | est. $0.05–0.15/min (to be measured) | 15 per min; ≤ 2 min/day |
| 8 | **Text/image-to-video generation** | Prompt → 5 s clip | **Wan 2.2** (Apache-2.0) via a hosted API (~$0.40 per clip) | ~$0.40/clip | 40; **off until M5** |
| — | AI avatars | Not planned: high cost, licensing and misuse risk. Revisit after M5 | — | — | — |

**Licenses still to verify** (weights, not just code) before each feature ships: Chatterbox, CosyVoice2, LatentSync, MuseTalk and Wan 2.2. Whisper (MIT), Kokoro (Apache-2.0) and FLUX.1 [schnell] (Apache-2.0) are already known to be fine.

## 4. Architecture

```text
Browser (Studio) ── sign in (Supabase Auth) ──┐
   │  POST /api/jobs {feature, params, upload refs}
   ▼                                          ▼
Node server (server.mjs + Astro API routes) ── Postgres (Supabase):
   │  verify user · Turnstile · reserve credits    users, credit_ledger, jobs, provider_costs
   │  enqueue job                              Object storage (Supabase Storage or R2):
   ▼                                              uploads + results, 24 h auto-delete
Job worker (same repo, separate process)
   ├─ Anthropic API (Haiku 5.5)          LLM: translation, scripts, scene plans
   ├─ fal.ai                             FLUX schnell images; hosted Wan 2.2 later
   └─ Modal (serverless GPU)             self-hosted Chatterbox/CosyVoice2, LatentSync/MuseTalk
   │  settle credits with the real cost · write result · notify
   ▼
Browser polls GET /api/jobs/:id → downloads result → adds it to the timeline as a generated asset
```

- **Accounts:** Supabase Auth with email magic link and Google. Supabase is already connected to this workspace, and its free tier covers launch. The server verifies its sign-in tokens.
- **Abuse prevention:**
  - Cloudflare **Turnstile** on job creation and sign-up.
  - The existing per-IP rate limits, plus a per-user limit of 2 jobs at a time.
  - A disposable-email blocklist, and a cap on how many devices one account can use per day.
- **Jobs:** a Postgres table used as a queue (`FOR UPDATE SKIP LOCKED`), so no new infrastructure is needed. Jobs move from `queued` → `running` → `succeeded` / `failed` / `cancelled`. They can be retried, and cancelling refunds credits.
- **Cost tracking:** every provider call records its real cost (tokens, GPU seconds, per-image price) in the ledger. That record drives both the global cap and the admin view.
- **Final safety net:** hard spending limits set in the Anthropic, fal.ai and Modal dashboards, slightly above the global cap.

## 5. Privacy, consent and policy (must ship with M0)

- **First-use consent per feature:** "This feature runs on Clipbench's servers. The audio/video you send is uploaded, processed and deleted within 24 hours. It isn't used for training."
- **Update the site's wording.** The "nothing is ever uploaded" claims on the homepage, Studio start screen and footer become: "Editing runs on your device. AI cloud features upload only what you send them."
- **New pages:** a privacy policy and terms of use. They need to cover processors (Anthropic, fal.ai, Modal, Supabase), retention, voice-cloning consent, and prohibited uses (impersonation, non-consensual likeness, deceptive political content, sexual content).
- **Voice cloning and lip sync:** a "this is my voice, or I have permission" confirmation, kept with the job. Output is watermarked where the model supports it (Chatterbox does). An abuse report link.
- **Image prompts:** provider safety filters stay on, plus a cheap moderation check of the prompt before generation.
- **AI labelling (required by India's IT Rules amendment, in force since 2026-02-20):** every output of a generative cloud feature (cloned voice, dub, lip sync, AI image, generated video) gets a **visible label** and **embedded provenance metadata** (C2PA where feasible, plus an audio watermark for speech, which Chatterbox includes). This is a ship blocker for M2–M5; the exact wording and standard are for counsel ([LEGAL_REVIEW.md](LEGAL_REVIEW.md) §3).
- **Age:** accounts and cloud features are 18+ (DPDP Rules treat under-18s as children needing verifiable parental consent).

## 6. Milestones

Each milestone ships behind a flag, gets tested end to end, and is watched for a week of real cost data before the next one starts.

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 Foundations** | Accounts, credit ledger (reserve/settle/refund, daily reset, global cap, kill switch), jobs API + worker, uploads with 24 h deletion, Turnstile, consent dialogs, privacy/terms pages, wording updates, admin spend view | A fake job runs end to end; credits can't go negative under concurrent submissions (tested); the global cap pauses jobs; provider dashboard caps set |
| **M1 Text AI** | #1 caption translation, #2 script writer | Translation keeps cue count and timing exactly (tested); cost per call measured |
| **M2 Images & script-to-video** | #4 AI images, #3 script-to-video | A 60 s video is built from one prompt using stock + Kokoro + captions; one undo removes it |
| **M3 Voice** | #5 voice cloning TTS, #6 dubbing | A 2 min clip dubbed into 2 languages: timing within ±150 ms per segment, music kept, cost ≤ estimate |
| **M4 Lip sync** | #7 | Lip-synced dub of a talking-head clip; GPU seconds per minute measured; daily cap enforced |
| **M5 (optional)** | #8 video generation | Only if the M1–M4 cost data leaves budget room |

## 7. Decisions needed before M0

1. **Allowance and cap:** 50 credits/day signed in, 10 without an account, a $25/day global cap to start. Adjust these?
2. **Accounts:** Supabase Auth (recommended), or another provider?
3. **GPU host:** Modal (recommended: simplest, per-second billing) or RunPod (reported 13–40% cheaper; more operational work)?
4. **Sign-in:** required for voice, dubbing and lip sync (recommended), and optional for text and images?
5. **Legal:** who writes the privacy policy and terms, and what's the contact address? The same address is needed for the FFmpeg GPL offer from Phase 3.

## Sources

Checked 2026-10-27. Several are third-party trackers; confirm on each provider's own page.

- ElevenLabs dubbing API pricing: [Puter breakdown](https://developer.puter.com/tutorials/elevenlabs-api-pricing/), [Seedance](https://www.seedance.tv/blog/elevenlabs-dubbing-cost-per-minute), [UsagePricing change log](https://www.usagepricing.com/blueprint/activity/elevenlabs-2026-09-28-v3-conversational-dubbing-v2), [Perso.ai comparison](https://perso.ai/blog/ai-dubbing-pricing-2026-cost-breakdown-for-every-major-tool)
- fal.ai pricing and FLUX schnell: [fal.ai docs](https://fal.ai/docs/documentation/model-apis/pricing), [Price Per Token](https://pricepertoken.com/image/model/black-forest-labs-flux-schnell), [Gurubase](https://gurubase.io/g/fal-ai/price-of-flux1-on-fal-ai)
- Open voice cloning models (Chatterbox, CosyVoice2, Kokoro): [tts.ai guide](https://tts.ai/blog/open-source-text-to-speech-guide-2026/?lang=ru)
- Modal GPU pricing: [Morph](https://www.morphllm.com/modal-pricing), [Spheron](https://www.spheron.network/blog/modal-gpu-pricing-2026-per-second-billing/), [Blaxel](https://blaxel.ai/blog/modal-pricing-alternatives-guide)
- Lip sync licenses: [LatentSync mirror](https://sourceforge.net/mirror/latentsync/), [MuseTalk on GitHub](https://github.com/TMElyralab/MuseTalk), [MuseTalk model card](https://huggingface.co/TMElyralab/MuseTalk/blob/main/README.md)
- Claude Haiku 5.5 pricing: [eesel](https://www.eesel.ai/blog/claude-haiku-5-5-pricing), [Let's Data Science](https://letsdatascience.com/news/anthropic-releases-claude-haiku-55-with-lower-prices-and-eff-f698c663)
- Wan 2.2: [anotherwrapper](https://anotherwrapper.com/tools/llm-pricing/video-models/wan-22-a14b), [Spheron](https://www.spheron.network/blog/kling-ai-alternative-self-host-wan-and-ltx-video-2026/), [Atlas Cloud](https://www.atlascloud.ai/blog/guides/self-host-wan-vs-api)
