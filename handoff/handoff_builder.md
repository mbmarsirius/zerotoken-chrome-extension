# Handoff Builder Prompt (with optional Delight Layer)

Goal: Produce a faithful, actionable handoff from map → reduce summaries. No secrets/PII. Delight fields are optional and must be derived only from verified context (checkpoints and conversation text).

ASSISTANT TASK
1) Synthesize core sections (Objectives, Constraints, Facts & Data, Decisions, Open Questions, Next Actions, Artifacts, Tests, Glossary, Receiving LLM Guide).
2) Enforce brevity and structure. Prefer bullets; avoid fluff.
3) Keep traceability: important claims should be attributable to a message range or checkpoint (e.g., “cp#12–15”).
4) Output JSON following `handoff.schema.json`. Unknown/unused fields may be omitted.

Delight (optional; non-breaking)
9) Build a “delight” layer (opsiyonel) strictly from context:
   - wow_headlines: 1–3 short reminders the user would say “oh right!”.
   - callback_triggers: (cue → reply) pairs. Use sparse, non‑spammy cues.
   - signature_tone: style_tags + do/dont tuned to the user (concise, decisive, warm).
   - personal_microfacts: tiny, safe recalls; no secrets.
   - quick_start_script: ≤2 sentences that prove context memory.
   - next_three_moves: bold but reversible; include why/risk/rollback.
   - approval_log: items explicitly approved by the user; leave empty if not verifiable.
   - trust_tokens: 2–4 factual recalls (no secrets), each tied to an evidence pointer.
10) presentational.lazy_reveal: 3–4 beats + timings (ms); set reduced_motion_safe=true.

Constraints
- Do NOT invent data. If unsure, omit.
- No secrets/PII.
- Keep JSON valid and minimal.

Output
- A single JSON object conforming to `handoff.schema.json`.


