# Sofi evaluation and invited-pilot plan

## Goal

Determine whether the current text-first Sofi MVP reliably solves real everyday tasks for Belarusian Viber users, whether web answers are trustworthy, and whether the service can operate within its privacy and cost constraints. The goal is not to prove broad product-market fit from a small pilot.

The roadmap remains the authority for release scope and mandatory gates. This plan defines the evidence needed to make those gates and the pilot decision observable.

## Evaluation sequence

### Phase 0 — Freeze the hypothesis and environment

Before running the set:

1. Record the candidate commit/build, deployed model/provider, search engine, prompt/config versions, relevant limits, and date.
2. Keep production-like tests in staging. Use synthetic message content and test accounts; never paste users' private conversations into the evaluation set.
3. Confirm all core product claims and supported modalities against current implementation.
4. Write down the thresholds in the [evaluation rubric](evaluation-rubric.md) before observing results.
5. Set **AI_WEB_SEARCH_ENABLED=false** in the external environment until search-quality, actual billing, and effective privacy/data handling are accepted. The configuration schema currently defaults search to enabled, so the production value must be explicit.
6. Identify who can stop the pilot, disable AI/search, inspect operational metadata, and roll back the deployment.

**Output:** a dated evaluation record with candidate build, configurations, frozen thresholds, and named decision owner.

### Phase 1 — Deterministic automated regression

Run the repository's automated suite with mocked Viber/OpenRouter interactions and isolated test data. Use fixed clocks and deterministic cost/provider responses wherever possible.

Run at least:

- Context construction, ordering, bounds, and reset/forget behavior.
- Webhook validation, duplicate-event handling, debounce, and command bypass.
- Durable turn creation, worker serialization/recovery, and Viber callback correlation.
- Generation/delivery retry limits and reuse of persisted replies.
- Search tool configuration, citation validation/rendering, search-use caps, and disabled/error paths.
- Budget reservations/reconciliation, concurrent race cases, missing pricing/usage, economy mode, and AI-disabled behavior.
- Privacy-safe log/analytics assertions and retention behavior.

**Pass condition:** CI, type-check, lint, formatting, tests, build, and Docker build all pass; the applicable P0 regressions have explicit evidence. Mock tests prove deterministic logic, but do not prove live search quality, actual billing, effective provider privacy, or deployed error reporting.

### Phase 2 — Controlled live staging evaluation

Use the [test-case suite](pre-release-test-cases.md) and fixed prompt set. Run real provider/search requests only under a small budget with synthetic/non-sensitive queries. Check real Viber delivery in a controlled test account, not production user conversations.

Minimum sample:

- 30 everyday text cases across writing, rewrite, explanation, ideas, and clarification.
- At least 15 multi-turn sequences, including follow-up edits, topic changes, and reset/forget boundaries.
- At least 20 current-information queries: 10 Russian and 10 Belarusian. Include official/public services or rules, recent events, local/public information, and changing facts.
- Every applicable P0 reliability, cost, privacy, deployment, and error-reporting case from the test suite.

For web cases, record each material answer claim, whether search ran, query language, source URL, source type (prefer official/primary source when appropriate), whether the source supports the claim, answer freshness, and any missing/conflicting evidence. Open the actual links. Check negative behavior too: a writing request should not search unnecessarily; a disabled or failed search must not be described as successful.

For model/search billing, compare a small, controlled batch's usage ledger against OpenRouter billing. Include model and search/tool charges, configuration, uncertain holds, and any account-level charges that could explain the difference. Do not enable search externally while a material under-reservation or unexplained billing discrepancy exists.

For data handling, verify effective settings for the selected model/provider and search service, provider-side retention/zero-data-retention behavior, account settings, and the user disclosure. Request flags alone are not sufficient evidence. If the effective policy cannot be confirmed, keep external rollout blocked.

**Pass condition:** the technical release gate and response-quality gate in the [rubric](evaluation-rubric.md) are met. Any critical failure resets the relevant gate until fixed and the original plus adjacent regression cases pass.

### Phase 3 — Invited pilot

After every mandatory roadmap release gate passes, start with **15–25 invited users for 1–2 weeks**, consistent with the roadmap. Treat this as a learning cohort, not a statistically representative sample.

Recruit participants who resemble the intended audience and vary their comfort with AI tools. Explain that Sofi is an AI assistant, that messages are processed by an external AI/search provider as disclosed, what is retained, how reset/forget works, and how to report an issue or stop participating. Do not ask users to send confidential documents, credentials, medical records, financial account information, or other sensitive content to “test” Sofi.

Ask participants to try their own ordinary tasks rather than only a scripted demo. Offer a short example list: draft a message, improve a draft, explain a text, brainstorm ideas, ask a follow-up, and ask for current information with sources. Do not nudge everyone toward search, since search is an optional capability and separate release gate.

Do a daily operational review during the pilot; do not wait until the end to discover cost, delivery, privacy, or latency problems. Keep the cohort small and pause the pilot if a stop condition below occurs.

### Phase 4 — Decide and prioritize

At the end, create a short written summary including:

- Cohort size, active users, respondents, and the number of tasks evaluated.
- Technical completion/error/delivery outcomes, latency distribution, search-use rate, budget denials, and cost per active user.
- Return-use indicators and retention snapshots where the observation window allows them.
- Scores by task category and language, not only one global average.
- Search citation support rate and the ledger-vs-billing comparison.
- Critical/near-miss issues, privacy/safety concerns, user quotes only if consented and redacted, and a prioritized list of changes.
- A Go, Fix and Re-evaluate, Keep Search Disabled, or Stop decision with evidence and an owner.

Do not start image, voice, documents, long-term memory, dashboards, or new infrastructure solely because they are possible. Use the observed tasks, failure cases, and operating cost to choose the next investment.

## Questions to ask users

Ask about the task and outcome rather than requesting the exact private text they sent. Do not collect sensitive content just to understand whether Sofi worked.

### Before the pilot

1. What kinds of everyday tasks do you most often handle in Viber or on your phone?
2. Have you used an AI assistant before? What felt useful or confusing?
3. Which language would you naturally use with Sofi: Russian, Belarusian, English, or a mix?
4. What is one task you would genuinely try Sofi for this week?
5. What kind of information would you avoid sending to an AI assistant?
6. What would make you trust an answer, especially when it contains current information or sources?

### After a real task

1. What were you trying to get done? (A category or paraphrase is enough; do not ask for confidential content.)
2. Did Sofi help you finish the task? Why or why not?
3. What did you do with the answer: use it as-is, edit it, verify it, ignore it, or ask a follow-up?
4. What was wrong, missing, too long, too formal, or confusing?
5. If sources were shown, did they support the answer and were they easy to open?
6. Did Sofi understand your language and the context from earlier messages?
7. Was anything surprising or concerning about privacy, limitations, or how the answer was phrased?
8. Would you use Sofi again for the same type of task? What would need to improve first?

### End-of-pilot interview, including people who stopped using it

1. What was the most useful task you tried?
2. What did you try that Sofi could not do well?
3. Was there a moment you did not trust the answer? What sign caused that?
4. What made you return—or what prevented you from returning?
5. Compared with your previous way of doing this task, what was easier or harder?
6. What single improvement would make the biggest difference?
7. Did you understand what data was processed and how to clear conversation context?

Interview a few non-returning participants where possible. Their reasons are often more diagnostic than feedback only from enthusiastic repeat users.

## Metrics and definitions

Keep measurement content-free by default. Use internal pseudonymous user IDs, event metadata, route/model identifiers, locale, timing, outcome, source count, and cost metadata—not full prompts or completions.

| Metric | Definition and use |
|---|---|
| First successful response rate | New-user first requests that receive a successful AI response divided by eligible first requests. Exclude deliberately blocked quota/budget requests and clearly flag unsupported-media events. |
| Task completion / helpfulness | User response to “Did this help you finish the task?” and reviewer Pass/Fail on the fixed set. Report the feedback denominator. |
| Follow-up rate | Share of sessions with a follow-up instruction, such as “shorter” or “warmer”. Interpret together with qualitative feedback; more follow-ups can mean engagement or a poor first answer. |
| Return use / retention | Users who return in the defined D1/D7/D30 window. State exact cohort dates and denominators; do not infer retention before the window completes. |
| Category and locale | Aggregate counts for write, rewrite, explain, ideas, web, other, and supported locale. Avoid storing message content as an analytics label. |
| Search quality | Queries where the cited sources support material claims divided by reviewed search queries/claims, with separate Russian and Belarusian results. |
| Search necessity | Timeless requests that unnecessarily invoke search, plus current-information requests that fail to search or make unsupported current claims. |
| Operational completion | Eligible turns completed successfully, plus generation failures, delivery outcomes, ambiguous sends, timeouts, and latency percentiles. |
| Cost per active user | Model and search estimated/reported cost divided by active users in the same explicitly defined window. Separate actual, estimated, and unknown amounts. |
| Privacy and safety | Confirmed content exposure, secrets, unsafe logs, budget bypass, or high-severity failures. The acceptance target for critical incidents is zero. |

Do not introduce broad prompt logging to improve metrics. If direct user feedback needs the exact response for debugging, obtain explicit consent, minimize what is retained, and use the documented retention/deletion process.

## Proposed stop conditions

Pause new pilot traffic, disable search or AI as appropriate, and investigate immediately if any of these occurs:

- Cross-user context leak, credential/secret exposure, or unauthorized content access.
- A paid call occurs after a hard budget denial, a budget ceiling is bypassed, or search calls exceed the configured bound.
- A material answer falsely claims it performed a search or cites fabricated/irrelevant support in a way that could mislead users about a current fact.
- A serious safety incident or evidence that provider/search data handling differs materially from the disclosed and approved setup.
- Repeated generation/delivery failures or uncontrolled duplication that prevents users from relying on the service.
- Actual provider billing materially exceeds conservative ledger accounting or the account-level spend cap is not behaving as expected.

The operator must be able to disable search explicitly and set AI_ENABLED=false to stop new AI generation, while preserving enough sanitized operational metadata to investigate safely.

## Decision template

Copy this section into the pilot report after execution:

- **Build / date / environment:**
- **Cohort / active users / respondents:**
- **P0 cases passed / applicable P0 cases:**
- **CI + Docker gate:**
- **Response-quality score overall and by category/language:**
- **Web claim/source support rate (Russian / Belarusian):**
- **Ledger vs actual billing:**
- **First successful response rate / operational completion / latency:**
- **Cost per active user / budget denials / unknown cost:**
- **Return use / D1 / D7 (only where the window completed):**
- **Critical issues and stop conditions:**
- **Repeated user jobs and strongest feedback:**
- **Decision: Go / Fix and re-evaluate / Keep search disabled / Stop**
- **Decision owner / date / follow-up issues:**
