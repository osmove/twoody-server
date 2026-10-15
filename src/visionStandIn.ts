import { and, eq } from "drizzle-orm";

import { CATALOG } from "./builtin/catalog.js";
import { db, llmEndpoints } from "./db.js";
import { probeRuntime } from "./localRuntime.js";
import { keyedRuntimes } from "./runtimeAuth.js";

// A turn with an image whose model cannot read it: the MLX engine of Twoody
// Desktop (mlx-lm's server reads text only — twoody-desktop
// docs/mlx-engine.md) answers « vision_unavailable », and lets go of its
// model. Rather than refuse the question, it goes to a model of this
// computer's llama.cpp that reads images: the same model's GGUF when it is
// installed, else one Twoody measured (recommendable), else any of the
// catalogue's with a vision file. The answer says which model answered
// (`answered_by`, the trace's `vision_stand_in`).
//
// Only this computer's runtimes: the providers the person set up, and the
// runtimes the Desktop handed a key for (its llama.cpp is one, chosen or
// not). Never another computer: images stay on the computer that was asked.

export interface StandIn {
  baseUrl: string;
  model: string;
}

/// The catalogue's models that read images, by id, and the GGUF id of each
/// MLX folder's model.
function readers(): { ids: Set<string>; ggufOf: Map<string, string>; preferred: Set<string> } {
  const ids = new Set<string>();
  const ggufOf = new Map<string, string>();
  const preferred = new Set<string>();
  for (const model of CATALOG) {
    if (model.mlx) ggufOf.set(model.mlx.id, model.id);
    if (!model.vision) continue;
    ids.add(model.id);
    if (model.recommendable) preferred.add(model.id);
  }
  return { ids, ggufOf, preferred };
}

export async function visionStandIn(userId: string, current: { baseUrl: string; model: string }): Promise<StandIn | null> {
  const normalize = (url: string) => url.trim().replace(/\/+$/, "");
  const from = normalize(current.baseUrl);
  const stored = db
    .select({ baseUrl: llmEndpoints.baseUrl })
    .from(llmEndpoints)
    .where(and(eq(llmEndpoints.userId, userId), eq(llmEndpoints.kind, "local_openai"), eq(llmEndpoints.enabled, true)))
    .all()
    .map((row) => row.baseUrl)
    .filter((url): url is string => typeof url === "string" && url.length > 0);
  const bases = [...new Set([...stored, ...keyedRuntimes()].map(normalize))].filter((url) => url !== from);
  const { ids, ggufOf, preferred } = readers();
  const same = ggufOf.get(current.model) ?? null;
  let fallback: StandIn | null = null;
  let measured: StandIn | null = null;
  for (const baseUrl of bases) {
    const probe = await probeRuntime(baseUrl).catch(() => null);
    const models = (probe?.models ?? []).filter((id) => ids.has(id));
    if (same && models.includes(same)) return { baseUrl, model: same };
    const good = models.find((id) => preferred.has(id));
    if (good && !measured) measured = { baseUrl, model: good };
    if (models[0] && !fallback) fallback = { baseUrl, model: models[0] };
  }
  return measured ?? fallback;
}
