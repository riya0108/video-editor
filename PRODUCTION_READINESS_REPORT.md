# Production Readiness Report

**Decision: NOT yet production-ready. V1.0 is NOT declared.** This build is **Release Candidate 2 (RC2).**

**Engineering gates: all pass.** RC1's two blocking editor bugs are fixed and verified:
- P1-1, the Dissolve export false-fail;
- P1-2, long exports buffered in memory.

**Two gates remain, and both need action outside the code:**
- G11: the production server must send the cross-origin isolation and security headers (ops).
- G12: licensing sign-off (legal).

Per the release rule ("only declare V1.0 when all defined release gates pass"), V1.0 is withheld until they close.

## Release gates

| # | Gate | Criterion | Result | Evidence |
|---|---|---|---|---|
| G1 | Automated tests | 100 % of the suite passes | ✅ PASS | 1217/1217 (34 conditional skips) |
| G2 | Static checks and build | `tsc`, `astro check`, `astro build` clean | ✅ PASS | 0 / 0 / complete |
| G3 | Rendering correctness | Current-code renders pass the independent ffmpeg checks | ✅ PASS | 9 renders, 54/54 checks |
| G4 | Export correctness | Current-code exports pass the ffmpeg checks; cancel and refusals correct | ✅ PASS | 19 cases, 48/48 checks; 11/11 variants |
| G5 | Persistence | Save → close → reopen identical; missing media → relink identical | ✅ PASS | 12 projects, bit-identical |
| G6 | Crash recovery | Unsaved work recoverable after a crash | ✅ PASS | Simulated crash → recovered identical; Phase 17 renderer kill |
| G7 | Real-world integration | Every reference project exports **and validates** | ✅ PASS | 10/10. Project 7 (built-in Dissolve) now validates: P1-1 fixed |
| G8 | No open P0 | — | ✅ PASS | All P0s found (WebM import, Astro RCE) fixed and verified |
| G9 | No open release-blocking P1 | — | ✅ PASS | P1-1 and P1-2 fixed and verified. A 30-min 1080p export validates with a 907 MB peak heap (was ≈ 7 GB, est.). The remaining P1s are G11/G12 items or accepted (P1-3) |
| G10 | Security | No reachable critical/high vulnerability; inputs validated | ✅ PASS (with deployment conditions) | Astro RCE and SSRF fixed; 7 residual advisories unreachable; P1-4 / P2-4 need deployment configuration |
| G11 | Deployment parity | Production serves the headers the app is built for | ❌ **NOT MET** | Node server sends no COOP/COEP / security headers: **P1-4** |
| G12 | License compliance | Every distributed component licensed for the intended use | ⚠️ **NEEDS SIGN-OFF** | Editor clean. Site: GPL `ffmpeg-core-mt` distributed; RMBG-1.4 non-commercial: **P1-5** |
| G13 | Performance | No regression vs Phase 18; preview reaches source frame rate on the benchmark | ✅ PASS | Export 10.3 s, final 37.9 fps, playback ≥ 30 fps, startup 674 KB |

**Gates passing: 11 of 13. Blocked: G11 (deployment), G12 (legal).** RC1 was 9 of 13.

## What must happen before V1.0

| Gate | Action | Owner decision needed? |
|---|---|---|
| ~~G7 / G9~~ | ~~P1-1, P1-2~~ — **done in RC2** (FINAL_KNOWN_ISSUES.md, "Fixed") | — |
| G11 | **P1-4:** set `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` (plus `X-Content-Type-Options: nosniff`, `Referrer-Policy`, a CSP) on every response, at the reverse proxy or a custom Node server. Also deny the server egress to private ranges (P2-4). | Deployment / ops |
| G12 | **P1-5:** legal review of distributing GPL `@ffmpeg/core-mt`; replace RMBG-1.4 in the non-editor tools, or license it, before any commercial use. | Legal / product |

When G11 and G12 close and G1–G13 are re-run green, the build can be declared V1.0.

## Risk summary

- **Data safety:** strong. Every round trip was identical, crash recovery works, missing media is handled, and corrupt files are refused.
- **Correctness:** strong. Rendering and export are verified by an independent decoder.
- **Biggest user-facing risks:**
  - The 30-minute limit per audio file (P1-3).
  - Exports slow down with full-frame effects (P2-1).
  - (RC1's Dissolve false-fail and long-export memory are fixed.)
- **Operational risks:** missing production headers (P1-4); the unauthenticated download endpoint (P2-4).
- **Legal risks:** GPL wasm distribution; the RMBG-1.4 license (P1-5).

Full issue list: FINAL_KNOWN_ISSUES.md. Evidence: RELEASE_CANDIDATE_REPORT.md, FULL_QA_REPORT.md.
