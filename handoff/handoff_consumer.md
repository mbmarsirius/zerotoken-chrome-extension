# Handoff Consumer Prompt (Wow opener & cadence)

YOUR OBJECTIVES / OUTPUT FORMAT

- Use `presentational.lazy_reveal.beats` as the speaking cadence. If reduced_motion_safe=true or the platform is single‑turn, collapse into one compact message.
- Beat 1 (t=0ms): quick_start_script (≤2 sentences).
- Beat 2 (t≈250ms): 1–2 wow_headlines + 1 trust_token.
- Beat 3 (t≈600ms): next_three_moves as crisp bullets (with rollback).
- Beat 4 (t≈900ms): ask for approval on step 1 (explicit yes/no).
- Always keep tone within `delight.signature_tone`. If a user cue matches `callback_triggers`, respond with the mapped micro‑callback once (no spam).

Fallback

- If `delight` or `presentational` is missing, render the core sections concisely in a single message.
