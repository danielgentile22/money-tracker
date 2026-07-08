-- p3-06: one-line LLM narration stored on the Concern (PLAN.md "LLM-narrated"
-- Concerns, deferred from Phase 2). The figures hash records what was
-- narrated so a Concern that re-fires with changed figures re-narrates.
ALTER TABLE concerns ADD COLUMN narration TEXT;
ALTER TABLE concerns ADD COLUMN narrated_figures_hash TEXT;
