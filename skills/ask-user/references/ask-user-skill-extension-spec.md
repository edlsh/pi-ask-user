# Ask User Skill × Extension Interaction Spec

## Purpose

Define how the `ask-user` skill (prompt-time behavior) and the `ask_user` extension tool (runtime UI) cooperate to create reliable human-in-the-loop decisions.

This spec optimizes for:
- explicit user control at decision boundaries
- low-friction interactive UX
- minimal context bloat (progressive disclosure)
- deterministic behavior across high-stakes workflows

---

## 1) System Model

### Components

1. **Skill layer (`skills/ask-user/SKILL.md`)**
   - decides *when* user interaction is mandatory
   - enforces handshake behavior

2. **Extension layer (`index.ts`, tool `ask_user`)**
   - renders question UX (single-select, multi-select, freeform)
   - returns normalized answer text to the agent

3. **Model runtime**
   - interprets skill guidance
   - calls `ask_user` with structured payload
   - resumes execution after explicit user response

### Contract boundary

- Skill controls policy and decision gating.
- Extension controls interaction mechanics.
- Model must not bypass skill policy for high-stakes/ambiguous decisions.

---

## 2) Trigger Matrix (When to Call `ask_user`)

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

## 3) Handshake State Machine

```text
DISCOVER -> CLASSIFY -> (CLEAR -> EXECUTE)
                     -> (AMBIGUOUS/HIGH_STAKES -> EVIDENCE -> ASK -> WAIT -> COMMIT -> EXECUTE)
```

### State definitions

- **DISCOVER**: inspect task and current project state.
- **CLASSIFY**: decide whether decision gate is required.
- **EVIDENCE**: gather and compress decision context.
- **ASK**: invoke `ask_user` with a single focused decision.
- **WAIT**: pause implementation until response arrives.
- **COMMIT**: restate chosen option and intended next action.
- **EXECUTE**: implement according to confirmed decision.

### Cancellation behavior

If user cancels or response is unclear:
- enforce a **max two-attempt budget** for the same decision boundary
- attempt 1: normal structured question
- attempt 2: narrower question with explicit recommendation + `Proceed with recommendation / Choose another / Stop`

After attempt 2:
- for `high_stakes` or `both`: do not continue; report blocked status
- for `ambiguous` only: proceed only when user delegates choice (e.g., "your call"), using the most reversible default and explicit assumptions

---

## 4) `ask_user` Payload Design Standard

### Field mapping

| Field | Required | Rule |
|---|---:|---|
| `question` | Yes | One decision only, concrete and action-bound |
| `context` | Recommended | 3-7 bullets or short paragraph with evidence and trade-offs |
| `options` | Optional | Prefer 2-5 choices when stable alternatives exist |
| `allowMultiple` | Optional | `true` only for independent selections |
| `allowFreeform` | Optional | Usually `true`; set `false` only when strict menu required |

### Style rules

- Keep options concise, decision-oriented, and contrastive.
- Include brief descriptions for non-obvious trade-offs.
- Avoid stacking unrelated questions.
- Ask after evidence gathering, not before.

---

## 5) UX Guidance for Best Outcomes

### Good interaction shape

1. Agent summarizes known constraints.
2. Agent asks one clear question.
3. User selects an option quickly (or writes freeform).
4. Agent confirms and proceeds.

### Avoid

- long speculative context dumps
- “What do you want?” without options
- repeated confirmation of unchanged decisions
- more than two attempts for the same decision boundary
- hidden assumptions after user response

### Recommended defaults

- `allowFreeform: true`
- `allowMultiple: false`
- `options`: include concise titles + descriptions for trade-offs

---

## 6) Runtime and Fallback Semantics

The extension already provides these behavior guarantees:

1. **Interactive mode with UI**
   - single-select list, multi-select list, or freeform editor

2. **No options provided**
   - freeform input prompt is used

3. **No interactive UI available**
   - tool returns an error-style textual fallback that includes question/context/options

Design implication:
- skill should prefer structured options when ambiguity is high
- but always permit freeform for unanticipated requirements

---

## 7) Quality Rubric

A decision-gated interaction is successful when all are true:

- [ ] High-stakes or ambiguous boundary was detected
- [ ] Context was gathered before asking
- [ ] At most two decision questions were asked for the same boundary (normally one)
- [ ] User response was explicit
- [ ] Agent restated decision before execution
- [ ] Implementation followed the selected path

Failure signals:
- agent made architectural choice without user decision
- question lacked trade-off context
- user answer ignored or overwritten

---

## 8) Example Protocol Templates

### Template: architecture fork

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

### Template: ambiguity cleanup

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

---

