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

/* ---------- sandbox protections ----------
   ExecLens is a public sandbox running on one person's AI account, so every AI call
   counts against a daily allowance: one per visitor and one for the whole site.
   Visitors are told apart by a one-way hash of their IP address; the address itself
   is never stored. Limits can be changed in Netlify environment variables. */
const MAX_RAW_CHARS = 15000;
const MAX_ITEMS = 60;
const MAX_PROJECT_CHARS = 20000;

function limitFromEnv(name: string, fallback: number) {
  const n = Number(Netlify.env.get(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function visitorKey(context: Context) {
  const salt = Netlify.env.get("QUOTA_SALT") || "execlens-sandbox";
  const bytes = new TextEncoder().encode(`${salt}:${context.ip || "unknown"}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Counts one AI call. Throws a friendly 429 when today's allowance is used up. */
async function spendQuota(context: Context) {
  const perPerson = limitFromEnv("DAILY_LIMIT_PER_PERSON", 25);
  const perSite = limitFromEnv("DAILY_LIMIT_SITE", 300);
  const store = getStore({ name: "execlens-usage", consistency: "strong" });
  const day = new Date().toISOString().slice(0, 10);
  const personKey = `${day}/${await visitorKey(context)}`;
  const siteKey = `${day}/_site`;
  const [personUsed, siteUsed] = await Promise.all([
    store.get(personKey, { type: "json" }).then((v: any) => Number(v?.n) || 0),
    store.get(siteKey, { type: "json" }).then((v: any) => Number(v?.n) || 0),
  ]);
  if (siteUsed >= perSite) {
    throw Object.assign(new Error("The ExecLens sandbox has reached its daily limit for everyone. It resets at midnight UTC. Thanks for your patience."), { status: 429 });
  }
  if (personUsed >= perPerson) {
    throw Object.assign(new Error(`You've used today's ${perPerson} sandbox runs. They reset at midnight UTC. If you need more for a trial, use the Feedback page to ask.`), { status: 429 });
  }
  await Promise.all([
    store.setJSON(personKey, { n: personUsed + 1 }),
    store.setJSON(siteKey, { n: siteUsed + 1 }),
  ]);
  return Math.max(0, perPerson - personUsed - 1);
}

function checkSize(project: unknown, raw: string, items: unknown) {
  if (raw.length > MAX_RAW_CHARS) {
    throw Object.assign(new Error(`That update is too long for the sandbox (${raw.length.toLocaleString()} characters; the limit is ${MAX_RAW_CHARS.toLocaleString()}). Split it into two reports.`), { status: 413 });
  }
  if (Array.isArray(items) && items.length > MAX_ITEMS) {
    throw Object.assign(new Error(`That update has ${items.length} bullets; the sandbox limit is ${MAX_ITEMS}. Split it into two reports.`), { status: 413 });
  }
  if (JSON.stringify(project || {}).length > MAX_PROJECT_CHARS) {
    throw Object.assign(new Error("This project's setup is too long for the sandbox. Shorten the objective descriptions and try again."), { status: 413 });
  }
}

export default async (req: Request, context: Context) => {
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
      checkSize(project, raw, payload.items);
      const remaining = await spendQuota(context);

      // The nonce lets the background function confirm this job was started here,
      // after the limits above were checked, and not by a direct call.
      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const nonce = crypto.randomUUID();
      await jobStore().setJSON(jobId, { state: "working", startedAt: Date.now(), nonce });

      // Fire and forget. The background function replies 202 immediately and keeps
      // running; we do not await its completion.
      const origin = new URL(req.url).origin;
      await fetch(`${origin}/.netlify/functions/translate-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, jobId, nonce }),
      }).catch(() => { /* the poll will surface a stuck job */ });

      return json({ jobId, remaining });
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
      checkSize(project, String(objective.description || "") + String(objective.title || ""), []);
      await spendQuota(context);
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
