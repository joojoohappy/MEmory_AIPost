# Evidence index

Labels: **REAL** = real external execution · **TEST** = automated test · **REPLAY** = real outputs re-used locally · **MOCK** · **UNVERIFIED**

| Claim | Label | Evidence |
|---|---|---|
| Claude vision analysis + storyboard ran for sample set A (night-concert, tone bright) | REAL | `evidence/trackA/run-0954-aea64fe1…/job.json`, `film.mp4`, `contact-sheet.jpg` |
| … for sample set B (day-fair, tone quiet) | REAL | `evidence/trackA/run-0954-c9f77c8e…/` |
| … for a real multipart upload (4 files incl. MP4, tone gentle) | REAL | `evidence/trackA/run-upload-171095ce…/` (msg_011ChTEUisMZfgkowYoq9p66, msg_011ChTEVJ4ddA8t4s7VLdcRL) |
| Sanitized per-call AI log (model, msg id, latency, tokens) | REAL | `evidence/trackA/ai-calls.jsonl` |
| Phone layout + live UI flow + download | REAL + TEST | `evidence/e2e/studio-phone.png`, `organizer-phone.png`, `studio-live-result.png`; `tests/e2e/competition-studio.spec.ts` |
| ComPDF documentParsing on test PDFs A and B | REAL | `evidence/compdf/compdf-smoke-2026-11-27T09-56-*.json`, raw results `compdf-parsing-raw-*.txt` |
| ComPDF ZIP result not readable before fix; documentExtract 03000 | REAL (failures) | `evidence/compdf/compdf-smoke-2026-11-27T09-54-*.json` |
| Claude document interpretation of real ComPDF output | REAL | `evidence/trackC/interpretation-A-city-glow-…json` (msg_011ChTEf9r3Yss1nuDD7WBfK), `…B-mountain-market…json` |
| Full organizer → studio workflow on the founder's PC (7/8 pass, before the Windows render fix) | REAL | `evidence/e2e/e2e-live-2026-11-27T10-02-52-612Z.json` |
| Network-failure runs on the founder's PC (PC slept / hotspot dropped; kept as raw evidence) | REAL | `evidence/e2e/e2e-live-2026-11-27T10-06*.json`, `…T11-42*.json`; `…T11-54*.json` = 7/8 with `spawn mkdir ENOENT` |
| **Full workflow 8/8 on the founder's PC after fix `ded1a0a`** (ComPDF + Claude + import + studio render + download; film 26.02 s 720×1280 H.264/AAC) | REAL | `evidence/e2e/e2e-live-2026-11-27T11-59-23-999Z.json`, `film-b8f5a0cf-*.mp4`, `contact-sheet-b8f5a0cf-*.jpg` |
| Doc-derived policy drives a live studio job (videos excluded, header from document) | REPLAY + REAL | `evidence/trackC/studio-under-docA-6b933ea4…/` (see NOTE.md) |
| Policy rules, storyboard validation, gate, compact-schema mapping | TEST | `tests/unit/competition.test.ts` (15 tests; 80/80 overall) |
| Glows AI GPU execution | — | none (not attempted) |
| DottedSign read-only connectivity (member ok; tasks/templates 403031 security check) | REAL | `evidence/dottedsign/readonly-check-2026-11-27T12-12Z.json` |
| Public tunnel verification (read-only route and API checks) | REAL | `evidence/deploy/tunnel-check-2026-11-27T12-13-36Z.json` |

Commits: see `git log 55449f7..competition/openlab-2026`.
Approx. Anthropic spend: ≈US$0.55 by 18:00 Taipei (≈66k input / 14k output tokens on claude-opus-5-5), plus the founder-PC e2e runs afterwards (estimated under US$1 in total; check the Anthropic console). ComPDF: free trial.
