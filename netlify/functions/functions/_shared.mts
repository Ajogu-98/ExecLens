/**
 * Shared editorial engine for ExecLens.
 * Imported by the synchronous function (short jobs) and the background function
 * (full translations, which exceed the 30 second synchronous limit).
 */

const MODEL = Netlify.env.get("EXECLENS_MODEL") || "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export type Objective = { id: string; title: string; description?: string; businessValue?: string; targetDate?: string };
export type Project = {
  name?: string; org?: string; industry?: string; mission?: string; cadence?: string;
  alignsTo?: string; successCriteria?: string;
  objectives?: Objective[];
};

export const EDITORIAL_RULES = `
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
  Aim for 35 words per bullet. Long bullets are slower to produce and harder to read.
- BANNED words and phrases (they describe motion, not results): enabling,
  supporting, partnered with, efforts, initiate, leverage, worked toward, made
  headway, assisted with, collaborated with, continued to, in accordance with.
  Replace with a concrete verb: resolved, completed, cleared, removed, upgraded,
  migrated, launched, blocked on.
- Keep real numbers when the team supplied them (records migrated, tickets logged,
  users onboarded). Numbers are the most executive-friendly thing in a report.
- Never use em dashes.

STAY TRUE TO WHAT THE TEAM SAID. The WHY of a bullet may come from the project
setup. The WHAT (what happened, how far along it is, what caused a problem) comes
ONLY from the team's bullet. Never add to it.
- Never state more progress than the bullet reports. "On track" means work is
  underway and expected to meet its date. It does NOT mean built, live, complete,
  operational, or delivered. "At risk" does not mean incomplete by a named amount.
  Write "is on track" or "is at risk of missing <date>", not an invented state.
- Never invent a cause, a name, a company, a team, a date, or a number. If the
  bullet says something is blocked but not why, say it is blocked and that the
  cause has not been reported. Do not guess one.
- Numbers and outcomes from the success criteria may explain WHY a bullet matters
  ("this work is what makes the 50% faster investigation target possible"). Never
  present them as something the team has achieved.

QUESTIONS FOR THE TEAM. Some teams write detailed bullets; others write one line
("X is at risk"). When a bullet leaves out something leadership will ask about,
do not fill the gap. Add a question to "teamQuestions" for the report owner to send
back to the team BEFORE the report goes to leadership. Ask only what is missing:
  blocked with no cause         -> what is blocking it, since when, and what would unblock it
  at risk with no reason        -> what is driving the risk and what the recovery plan is
  on track / done with no detail -> what was actually completed this period
  missing number or user impact  -> the figure or who is affected
One short, plain question per gap, written to the team, naming the item. Combine
questions about the same item into one. If every bullet is complete enough, return
an empty list. Never invent an answer to your own question elsewhere in the report.

DECIDE EACH BULLET IN THIS EXACT ORDER. Stop at the first rule that applies.
Apply the same order to every bullet, every time.

RULE 1 - CUT. The bullet is only one of these and nothing more:
  attending or holding a meeting, sync, working group, or committee;
  work that has not happened yet ("we will", "scheduled for", "next week");
  editing documentation, runbooks, templates, or wikis;
  internal tooling or tidying with no effect outside the team.
  A bullet that ALSO reports a result is not cut; it goes to rule 2.

RULE 2 - MAP TO AN OBJECTIVE. The bullet reports work that moves a stated
  objective forward, or a problem that holds one back. Preparatory and supporting
  work counts: if it exists in order to deliver an objective, it maps to that
  objective. Choose the objective whose title and description it most directly
  serves. If two fit equally, choose the one listed first.

RULE 3 - OFF-OBJECTIVE. Only if rules 1 and 2 do not apply: it is real work, but
  it serves no stated objective at all. Give a one-line reason.

Every numbered bullet ends in exactly one place. Never leave one out.

STATUS for a mapped bullet:
  "blocked"     waiting on a person, approval, access, or decision outside the team
  "in-progress" started, not finished
  "complete"    finished this period

A bullet that only says work is "on track" is "in-progress". A bullet that says
work is "at risk" is "in-progress", and its objective's timeline is "at-risk".

BLOCKERS. Every bullet you marked "blocked" also gets an entry in
"blockersAndAsks", written as the plain problem plus the specific thing leadership
can do. The ask follows the same plain-language rules: no acronyms, no product or
configuration names. Only write an ask the bullet supports. If the team has not
said what is blocking the work or what they need, the ask is "Awareness only. The
cause has been requested from the team." and the gap goes in "teamQuestions".
Never write an ask that is really a question for the team, such as "identify the
blocker" or "assess whether it can be completed". If there is nothing for
leadership to decide, the ask is "Awareness only."

MERGE only bullets that describe the same single piece of work. Do not merge two
separate results into one bullet.

NEVER write an objective's id (o1, o2, o3) in any sentence a reader sees. Readers
never see those ids. Refer to an objective by its title or by plain description,
e.g. "the data protection work", not "(see o3)".

TIMELINE (only for objectives with a target date):
- Judge an objective's timeline ONLY from the bullets you mapped to THAT objective,
  plus its target date. Do not mark an objective at risk because a different
  objective has a problem. Evidence of risk: a stated slip, a blocker on this
  objective's own work, a dependency this objective is waiting on, or a phase that
  has not started when its date is near. If its own bullets give no timeline
  evidence, use "unknown" and leave the note empty. Never guess.
- The note is one short sentence naming the specific threat to THIS objective's date.
  Leave it empty for on-track and unknown.
- "slipped" means the team said the date will not be met. "at-risk" means there is
  a specific threat to the date. Everything else with positive progress is "on-track".
`.trim();

export function buildProjectContext(p: Project): string {
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

export const TRANSLATE_SCHEMA = `
Your entire reply must be a single JSON object. Start with { and end with }.
No preamble, no explanation, no code fences. Use this exact shape:
{
  "objectives": [
    { "objectiveId": "<id from the list>", "title": "<objective title>",
      "timeline": { "status": "on-track" | "at-risk" | "slipped" | "unknown", "note": "<one short sentence, or empty>" },
      "bullets": [ { "text": "<rewritten bullet>", "status": "complete" | "in-progress" | "blocked",
                     "src": [<numbers of the raw bullets this came from>] } ] }
  ],
  "blockersAndAsks": [ { "text": "<plain statement of the blocker>", "ask": "<what leadership can do, or 'Awareness only.'>" } ],
  "offObjective": [ { "text": "<rewritten bullet>", "src": [<numbers>], "reason": "<why it maps to no objective>" } ],
  "cut": [ { "src": [<numbers>], "reason": "<one line>" } ],
  "teamQuestions": [ { "question": "<one plain question to send back to the team>", "src": [<numbers>] } ]
}
NEVER copy the original bullet text into your response. Refer to each raw bullet ONLY
by its number in "src". This keeps the response short.
Include every objective in "objectives", even with an empty bullets array. Every numbered
raw bullet must appear in exactly one "src" across the whole response.
`.trim();

export const DRAFT_VALUE_SCHEMA = `
Respond with ONLY a JSON object, no prose, no code fences:
{ "businessValue": "<one to three plain sentences>" }
`.trim();

/**
 * Calls the model with streaming on. Streaming matters here: it keeps bytes moving so
 * the request is never idle, and it lets us hand the caller a progress callback.
 */
/**
 * Calls the model with streaming on. Streaming matters here: it keeps bytes moving so
 * the request is never idle, and it lets us hand the caller a progress callback.
 */
export async function callModel(system: string, user: string, maxTokens: number, onTick?: () => void) {
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
      // Same input must produce the same report. Reports are a record, not a draft.
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`The model request failed (${res.status}). ${body.slice(0, 300)}`), { status: 502 });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let stopReason = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          text += evt.delta.text;
          if (onTick) onTick();
        } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
          stopReason = evt.delta.stop_reason;
        } else if (evt.type === "error") {
          throw Object.assign(new Error(`The model stopped early: ${evt.error?.message || "unknown error"}`), { status: 502 });
        }
      } catch (e: any) {
        if (e?.status) throw e;
        // partial or non-JSON keepalive line; ignore
      }
    }
  }
  if (stopReason === "max_tokens") {
    throw Object.assign(
      new Error("The report was longer than the response limit allows, so it came back incomplete. Try translating fewer bullets at once."),
      { status: 502 }
    );
  }
  return text.trim();
}

export function parseJson(text: string) {
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(clean); } catch { /* fall through */ }
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch { /* fall through */ }
  }
  const peek = clean.slice(0, 160).replace(/\s+/g, " ");
  throw Object.assign(
    new Error(`The model's reply couldn't be read as a report. It began: "${peek}"`),
    { status: 502 }
  );
}

