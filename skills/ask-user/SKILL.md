---
name: ask-user
description: "You MUST use this before high-stakes architectural decisions, irreversible changes, or when requirements are ambiguous. Runs a decision handshake with the ask_user tool: summarize context, present structured options, collect explicit user choice, then proceed."
metadata:
  short-description: Decision gate for ambiguity and high-stakes choices
---

# Ask User Decision Gate

Use this skill to force explicit user alignment before consequential decisions.

This skill is about **decision control**, not general chit-chat.

## Non-negotiable rule

Invoke `ask_user` before proceeding when **any** of the following is true:

1. The next step changes architecture, schema, API contracts, deployment strategy, or security posture.
2. The work is costly to undo (large refactor, migration, destructive edit, production-facing behavior change).
3. Requirements, constraints, or success criteria are unclear, conflicting, or missing.
4. Multiple valid options exist and the trade-off is preference-dependent.
5. You are about to assume something that can materially change implementation.

Do **not** skip this gate unless the user has already provided a clear, explicit decision for the exact trade-off.

## Agent Protocol Handshake (required)

Follow this handshake in order.

### 1) Detect boundary
Classify the current step as:
- `high_stakes`
- `ambiguous`
- `both`
- `clear` (no gate needed)

If classification is not `clear`, continue.

### 2) Gather evidence first
Before asking, gather context from available tools (`read`, `bash`, `exa`, `ref`, etc.).
Do not ask the user to decide blind.

### 3) Synthesize context
Prepare a short neutral summary (3-7 bullets or short paragraph) covering:
- current state
- key constraints
- trade-offs
- recommendation (if any)

### 4) Ask one focused question
Call `ask_user` with one decision at a time:
- `question`: concrete decision prompt
- `context`: synthesized summary
- `options`: 2-5 clear choices when possible
- `allowMultiple`: `false` unless independent selections are genuinely needed
- `allowFreeform`: usually `true`

### 5) Commit the decision
After response:
- restate the decision in plain language
- state what will be done next
- proceed with implementation

### 6) Re-open only on new ambiguity
Ask again only if materially new uncertainty appears.
Avoid repetitive confirmation loops.

## Anti-overasking guardrails (required)

Apply a strict question budget per decision boundary:

- **Max 1** `ask_user` call per decision boundary in normal cases.
- **Max 2** `ask_user` calls for the same boundary when first response is unclear/cancelled.
- Never ask the same trade-off again without new evidence.

Escalation ladder:

1. **Attempt 1:** structured options + concise context.
2. **Attempt 2 (only if needed):** narrower question with agent recommendation and explicit choices:
   - `Proceed with recommended option`
   - `Choose another option` (freeform)
   - `Stop for now`

After attempt 2:

- If boundary is `high_stakes` or `both`: **stop and mark blocked**. Do not keep asking.
- If boundary is `ambiguous` only and user says “your call” or equivalent: proceed with the most reversible default and state assumptions explicitly.

## `ask_user` payload quality standard

### Question quality
Use:
- “Which option should we adopt for X?”
- “Do you want A (fast) or B (safer) for Y?”

Avoid:
- broad/open prompts with no decision boundary
- multiple unrelated decisions in one question
- questions that should be answered by reading code/docs first

### Option quality
Options must be:
- mutually understandable
- short and outcome-oriented
- explicit on trade-offs

Good options include a short description when trade-offs are non-obvious.

## Recommended patterns

### Single-select architecture decision

```json
{
  "question": "Which caching strategy should we use for the first release?",
  "context": "Current API has p95 latency issues. Redis is fastest but adds infra complexity; in-memory cache is simpler but not shared across instances.",
  "options": [
    { "title": "In-memory cache", "description": "Simpler rollout, weaker horizontal consistency" },
    { "title": "Redis cache", "description": "Better consistency and scalability, more ops overhead" }
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```

### Multi-select when decisions are independent

```json
{
  "question": "Select the first-wave hardening items to implement now.",
  "context": "We can ship quickly with baseline controls, then add targeted hardening. Budget is limited to 1-2 days.",
  "options": [
    "Rate limiting",
    "Audit logging",
    "Input schema validation",
    "Secrets rotation"
  ],
  "allowMultiple": true,
  "allowFreeform": true
}
```

## Anti-patterns

- Asking `ask_user` without first gathering context
- Using it for trivial formatting choices
- Forcing options when freeform is clearly better
- Asking the same question repeatedly without new information
- Proceeding with high-stakes implementation after unclear/cancelled answer

## If user cancels or answer is unclear

Pause execution and explain what is blocked.
Use at most one narrower follow-up `ask_user` question (attempt 2).
After that, do not continue asking in a loop:
- for high-stakes decisions: remain blocked until explicit decision
- for ambiguity-only decisions: proceed only if user delegated the choice ("your call")

## Additional reference

For full trigger matrix, UX conventions, and extension interaction details, read:
- `references/ask-user-skill-extension-spec.md`
