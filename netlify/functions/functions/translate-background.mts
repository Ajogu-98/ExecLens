import { getStore } from "@netlify/blobs";
import {
  EDITORIAL_RULES,
  TRANSLATE_SCHEMA,
  buildProjectContext,
  callModel,
  parseJson,
  type Project,
} from "./_shared.mts";

/**
 * Long-running half of the translation service.
 *
 * Synchronous Netlify functions are capped at 30 seconds, which a full report
 * regularly exceeds. Background functions get 15 minutes but cannot return a
 * result to the caller, so the result is written to a blob under the job id the
 * client generated. The client polls /api/translate-status for it.
 */

export default async (req: Request) => {
  let payload: any;
  try { payload = await req.json(); } catch { return; }

  const jobId = String(payload?.jobId || "").trim();
  if (!jobId) return;

  const store = getStore({ name: "execlens-jobs", consistency: "strong" });

  try {
    const project: Project = payload.project || {};
    const raw: string = String(payload.raw || "").trim();
    const period: string = String(payload.period || "").trim();

    if (!raw) throw new Error("Nothing to translate.");
    if (!project.objectives || !project.objectives.length) throw new Error("The project has no objectives to map to.");

    const items: string[] = Array.isArray(payload.items) && payload.items.length
      ? payload.items.map((x: any) => String(x))
      : raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const numbered = items.map((t, i) => `${i + 1}. ${t}`).join("\n");

    const system = `${EDITORIAL_RULES}\n\n${buildProjectContext(project)}\n\n${TRANSLATE_SCHEMA}`;
    const user = `REPORTING PERIOD: ${period || "(not stated)"}\n\nRAW BULLETS FROM THE TEAM (refer to these by number in "src"):\n${numbered}`;

    const text = await callModel(system, user, 8000);
    const parsed = parseJson(text);

    // Every stated objective appears, in project order, so the report layout is stable.
    const byId = new Map<string, any>();
    (parsed.objectives || []).forEach((o: any) => byId.set(String(o.objectiveId), o));
    parsed.objectives = (project.objectives || []).map((o) => {
      const hit = byId.get(String(o.id));
      const timeline = hit && hit.timeline && typeof hit.timeline === "object" ? hit.timeline : { status: "unknown", note: "" };
      return { objectiveId: o.id, title: o.title, timeline: o.targetDate ? timeline : undefined, bullets: (hit && hit.bullets) || [] };
    });

    const srcText = (src: any) => {
      const nums = Array.isArray(src) ? src : (typeof src === "number" ? [src] : []);
      return nums.map((n: any) => items[Number(n) - 1]).filter(Boolean).join(" / ");
    };
    parsed.objectives.forEach((o: any) => {
      (o.bullets || []).forEach((b: any) => { b.source = srcText(b.src); delete b.src; });
    });
    parsed.blockersAndAsks = parsed.blockersAndAsks || [];
    parsed.offObjective = (parsed.offObjective || []).map((x: any) => ({ text: x.text, reason: x.reason, source: srcText(x.src) }));
    parsed.teamQuestions = (parsed.teamQuestions || [])
      .map((x: any) => ({ question: String(x.question || "").trim(), source: srcText(x.src) }))
      .filter((x: any) => x.question);
    parsed.cut = (parsed.cut || []).map((x: any) => ({ reason: x.reason, source: srcText(x.src) })).filter((x: any) => x.source);

    await store.setJSON(jobId, { state: "done", result: parsed, finishedAt: Date.now() });
  } catch (err: any) {
    await store.setJSON(jobId, { state: "error", error: err?.message || "Something went wrong.", finishedAt: Date.now() });
  }
};
