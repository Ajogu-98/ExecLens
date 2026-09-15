# ExecLens

Say what the work means, not what the team did.

ExecLens turns raw technical status updates into executive-ready reporting. A project is set up once with its objectives and why each one matters to leadership. Every reporting period, the team pastes its raw bullets and gets back a report a non-technical executive can read without a follow-up question.

## The problem it solves

Technical teams write status in technical language: tool names, acronyms, ticket numbers, "partnered with," "enabling." Leadership needs the same information in business terms: what got done, why it matters, who it affects, and what needs a decision. Every organization runs into this gap, in every industry, with every tool. ExecLens closes it with a fixed set of editorial rules instead of a generic summarizer.

## How it works

**Three layers of context**

1. **Mission** (optional). The program or section goal a project sits under.
2. **Objectives** (required). Each has a title, a description, a "why leadership cares" line, and an optional target date. This is the anchor. Every weekly bullet is mapped to one of these, and the impact statement in the report is pulled from the objective rather than invented. When an objective has a date, each report says whether it is on track, at risk, or slipped, judged only from what the team wrote.

A project can also carry a **strategic alignment** (the goal or mandate leadership already recognizes, cited in their words) and **success criteria** (how leadership will judge the project). Both feed the "why" layer.
3. **Raw deliverables** (every period). Whatever the team wrote, pasted as is.

**What the translator does with each bullet**

- Rewrites it in what / why / who / status form, in plain language.
- Names the risk, not the mechanism ("sensitive data could be exposed" instead of "DLP does not enforce").
- Removes activity words that hide outcomes: enabling, supporting, partnered with, leverage, efforts.
- Maps it to a stated objective. Anything that maps to nothing is flagged for review rather than silently included.
- Pulls blockers into their own section with a specific ask for leadership.
- Cuts routine items (meeting attendance, upcoming activities, internal tuning) and lists them at the bottom with the reason, so nothing disappears unexplained.
- Never invents a fact. If a bullet is missing something the report needs, it says what to ask the team.

**Setup that adds value.** When an objective has no "why leadership cares" line, a one-click draft writes one from the title and description for the user to confirm or edit. People leave setup with better-defined objectives than they came in with.

## Architecture

```
public/index.html                          single-page app: four screens, demo data, browser storage
netlify/functions/_shared.mts              the editorial engine: rules, prompt assembly, model call
netlify/functions/translate.mts            fast endpoint: queue a job, poll a job, draft a value line
netlify/functions/translate-background.mts long-running translation, writes result to Netlify Blobs
netlify.toml                               publish dir + functions dir
```

**Why two functions.** A full report takes longer than Netlify's 30 second
synchronous limit. So the browser posts the update, gets a job id back
immediately, and polls for the result while a background function (15 minute
limit) does the work and writes it to a blob. The model call streams, and the
model refers to each raw bullet by number rather than echoing it back, which
roughly halves what it has to generate.

- **Front end:** vanilla HTML, CSS, and JavaScript. No framework, no build step. Projects are saved in the browser (localStorage) for v1.
- **Back end:** two Netlify Functions sharing one editorial engine. `/api/translate` queues jobs and answers polls; the background function does the translation and stores the result in Netlify Blobs. The API key lives only in the functions and never reaches the browser.
- **Model:** Anthropic Claude (`claude-sonnet-5` by default, configurable with `EXECLENS_MODEL`).

## Running it

**Prerequisites:** Node 18+, an Anthropic API key.

```bash
npm install
cp .env.example .env      # add your ANTHROPIC_API_KEY
npm run dev               # http://localhost:8888
```

## Deploying to Netlify

1. Push this folder to a Git repository and connect it to a new Netlify site, or run `npx netlify deploy --prod` from this folder.
2. In the Netlify UI, go to **Site configuration > Environment variables** and add `ANTHROPIC_API_KEY`.
3. Open the site. The four demo projects load automatically; hit **Translate** on any of them and use the sample update.

## Demo data

The four demo projects (a federal zero-trust rollout, a bank's Salesforce consolidation, a hospital's ServiceNow rollout, and a Microsoft 365 Copilot pilot) are built entirely from public knowledge about those tools and the public OMB M-22-09 memo. No organization's internal data is used anywhere in this project.

## Roadmap

- Multi-user projects with a real database (Netlify Blobs or Postgres) instead of browser storage.
- Export to Word and PowerPoint.
- A "coach" mode that scores a raw update against the rules before translating, so teams learn to write it right the first time.
- Per-organization rule overrides (banned-word lists, required sections, house style).
