import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { DRAFT_VALUE_SCHEMA, callModel, parseJson, type Project } from "./_shared.mts";

/**
 * Fast half of the translation service. Everything here must finish well inside
 * the 30 second synchronous limit.
 *
 *   mode: "start"       -> queue a translation, return its job id
 *   mode: "status"      -> report on a queued job
 *   mode: "draft-value" -> draft a "why leadership cares" line (small, quick)
 *
 * The long work happens in translate-background.mts.
 */

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function jobStore() {
  return getStore({ name: "execlens-jobs", consistency: "strong" });
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Request body must be JSON." }, 400); }

  const mode = payload?.mode;

  try {
    /* ---- queue a translation ---- */
    if (mode === "start") {
      const project: Project = payload.project || {};
      const raw = String(payload.raw || "").trim();
      if (!raw) return json({ error: "Nothing to translate." }, 400);
      if (!project.objectives || !project.objectives.length) return json({ error: "The project has no objectives to map to." }, 400);

      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await jobStore().setJSON(jobId, { state: "working", startedAt: Date.now() });

      // Fire and forget. The background function replies 202 immediately and keeps
      // running; we do not await its completion.
      const origin = new URL(req.url).origin;
      await fetch(`${origin}/.netlify/functions/translate-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, jobId }),
      }).catch(() => { /* the poll will surface a stuck job */ });

      return json({ jobId });
    }

    /* ---- poll a translation ---- */
    if (mode === "status") {
      const jobId = String(payload.jobId || "").trim();
      if (!jobId) return json({ error: "No job id." }, 400);
      const job = await jobStore().get(jobId, { type: "json" });
      if (!job) return json({ state: "working" });
      if (job.state === "done") {
        // One read is enough; free the space.
        await jobStore().delete(jobId).catch(() => {});
        return json({ state: "done", result: job.result });
      }
      if (job.state === "error") {
        await jobStore().delete(jobId).catch(() => {});
        return json({ state: "error", error: job.error });
      }
      return json({ state: "working" });
    }

    /* ---- draft a business value line ---- */
    if (mode === "draft-value") {
      const objective = payload.objective || {};
      const project: Project = payload.project || {};
      if (!objective.title) return json({ error: "The objective needs a title first." }, 400);
      const system = `You write the "why leadership cares" line for a project objective. One to three plain sentences.
Say what the objective protects, saves, unblocks, or what happens if it slips. Concrete over abstract.
No acronyms, no product jargon, no em dashes, no words like "enabling" or "leverage". Do not invent numbers.
If the organization or industry is given, make the value specific to that context.\n\n${DRAFT_VALUE_SCHEMA}`;
      const user = [
        project.name ? `Project: ${project.name}` : "",
        project.org ? `Organization: ${project.org}` : "",
        project.industry ? `Industry: ${project.industry}` : "",
        project.mission ? `Program mission: ${project.mission}` : "",
        project.alignsTo ? `Aligns to: ${project.alignsTo}` : "",
        project.successCriteria ? `Success criteria: ${project.successCriteria}` : "",
        `Objective: ${objective.title}`,
        objective.description ? `What it is: ${objective.description}` : "",
      ].filter(Boolean).join("\n");
      const text = await callModel(system, user, 400);
      const parsed = parseJson(text);
      return json({ businessValue: String(parsed.businessValue || "").trim() });
    }

    return json({ error: "Unknown mode." }, 400);
  } catch (err: any) {
    return json({ error: err?.message || "Something went wrong." }, err?.status || 500);
  }
};

export const config: Config = {
  path: "/api/translate",
};
