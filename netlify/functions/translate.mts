import type { Context, Config } from "@netlify/functions";

/**
 * ExecLens translation service.
 *
 * Two jobs:
 *   mode: "translate"   -> rewrite a period's raw bullets against a project's objectives
 *   mode: "draft-value" -> draft a "why leadership cares" line for one objective
 *
 * The API key never leaves this function. Set ANTHROPIC_API_KEY in Netlify env vars.
 */

const MODEL = Netlify.env.get("EXECLENS_MODEL") || "claude-sonnet-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

type Objective = { id: string; title: string; description?: string; businessValue?: string; targetDate?: string };
type Project = {
  name?: string; org?: string; industry?: string; mission?: string; cadence?: string;
  alignsTo?: string; successCriteria?: string;
  objectives?: Objective[];
};

const EDITORIAL_RULES = `
You are the editor for a weekly executive status report. You rewrite raw technical
status bullets into bullets a non-technical executive can read without a single
follow-up question. You are strict, plain, and you never inflate.

EVERY REWRITTEN BULLET FOLLOWS THIS ORDER, IN PLAIN PROSE (NOT LABELED):
1. WHAT was done, or what the issue is. Lead with the result or the problem in one
   plain sentence. No product names, acronyms, or ticket numbers in the opening.
2. WHY it matters to leadership. One sentence on the impact: what it protects,
   saves, unblocks, or what breaks if it slips. Sources for the why, in priority
   order: the objective's "why leadership cares" text; the project's SUCCESS
   CRITERIA (if the bullet moves one forward, say which); the strategic goal the
   project ALIGNS TO (cite it in leadership's own words, e.g. "advances Sub-Goal
   5.01"). Do not invent impact that none of these or the bullet supports.
3. WHO is affected. Name the users or stakeholders and weave them into the
   sentence. Never put "who" in parentheses at the end.
4. STATUS. Only for unfinished work. Completed work gets no status label.

PLAIN-LANGUAGE RULES:
- Name the RISK, not the mechanism. "Sensitive data could be exposed," not
  "DLP does not enforce." Drop control and product names (DLP, Purview, Entra,
  CAB, IdP, ETL, Apex, etc.) unless a plain phrase cannot carry the meaning.
- Assume the reader knows no IT acronyms. Spell one out only if it is essential;
  otherwise replace it with a plain phrase.
- Short sentences. Two sentences per bullet is the norm, three is the maximum.
- BANNED words and phrases (they describe motion, not results): enabling,
  supporting, partnered with, efforts, initiate, leverage, worked toward, made
  headway, assisted with, collaborated with, continued to, in accordance with.
  Replace with a concrete verb: resolved, completed, cleared, removed, upgraded,
  migrated, launched, blocked on.
- Keep real numbers when the team supplied them (records migrated, tickets logged,
  users onboarded). Numbers are the most executive-friendly thing in a report.
- Never use em dashes.

WHAT TO KEEP, FLAG, OR CUT:
- KEEP completed work and in-progress work that ties to a stated objective.
- FLAG as a blocker anything waiting on a person, a decision, an approval, or
  access. Blockers go in "blockersAndAsks" AND their objective (if any). Write the
  ask as the specific thing leadership can do. If there is nothing to decide, say
  "Awareness only."
- FLAG as off-objective any real accomplishment that does not map to one of the
  stated objectives. Rewrite it in the same style and give a one-line reason.
- CUT, with a one-line reason: routine meeting attendance; upcoming or scheduled
  activities that have not happened; internal tuning or maintenance with no
  impact outside the team; documentation, runbook, or template help; anything
  that conveys no impact, risk, or decision. Do not cut real progress just because
  it is small.
- MERGE bullets that tell one story (an upgrade plus retiring the old system, a
  fix plus its validation) into a single bullet.
- NEVER INVENT. If a bullet lacks a fact the report needs (the actual user impact,
  a count, whether a tool is the team's or a vendor's), write the bullet without
  the missing fact and set "missing" to a short note about what to ask the team.

TIMELINE (only for objectives with a target date):
- Judge on-track / at-risk / slipped ONLY from what the team wrote and the date.
  Evidence of risk: a stated slip, a blocker that gates the objective, a dependency
  not received, a phase that has not started when the date is near. If the bullets
  give no timeline evidence, use "unknown" and leave the note empty. Never guess.
- "slipped" means the team said the date will not be met. "at-risk" means there is
  a specific threat to the date. Everything else with positive progress is "on-track".
`.trim();

function buildProjectContext(p: Project): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${p.name || "(unnamed)"}`);
  if (p.org) lines.push(`ORGANIZATION: ${p.org}${p.industry ? ` (${p.industry})` : ""}`);
  if (p.cadence) lines.push(`REPORTING CADENCE: ${p.cadence}`);
  if (p.mission) lines.push(`PROGRAM MISSION: ${p.mission}`);
  if (p.alignsTo) lines.push(`ALIGNS TO (strategic goal or mandate, cite in leadership's words): ${p.alignsTo}`);
  if (p.successCriteria) lines.push(`SUCCESS CRITERIA (how leadership will judge the project): ${p.successCriteria}`);
  lines.push(`TODAY: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(``);
  lines.push(`STATED OBJECTIVES (map every bullet to one of these by id):`);
  (p.objectives || []).forEach((o, i) => {
    lines.push(`${i + 1}. id="${o.id}" ${o.title}${o.targetDate ? `  [target date: ${o.targetDate}]` : ""}`);
    if (o.description) lines.push(`   What it is: ${o.description}`);
    if (o.businessValue) lines.push(`   Why leadership cares: ${o.businessValue}`);
    else lines.push(`   Why leadership cares: (not stated; infer cautiously from the title, and prefer restraint)`);
  });
  return lines.join("\n");
}

const TRANSLATE_SCHEMA = `
Respond with ONLY a JSON object, no prose, no code fences, in this exact shape:
{
  "objectives": [
    { "objectiveId": "<id from the list>", "title": "<objective title>",
      "timeline": { "status": "on-track" | "at-risk" | "slipped" | "unknown", "note": "<one short sentence, or empty>" },
      "bullets": [ { "text": "<rewritten bullet>", "status": "complete" | "in-progress" | "blocked",
                     "source": "<the original raw bullet, verbatim>", "missing": "<optional note>" } ] }
  ],
  "blockersAndAsks": [ { "text": "<plain statement of the blocker>", "ask": "<what leadership can do, or 'Awareness only.'>" } ],
  "offObjective": [ { "text": "<rewritten bullet>", "source": "<original>", "reason": "<why it maps to no objective>" } ],
  "cut": [ { "source": "<original raw bullet>", "reason": "<one line>" } ]
}
Include every objective in "objectives", even with an empty bullets array. Every raw
bullet must land in exactly one of: an objective's bullets, offObjective, or cut.
`.trim();

const DRAFT_VALUE_SCHEMA = `
Respond with ONLY a JSON object, no prose, no code fences:
{ "businessValue": "<one to three plain sentences>" }
`.trim();

async function callModel(system: string, user: string, maxTokens: number) {
  const key = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!key) {
    throw Object.assign(new Error("The translation service isn't configured yet. Add ANTHROPIC_API_KEY to the site's environment variables."), { status: 503 });
  }
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`The model request failed (${res.status}). ${body.slice(0, 300)}`), { status: 502 });
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
  return text;
}

function parseJson(text: string) {
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(clean); } catch { /* fall through */ }
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw Object.assign(new Error("The model returned something that wasn't valid JSON. Try again."), { status: 502 });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let payload: any;
  try { payload = await req.json(); } catch { return json({ error: "Request body must be JSON." }, 400); }

  const mode = payload?.mode;

  try {
    if (mode === "translate") {
      const project: Project = payload.project || {};
      const raw: string = String(payload.raw || "").trim();
      const period: string = String(payload.period || "").trim();
      if (!raw) return json({ error: "Nothing to translate." }, 400);
      if (!project.objectives || !project.objectives.length) return json({ error: "The project has no objectives to map to." }, 400);

      const system = `${EDITORIAL_RULES}\n\n${buildProjectContext(project)}\n\n${TRANSLATE_SCHEMA}`;
      const user = `REPORTING PERIOD: ${period || "(not stated)"}\n\nRAW BULLETS FROM THE TEAM:\n${raw}`;
      const text = await callModel(system, user, 4000);
      const parsed = parseJson(text);

      // Every stated objective appears, in project order, so the report layout is stable.
      const byId = new Map<string, any>();
      (parsed.objectives || []).forEach((o: any) => byId.set(String(o.objectiveId), o));
      parsed.objectives = (project.objectives || []).map((o) => {
        const hit = byId.get(String(o.id));
        const timeline = hit && hit.timeline && typeof hit.timeline === "object" ? hit.timeline : { status: "unknown", note: "" };
        return { objectiveId: o.id, title: o.title, timeline: o.targetDate ? timeline : undefined, bullets: (hit && hit.bullets) || [] };
      });
      parsed.blockersAndAsks = parsed.blockersAndAsks || [];
      parsed.offObjective = parsed.offObjective || [];
      parsed.cut = parsed.cut || [];
      return json(parsed);
    }

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
    const status = err?.status || 500;
    return json({ error: err?.message || "Something went wrong." }, status);
  }
};

export const config: Config = {
  path: "/api/translate",
};
