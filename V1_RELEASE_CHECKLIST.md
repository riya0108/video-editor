# V1.0 Release Checklist

Every box must be ticked **on the release commit**, with the evidence linked, before V1.0 is declared. Status at the Phase 21 audit (`6214b8f`) is shown as ✅ (met), ❌ (not met) or ○ (not yet run).

## 0. Checkpoint

- [ ] ❌ Release commit pushed to the remote and tagged (currently 1 commit ahead of `origin/main`, untagged)

## 1. Build and automated verification (CI, clean checkout)

- [ ] ❌ CI exists and runs on every push (B-08)
- [x] ✅ `npm ci` succeeds on a clean clone (exit 0)
- [x] ✅ `npm test`: 0 failures (1226 passed locally; 1120 in a clean clone)
- [ ] ❌ Eval suites (render / export / voices) run in CI with **0 skipped for missing inputs** (B-08)
- [x] ✅ `tsc --noEmit`: 0 errors
- [x] ✅ `astro check`: 0 errors, 0 warnings
- [x] ✅ `npm run build` succeeds
- [ ] ❌ Linter configured and clean (B-08)
- [ ] ❌ Automated E2E for workflows A–I (B-08)

## 2. Workflows (on the release commit, in the production deployment)

| | Workflow | Dev, this commit | Production deployment |
|---|---|---|---|
| A | Import → edit → preview → export | ✅ | ○ |
| B | Multi-layer / text / graphics / animate → render | ✅ | ○ |
| C | Audio + captions → sync → export | ✅ | ○ |
| D | Background removal → refine → composite → export | ❌ (B-04, B-05) | ○ |
| E | Save → close → reopen → continue | ✅ | ○ |
| F | Interrupt → recover (incl. a real process crash) | ✅ simulated | ○ |
| G | Missing media → relink | ✅ | ○ |
| H | Resolutions / frame rates (ffmpeg-verified) | ✅ | ○ |
| I | Transparent export (WebM) | ✅ | ○ |

## 3. Output correctness

- [x] ✅ Preview = final (bit-identical sample frames)
- [x] ✅ Render eval: 0 failures (54/54)
- [x] ✅ Export eval: 0 failures (48/48)
- [ ] ❌ Video background removal: per-frame IoU ≥ 0.98 vs a per-frame reference on motion clips (B-04)
- [ ] ○ Real-footage matting benchmark published (per-category metrics) before any quality marketing (K-12)

## 4. Reliability and performance

- [x] ✅ 30-min 1080p export valid, peak heap < 1 GB
- [ ] ❌ 10-min video background removal completes with bounded memory (B-05)
- [ ] ○ 60-min export (K-03)
- [x] ✅ Crash recovery (simulated) on this commit
- [ ] ○ Real renderer-process crash on the release commit
- [x] ✅ Corrupt / missing / unsupported media handled (Phase 19; same import code + the WebM fix)

## 5. Security

- [x] ✅ No reachable critical / high dependency vulnerability (7 advisories assessed unreachable)
- [ ] ❌ Production responses carry COOP / COEP / CORP, CSP, nosniff, Referrer-Policy (B-01)
- [ ] ○ `transcribe-source` rate-limited, and deployment egress denied to private ranges (K-06)
- [x] ✅ SSRF guard, SVG sanitizer, no DOM-injection sinks, no committed secrets
- [ ] ○ onnxruntime-web on a stable release (K-07)

## 6. Licensing and assets

- [ ] ❌ GPL ffmpeg wasm: legal decision + compliance or replacement (B-02)
- [ ] ❌ RMBG-1.4 removed from all runtime paths, or commercial license recorded (B-03)
- [ ] ❌ Rights / credits recorded for all bundled media (B-06)
- [ ] ❌ License texts shipped for every font and model; open-source notices page (B-07)
- [x] ✅ Editor background removal uses only Apache-2.0 U²-Net (license-gated router)

## 7. Compatibility

- [ ] ○ Supported-browser list defined
- [ ] ○ Chrome / Edge / Firefox / Safari tested per that list
- [ ] ○ Windows / Linux / macOS (Intel + Apple Silicon) tested
- [ ] ○ Behaviour on unsupported browsers (no WebCodecs / OPFS) produces a clear message

## Declaration

- [ ] All of the above ticked → **declare V1.0.**
- **Current: NOT READY** (8 P1 blockers open).
