# Built-in llama.cpp runtime in twoody-server, and the « Moteur » setting

Status: design, 29/09/2026. Sequenced after docs/multi-computer-design.md.
Goal: a Pi / Linux server / Docker runs Twoody with no Ollama, on the same
llama.cpp and GGUF models as the Desktop; each computer has a « Moteur »
preference (auto | builtin | ollama | lmstudio | mlx | custom).

## 1. Binaries
- Same pinned release as the Desktop: llama.cpp `b11146` (twoody-desktop/scripts/fetch-runtime.mjs),
  assets `llama-b11146-bin-ubuntu-arm64.tar.gz` (Pi, CPU), `...-ubuntu-x64.tar.gz` (CPU),
  `...-macos-arm64.tar.gz` (Metal). Tag + SHA-256 in one place: `src/builtin/runtimeManifest.ts`,
  which the Desktop's fetch script imports.
- Linux CPU-only in v1 (Vulkan later); no official Linux CUDA build → NVIDIA stays on Ollama.
- Hosts allowlisted: github.com, objects.githubusercontent.com, release-assets.githubusercontent.com; redirects checked by hand.
- npm: lazy download (`twoody-server runtime install` or first model install from an app), never postinstall.
  Hash check, extract with system tar into `DATA_DIR/runtime/b11146-<platform-arch>/`, VERSION stamp, atomic rename; Desktop's KEEP/DROP filters (incl. `ggml-cpu-*` variants).
- Docker: baked in the image; final stage `node:22-trixie-slim` (glibc 2.41) + libgomp1; build fails if `ldd llama-server | grep "not found"`.
- systemd: `scripts/install-linux.sh` runs `twoody-server runtime install`.
- Gate: official arm64 build ≥ 0.9× Ollama speed on the Pi, else our own CI build (ubuntu-24.04-arm, `GGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16`) from the same tag, released by Osmove, hash pinned.

## 2. Shared code: owned by the server, reused by the Desktop
New `src/builtin/`: `catalog.ts` (← Desktop modelCatalog.ts), `downloads.ts` (← modelDownloads.ts),
`acceleration.ts` (← runtimeAcceleration.ts), `failure.ts` (← runtimeFailure.ts),
`manager.ts` (← builtinRuntime.ts as `createRuntimeManager({binaryDir, modelsDir, stateDir, log, env})`, no Electron),
`runtimeManifest.ts`, `fetchRuntime.ts`, `engine.ts`, `prefs.ts`, `index.ts` (export `"./builtin"`).
Desktop: builtinRuntime.ts becomes a thin Electron adapter; the four modules become re-exports via alias
`@twoody/builtin` → `../twoody-server/src/builtin` (bundle-server.mjs already builds from that checkout).
One process manager only: the Desktop starts its embedded server with `TWOODY_RUNTIME_OWNER=desktop`
(the server never spawns llama-server then; install routes answer `409 managed_by_desktop`).

## 3. Headless process management
Router mode like the Desktop: `--host 127.0.0.1`, ports from 47831, `--models-dir DATA_DIR/models`,
`--models-max 1`, `--offline`, `--no-webui`, `--cors-origins http://twoody.invalid`, `--parallel 1`;
minimal env (PATH, HOME, TMPDIR, per-launch `LLAMA_API_KEY`); `runtime.pid`, and a leftover llama-server is
stopped only if its command line has our models dir.
- Started on demand (`manager.ensure()` on a chat to the built-in engine); status/heartbeat never start it.
- First start of a release (10/10/2026): Metal compiles its shader library before llama-server answers
  anything (`--list-devices` and the CPU build included, the same program on a Mac): 16–40 s on an M5 with an
  empty cache, more on a busy or modest computer. The GPU check and the start wait up to 3 min each
  (`PROBE_TIMEOUT_MS`, `START_TIMEOUT_MS` in acceleration.ts); a check cut short leaves the cache empty and
  the next launch pays again. The CPU is tried after a GPU process that exited, or one still silent at the
  end only where the CPU build is another program (Vulkan) — `retryOnCpu()`. The Desktop falls back to the
  CPU after a model load only when the router reports it `failed`, not when it was slow.
- Idle unload `--sleep-idle-seconds` 30 min default.
- Memory check: MemAvailable ≥ size × 1.15 + KV, else `507 insufficient_memory`.
- Pi defaults: threads = cores (4), `--ctx-size 8192` on ARM Linux, Desktop's builtinContextSize() elsewhere, mmap on.
- `addRuntimeKey(baseUrl, key)` in src/runtimeAuth.ts. SIGTERM/SIGINT stop the runtime; unit `KillMode=control-group`,
  `TimeoutStopSec=10`; compose `init: true`; crash restart ≤ 3 with backoff.

## 4. « Moteur »
`DATA_DIR/runtime.json` (0600), per computer, overridable by `TWOODY_RUNTIME`, re-read on mtime change:
`{engine:"auto"|"builtin"|"ollama"|"lmstudio"|"mlx"|"custom", custom_url?, builtin:{default_model?, idle_minutes?, preload?, ctx?, threads?}}` (`idle_minutes` 0: never
released; unset: kept while the server runs when MemAvailable holds the model twice over, else 30;
`preload` false: no model loaded at startup; files carry `"v": 2`, and an older file's `idle_minutes: 30` is read as unset).
Auto = first engine with a chat model: builtin → Ollama :11434 (or TWOODY_OLLAMA_URL) → LM Studio :1234 → mlx-lm :8080 (macOS).
`engine.ts` exports `resolveEngine() → {id, baseUrl, models, reason}`.
Routes `src/routes/runtime.ts` (owner session only, peers 403):
- `GET /runtime` → `{preference, active:{id, reason}, engines:[{id,name,reachable,models}], builtin:{installed, version, platform, acceleration, running, loaded_model, failure, managed_by}}`
- `PUT /runtime {engine, custom_url?}`
- `GET /runtime/catalog` (installed, recommended, fits)
- `POST /runtime/models {id}` → `202 {job}` (states runtime → downloading → verifying → done); `GET|DELETE /runtime/jobs/current`
- `DELETE /runtime/models/:id`
`/local_llm/*` stays for Ollama. Downloads the person asked for are allowed under TWOODY_LOCAL_ONLY (allowlisted hosts, logged).
Surfacing: non-stored provider `{id:"engine", kind:"local_openai", name:"Twoody (llama.cpp)", models}` in /providers
(queries.ts resolves "engine"); statusSource.localRuntimes() active engine first; loadedModels() asks the manager;
`ComputerStatus.engine?`; router defaultModel() falls back to builtin.default_model.
UI: Desktop `EngineSettings.tsx` in PrivateSettings (this Mac), `ModelsPanel.tsx` on /runtime (replaces Ollama-only
« Twoody Pi »), opened per computer from ComputersPanel; iPhone « Moteur » row + « Modèles » per computer through its
computerKey route; CLI `twoody-server config get|set runtime=…`, `runtime install|status`, `models list|add|rm`.

## 5. Migration
No runtime.json on first start: BRIDGE_LOCAL_LLM_ENDPOINT on :11434 → `ollama` (Jimmy's Pi unchanged), elsewhere → `custom`,
unset → `auto`. Switch: `config set runtime=builtin`, `models add Qwen3.5-4B-Q4_K_M`; default model reset; the apps offer
(never automatically) to remove Ollama models. Compose: one container by default, `ollama` under `profiles: ["ollama"]`
with `TWOODY_OLLAMA_URL`. README Pi section on built-in, Ollama for NVIDIA.

## 6. Tests
Manifest digests/tag parity; fetch against a local mirror (bad hash, off-allowlist redirect, atomic install); ported
download tests; resolveEngine table; manager with a fake llama-server script (flags, loopback, key, idle, leftovers,
memory refusal); routes (auth, peers, 409 in Desktop); status/rank see built-in models; CI smoke with a tiny GGUF
(TWOODY_MODEL_CATALOG). Pi: separate install in ~/twoody-next on port 3031, never touching HA, firmware services,
the old server on 3030 or the Ollama service; speed gate vs Ollama with nothing loaded; think off, 401 without key,
127.0.0.1 only, idle unload, leftover stop after kill -9.

## 7. Lots
A server core (src/builtin/* only, now) · B server integration (after multi-computer) · C packaging (with B) ·
D Desktop (after A) · E iPhone (after B's API) · F CLI (after B).
Risks: glibc / missing dotprod variant, SD card speed, backend heartbeat validation of `engine`, engine-specific model
names, two managers in the Desktop, local-only wording, Pi heat, supply chain (hashes pinned), LICENSE.llama.cpp shipped.

## 8. A larger model, switching, and « Prêt » (11/10/2026)
Jimmy: « ajoute un modèle plus grand au moteur intégré », « il faudrait que je puisse switcher », « que je voie
l'avancement … à quel moment je peux commencer à l'utiliser sans avoir un long time to first token ».
- **The larger model**: Qwen3.6 35B-A3B (a mixture of experts: 35 B parameters, 3 B at work per token), bartowski's
  IQ3_XXS with imatrix (15.76 GB, Apache 2.0, pinned by revision and SHA-256, its vision file too). No 4-bit file fits
  a 24 GB Mac (Metal's share there: 17.8 GiB; ggml-org's Q4_K_M is 20.4 GB) and neither Qwen nor ggml-org publish a
  3-bit one. `larger: true` in catalog.ts: offered beside the 4B and 9B where it fits (`minRamGb` 24; the Desktop's
  model screen leaves it out below, unless installed), never recommended first. Set aside: Qwen3.8 27B (dense, 3 bits,
  13.5 GB): 57 tokens read a second, 3.3 written, +4.7 GB of swap on Jimmy's Mac.
- **Its runtime settings**: a model whose file is more than 45 % of the memory (runtimeArgs.ts `largeForMemory`)
  gets 1 GiB of prompt cache and 8 checkpoints instead of 4 GiB and 16: 14.5 GiB in all at 32 768 tokens (14.2 of
  weights, 0.34 of cache, 0.06 of recurrent state, 0.16 of work buffers), 15.6 GiB with its vision file, all 42
  layers on the GPU (whose share is 17.8 GiB on a 24 GB Mac); the free memory dropped 15.1 GB (the 9B: 7.4 GiB).
- **Switching**: the router holds one model (`--models-max 1`): choosing another (the Desktop's picker, the iPhone's
  sheet) loads it and lets go of the one before — said under the models of this computer (« Un seul modèle en
  mémoire à la fois … »). Both apps show the same steps:
  1. « Chargement… 60 % » — the load, estimated from the last load of that model (modelLoads.ts, modelWarmth.ts);
  2. « Préparation… » — once in memory, the start of the asking device's new conversation (instructions, profile,
     tools) is read with that model into the prompt cache: `prepareConversationStart` (routes/queries.ts), from
     `POST /providers/load` (iPhone) or `POST /queries/warm {model, fresh}` (the Desktop's main process). It also makes
     that model the one this person's new conversations start with, and a background read
     (`warmNewConversation` without `wake`) never asks for another model than the one last chosen on that runtime —
     it would load it back in its place;
  3. « Prêt » — the first question reads only itself.
- **Measured** (b11146, Jimmy's MacBook Air M5 24 GB, the app's settings, his own start of a conversation — 4 567
  tokens with 12 tools — and one of his messages — 1 839 tokens —, a fresh runtime for each case, two runs each, the
  Mac's load average falling from 20 to 4, 16 GB in swap; the 27B earlier, at 43–51):
  | Model | First word right after the load | Once « Prêt » | Same message again | Read / written per second |
  |---|---|---|---|---|
  | Qwen3.5 9B | 27.5–27.9 s | 8.2–8.9 s | 0.18–0.24 s | 207–238 / 10–12 |
  | Qwen3.6 35B-A3B | 16.1–18.5 s | 5.6–5.7 s | 0.13 s | 325–436 / 18–25 |
  | Qwen3.8 27B (set aside) | 115.6 s | 36.8 s | 3.1 s | 54–57 / 3.3 |
  « Prêt » leaves the message itself to read: the preparation took 19–20 s (9B) and 10.5–13.6 s (35B-A3B), time the
  person no longer waits after their first question. The 35B-A3B's load: 1.8 s from the disk cache, 11.3 s cold.
- **Tools** (twoody-bench `regress.mjs --label`, server 931e95e, against fakes): the 35B-A3B 65/67 and 64/67 in two
  runs, the 9B 64/67, no regression row. Said done without acting: 0 by the bench's count in both runs, but in the
  first one « Allume la lumière de la cuisine » with Home Assistant refusing the token was answered « La lumière de la
  cuisine s'allume. », which the bench did not count then (it does now); the same case passed 3/3 in three more runs.
- **Not done**: installing a model from the iPhone (the Desktop owns the downloads; the server answers 409
  `managed_by_desktop` — it would need the server to ask the Desktop, as share-call does); a real percentage while
  loading (llama.cpp reports none: still the time against the last load).

## 9. A verified catalogue of some fifty models, what each needs in memory, and MLX (15/10/2026)
Jimmy: « un catalogue d'environ 50 modèles, plusieurs versions de chaque famille », « un écran Modèles bien
meilleur », « je veux pouvoir utiliser MLX ».
- **The catalogue is data** (`src/builtin/catalogData.ts`, 57 entries, types in `catalogTypes.ts`), written by
  `scripts/model-catalog.mjs` from the Hugging Face API — never by hand: the repository, the exact file at a pinned
  revision, its size and SHA-256, the vision file, the matching MLX folder (every file with its size and SHA-256, or
  git's object id for the small text files), the publisher's licence, the context length and the architecture
  figures of its `config.json`. The script's `SOURCES` are the only choices (which model, which repository, which
  quantisation); `--check` re-fetches every entry and exits 1 when anything moved, `--table` prints the table. The
  nine models offered before keep their ids, files and digests (unchanged, checked by test); `catalog.ts` turns the
  entries into `CATALOG`; the Desktop copies the four files (`sync-builtin.mjs`).
- **Families**: Qwen (3.5 0.8B–35B-A3B, 3.6 27B and 35B-A3B in 3 and 4 bits, 3.8 27B, Qwen3 4B/8B/14B/32B, 30B-A3B
  Instruct and Thinking, Qwen3-Coder 30B-A3B), GLM (4 9B/32B, Z1 9B, 4.6V Flash, 4.7 Flash), DeepSeek (R1-0528 8B,
  R1 Distill Qwen 7B/14B/32B and Llama 8B, Coder-V2 Lite), Gemma 4 (E2B, E4B, 12B, 26B-A4B, 31B — Google's QAT
  files), Mistral (Ministral 3 3B/8B/14B and 14B Reasoning, Mistral Small 3.2, Magistral Small 1.2, Devstral Small
  2), Llama (3.2 1B/3B, 3.1 8B, 3.3 70B), Phi-4 (mini, mini reasoning, 14B, reasoning plus), gpt-oss 20B, Nemotron 3
  Nano 4B and 30B-A3B, SmolLM3 3B, Granite 4.1 8B, Olmo 3 7B, LFM2.5 2.6B, MiniCPM5 2B. Quantisers in this order:
  the publisher's own, ggml-org, Osmove's (twoody), bartowski; unsloth only for Qwen3-Coder 30B-A3B (bartowski's
  repository answers 401). Left out: models whose 4-bit file is split (gpt-oss 120B, GLM-4.5-Air, Qwen3.5 122B:
  the downloader takes one file), the flagship MoEs of 180B and more, and any licence that forbids a person's or a
  company's use (non-commercial, research only: refused by the script). Licences with conditions (Llama, NVIDIA,
  LFM, DeepSeek) are « licence avec conditions » on the screen, with the licence's link.
- **What a model needs in memory** (`src/builtin/memory.ts`, one formula for the app, the server and the site's
  calculator, twoody-backend `Marketing::LocalLlm::Memory` — below):
  need = weights + kvBytesPerToken × context × cache factor + sliding layers × min(context, window + 512) × factor
  + recurrent state + 0.3 GiB of work buffers (+ the vision file + 0.3 GiB on llama.cpp). Context: Twoody's own
  (`twoodyContext`, which runtimeArgs.ts `builtinContextFor` now calls). Cache factor: q8_0 (34/64) for a hybrid
  model on llama.cpp, f16 otherwise and on MLX. kvBytesPerToken counts the layers that keep the whole conversation
  (full attention; MLA's latent + rope; Gemma 4's global heads and shared layers; `attention_k_eq_v`); recurrent
  state from Gated DeltaNet or Mamba dimensions. Checked: Qwen3.5 9B with vision at 32 768 tokens 7.4 GiB measured,
  7.4 computed; 4B at 8 192 2.9 measured, 3.1; Qwen3.6 35B-A3B IQ3_XXS 14.5 measured, 15.4 (safe side).
  `minRamGb` of a new entry: the smallest memory size where the need fits the GPU's share (two thirds up to 32
  GB, three quarters to 128 GB: `gpuShare`); the nine entries measured by hand keep theirs.
- **The site's calculator says the same** (16/10/2026, Jimmy: « les chiffres de mémoire du calculateur doivent être
  ceux de l'app », before journalists are contacted). Until then twoody.com had its own table of 36 models and its
  own sum (no vision file, no recurrent state, no q8_0 cache, a 16k window; 11 file sizes off, 25 catalogue models
  missing: Qwen3.5 9B on a 16 GB Mac 6.2 GB there, 7.4 here). Now `scripts/site-calculator.ts` writes, from
  `catalogData.ts`, `catalog.ts` and this file — never by hand:
  - `site/twoody-models.json`: every catalogue entry as the app runs it (file, vision file, MLX weights, the figures
    above, `minRamGb`, uses, capabilities), the constants of memory.ts, and the larger models the calculator shows
    that the app does not offer (`SITE_ONLY`: Qwen3-Next 80B-A3B, Qwen3.5 122B-A10B, Qwen3 235B-A22B Instruct 2507,
    gpt-oss 120B, Mistral Small 4 119B — Q4_K_M or MXFP4, the publisher's, ggml-org's or bartowski's, split files
    summed — verified like the catalogue and sized with the same functions; « Pas dans le catalogue de Twoody »);
  - `site/memory-parity.json`: what `catalogMemoryNeed`, `twoodyContext`, `minRamFor`, `gpuShare` and
    `recommendedModel()` answer for each of them over a grid of computers (memory around every threshold; Mac with
    Apple silicon, Intel Mac, Windows with no card, an 8, 9.4, 9.5, 10 or 24 GiB card, Linux);
  - `site/site-models.json` (`--refresh`, from the Hugging Face API): what the site needs beyond the catalogue — each
    entry's layer and expert counts, from the config.json its figures were read from (they must give the same
    figures), the languages its card declares, and `SITE_ONLY` at pinned revisions.

  It copies the first two into twoody-backend (`config/twoody_models.json`,
  `test/fixtures/files/twoody_memory_parity.json`), whose `Marketing::LocalLlm::Memory` ports this file and
  `recommendedModel()`; its `memory_parity_test.rb` wants the same bytes on the whole grid, its
  `twoody_figures_copy_test.rb` the app's thresholds, memory and download sizes in every sentence of the site (ten
  languages). Here, `test/siteCalculator.test.ts` fails when `site/` is not what the script writes now — after
  `model-catalog.mjs`, a change to this file or to `recommendedModel()`: run
  `node --import tsx scripts/site-calculator.ts` (`--check` only compares), commit `site/` here and the copies in
  twoody-backend, and port a change of the formula to the Ruby side. On a Mac with Apple silicon the calculator's
  verdict follows `minRamGb` (« offered from »); its speeds stay its own estimates, from llama.cpp's public
  benchmarks.
- **`GET /runtime/catalog`** adds `memoryNeed` (this computer, llama.cpp) and `mlx {id, bytes, memoryNeed}` (the file
  list stays in the catalogue). The iPhone's computer screen shows a Mac's installed models only (its « Modèles »
  holds the catalogue) and the memory each needs.
- **MLX**: an engine of the Desktop on Apple silicon only, installed and run by the app (twoody-desktop
  `docs/mlx-engine.md`). For the server it is one more keyed loopback runtime (`TWOODY_RUNTIME_KEYS`); what it adds
  here is `src/visionStandIn.ts`: a turn with an image that the chosen local model refuses (`vision_unavailable`,
  which the MLX launcher answers) goes to a model of this computer's llama.cpp that reads images — the same model's
  GGUF first — and the final event says `vision_stand_in {from, to}` (test/visionStandIn.test.ts).
