# Ask User Skill × Extension Interaction Spec

## Purpose

This document defines a minimal decision-gating protocol for using the `ask-user` skill with the `ask_user` tool.

Goal: require explicit user decisions at high-impact or ambiguous boundaries before implementation continues.

---

## 1) Trigger Matrix (When to Call `ask_user`)

| Scenario | Must Ask? | Why |
|---|---:|---|
| Architecture trade-off (e.g., queue vs cron, SQL vs KV) | Yes | Preference-sensitive, high blast radius |
| Data schema / migration path selection | Yes | Costly to reverse |
| Security/compliance posture trade-off | Yes | Risk ownership is human |
| Requirements conflict or ambiguity | Yes | Need explicit intent |
| Non-trivial scope cut/prioritization | Yes | Product decision, not purely technical |
| Purely local refactor with identical behavior | Usually no | No policy-level decision |
| Formatting-only edits | No | Trivial |
| User already gave explicit choice for exact trade-off | No (unless new ambiguity) | Decision already captured |

---

## 2) Decision Handshake

Use this protocol whenever the trigger matrix says to ask.

1. **Detect boundary**
   - classify as `high_stakes`, `ambiguous`, `both`, or `clear`
2. **Gather evidence**
   - read code/docs/logs first; do not ask blindly
3. **Summarize context**
   - prepare concise trade-off context (3–7 bullets or short paragraph)
4. **Ask one focused question**
   - call `ask_user` for one decision at a time
5. **Commit and proceed**
   - restate chosen option and implement accordingly

### Retry/cancel policy

- Max **2** `ask_user` attempts for the same decision boundary.
- Attempt 1: normal structured question.
- Attempt 2: narrower question with recommendation and explicit options.
- After attempt 2:
  - `high_stakes` / `both`: stop and report blocked.
  - `ambiguous` only: proceed only if user delegates (e.g., “your call”), using the most reversible default.

---

## 3) Example Payloads

### Architecture decision

```json
{
  "question": "Which implementation path should we use for v1?",
  "context": "Path A is faster to ship but less extensible. Path B takes longer but supports plugin-style growth. Existing deadline is 2 weeks.",
  "options": [
    { "title": "Path A (ship fast)", "description": "Lowest scope, revisit architecture later" },
    { "title": "Path B (extensible)", "description": "Higher initial effort, cleaner long-term composition" }
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```

### Requirement-priority decision

```json
{
  "question": "Which requirement should be prioritized first?",
  "context": "Current request mixes performance tuning and UI redesign. Doing both now risks delaying delivery.",
  "options": [
    "Performance first",
    "UI redesign first",
    "Do a minimal pass on both"
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```
