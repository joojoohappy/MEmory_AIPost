# Acceptance — results

## Track A (consumer)
| Criterion | Result | Evidence |
|---|---|---|
| Fresh user can enter the experience | PASS | `evidence/e2e/studio-phone.png`, Playwright `competition-studio.spec.ts` |
| Real media input accepted | PASS | `evidence/trackA/run-upload-171095ce…` (multipart upload: JPEG + MP4) |
| Reflections influence the narrative | PASS | each job.json: narrative/captions reference the user's own words; verbatim reflection card in film |
| AI inference actually executed | PASS | `evidence/trackA/*/job.json` ai_calls (claude-opus-5-5, msg_… ids, tokens), `ai-calls.jsonl` |
| Structured storyboard | PASS | `storyboard` in each job.json |
| Playable film rendered | PASS | `film.mp4` per run (ffprobe: h264 720×1280 + aac) |
| Downloadable | PASS | Playwright live test downloads `memory-*.mp4`; e2e download bytes |
| Two input sets → distinct results | PASS | night-concert "燈亮起來的那一刻" vs day-fair "海邊攤位，從白天到傍晚" vs upload "第一次一個人去" |
| Invalid input / failures handled | PASS | unit tests; live: CONSENT_REQUIRED, TOO_FEW_FILES, MEDIA_UNSUPPORTED, AI_NOT_CONFIGURED |
| No undocumented mock presented as AI | PASS | no mock path in the studio; template fallback is labelled "AI 分鏡失敗・改用固定範本" |

## Track B (Glows AI) — NOT MET (deferred by founder). No claim made.

## Track C (KDAN)
| Criterion | Result | Evidence |
|---|---|---|
| Real ComPDF integration executes | PASS (documentParsing) | `evidence/compdf/compdf-smoke-*09-56*.json`, e2e report task ids |
| Test PDF enters the workflow | PASS | `samples/competition/organizer/*.pdf` (synthetic, stamped TEST ONLY) |
| AI makes an observable decision on document content | PASS | `evidence/trackC/interpretation-*.json` |
| Actionable result | PASS | proposal → confirm → `active-event.json` |
| Missing / conflicting permissions handled | PASS | doc A conflict + approval_pending; doc B all unknown + missing |
| Unknown rights cannot activate restricted content | PASS | unit tests; e2e "doc B: unknown rights cannot be force-enabled"; replay: videos/sharing stay off |
| Document info appears in consumer experience | PASS | `evidence/e2e/studio-document-derived-event.png`, `evidence/trackC/studio-under-docA-*/` |
| DottedSign test signing | NOT MET: read-only connectivity verified; account security check pending; free plan sign_task limit 0 | `evidence/dottedsign/readonly-check-2026-11-27T12-12Z.json` |

## Deployment
| Criterion | Result |
|---|---|
| Build / lint / unit | PASS |
| E2E of actual workflow | PASS: Linux (Playwright live + replay) and founder-PC live e2e 8/8 after the Windows render fix (`e2e-live-2026-11-27T11-59-23-999Z.json`) |
| No credentials leaked | PASS — keys only in gitignored `.env.local`; evidence files grepped |
| Public testing doesn't expose private media | PASS by design — unguessable job ids, no listing, 24 h TTL, delete button, beta routes 404 in public mode |
| Deployment candidate | PASS (founder-PC hosted): public quick tunnel verified 20:13 Taipei (`evidence/deploy/tunnel-check-2026-11-27T12-13-36Z.json`); uptime depends on the PC (B-8) |
