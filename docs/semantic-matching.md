# AI source matching (optional, local)

**What it is:** a relevance retriever. For passages you select from a *saved* revision, it shows which approved sources (facts, terminology rules, policies) are about the same topic, ranked by cosine similarity of local text embeddings, with the exact source quote.

**What it is not:** a fact checker or a generative reviewer. A similarity score is **not** a probability and says nothing about whether a claim is true, false, supported, contradicted or in breach of a rule. It does not create findings, does not affect approval eligibility, and is never stored. Contextual AI review remains **unavailable**.

## Model and package (pinned)

| | |
|---|---|
| Package | `@huggingface/transformers` **3.8.1** (exact version, in `optionalDependencies`, locked in `package-lock.json`). Apache-2.0. |
| Model | `Xenova/all-MiniLM-L6-v2`, commit `751bff37182d3f1213fa05d7196b954e230abad9`, ONNX **q8** (`onnx/model_quantized.onnx`, 22,972,370 bytes). Apache-2.0. ONNX conversion of `sentence-transformers/all-MiniLM-L6-v2`. |
| Output | 384-dimension vectors, mean pooling, L2-normalised (so the dot product is the cosine similarity). |
| Sources | https://huggingface.co/Xenova/all-MiniLM-L6-v2 · https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2 · https://huggingface.co/docs/transformers.js/en/index |
| Upstream purpose | The upstream model card describes sentence embeddings for semantic search and similarity. It does not describe truth verification, and neither do we. |

The SHA-256 of `model_quantized.onnx` is the Hugging Face LFS hash for that commit. The hashes of the four small files (config, tokenizer, tokenizer config, special tokens) were recorded at first download (trust on first use). All five are pinned in `src/semantic-model.json` and **verified every time the worker loads the model**; a mismatch refuses to load.

## Setup (reproduction)

```
npm install              # optional package into ./node_modules (about 380 MB on disk, mostly onnxruntime and sharp binaries)
npm run fetch-model      # public model files (~23 MB) into ./.cache/models/Xenova/all-MiniLM-L6-v2, hash-checked
npm run verify-semantic  # real inference on the seed sources
npm start
```

Nothing is installed system-wide. The model path can be moved with `BRANDPROOF_MODEL_DIR`. To switch the feature off even when installed: `BRANDPROOF_SEMANTIC=off`.

## Privacy and network behaviour

- `npm run fetch-model` downloads only the public model files. No campaign text is involved.
- At run time the worker loads the model **offline**: remote model loading is disabled (`allowRemoteModels = false`, `local_files_only`). Campaign text and guideline text are processed in a worker thread on this computer and are never sent to a hosted inference service. An independent check ran the verify script with `fetch` disabled in both the main thread and the worker; inference still completed.

## How it behaves

- Source embeddings are computed once per guideline hash and cached (up to 4 guideline hashes).
- Inference runs in a worker thread so the server and UI stay responsive. One job at a time; up to 4 waiting requests, then HTTP 429. 60-second timeout stops and restarts the worker. At most 8 passages of 500 characters (2000 total) per request.
- States shown in the UI: **Ready**, **Loading model…**, **Unavailable** (with the exact reason, e.g. package or model files missing) and error. When unavailable the rest of the app is unaffected; nothing is mocked.
- Not offered for unsaved drafts, so a result can never claim a saved binding it does not have.
- **Stale results are not attached to the wrong revision:** the request carries the content and guideline hashes it was made for; the server refuses it before inference if they are out of date, and **discards** the result (409) if the latest revision or guideline hash changed during inference. The UI also drops results whose key no longer matches.
- A result is reported as **Likely relevant** (similarity ≥ 0.50), **Possibly relevant** (≥ 0.35) or **Low relevance**. These thresholds are heuristic and were set by looking at a handful of probes (below). They are not validated and not probabilities. If every match is low, the UI says no approved source looks clearly relevant and tucks the closest ones away.

## Measured verification (real model, seed guideline set v1, 13 sources)

Output of `npm run verify-semantic` on the development machine (Windows, Node 22.19, CPU). Single run; model load plus first source embedding took about 0.6 to 3.3 s across runs; with cached sources a match takes milliseconds.

| Query | Best match | Similarity | Next |
|---|---|---|---|
| How long can the lamp stay lit before recharging? | **FCT-001 Battery life** | 0.442 (possible) | FCT-004 Warranty length 0.424 |
| Can I use the lamp on the balcony when it rains? | FCT-002 Indoor use only | 0.361 (possible) | 0.251 |
| What is the body of the lamp made of? | FCT-003 Recycled content | 0.657 (relevant) | 0.335 |
| How long does the manufacturer cover repairs? | FCT-004 Warranty length | 0.345 (low) | 0.147 |
| The weather in Paris is rainy in autumn. | FCT-002 Indoor use only | 0.140 (low) | 0.094 |
| Our quarterly revenue grew faster than analysts expected. | CLM-001 Claims substantiation | 0.274 (low) | 0.154 |

Honest reading:

- The battery paraphrase retrieved the battery source first, but only narrowly ahead of the warranty source (0.442 vs 0.424). Rank is useful; the margin is thin.
- The warranty paraphrase scored 0.345, just under the "possible" threshold, so it is reported as low relevance even though the top result was correct. The thresholds are conservative.
- Unrelated text scored low (0.140). The revenue sentence's 0.274 on the claims policy is arguably topical (it is a comparative claim) and still low.
- Six queries is a smoke test, not an evaluation. No accuracy figure is claimed.
- Scores can differ by about ±0.01 between runs with different batch composition because the quantised model uses dynamic activation quantisation (the same battery sentence scored 0.442 alone with the other probes and 0.451 in the browser walkthrough, batched with a different second passage). Do not read the third decimal as meaningful.
- The browser walkthrough (`npm run ui-smoke`) selects the battery paraphrase and the weather sentence on a saved revision and checks the UI shows `FCT-001` first for the paraphrase and "No approved source looks clearly relevant" for the weather sentence.

## Known limits

- English text only (the model is English-centred); short passages work best.
- Embeds statements, not documents; guideline ingestion is out of scope.
- Relevance is topical: negations and numbers are not understood ("lasts 30 hours" is as relevant to the battery source as "lasts 12 hours").
- `npm audit` reports 2 high-severity advisories in `sharp` (libvips/libheif/librsvg image decoders), a dependency of `@huggingface/transformers` 3.8.1. BrandProof only embeds text and never passes images to the library. The suggested fix is a breaking upgrade to transformers 4.x, which has **not** been adopted because the pinned 3.8.1 was the verified version. Review before any real deployment.
- Local CPU inference only; no GPU path, no generative model, no hosted option.
