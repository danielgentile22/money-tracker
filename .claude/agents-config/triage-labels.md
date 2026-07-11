# Triage label vocabulary

The five canonical state roles map 1:1 to label strings (no overrides):

- `needs-triage` — maintainer needs to evaluate
- `needs-info` — waiting on reporter
- `ready-for-agent` — fully specified, AFK-ready
- `ready-for-human` — needs human implementation
- `wontfix` — will not be actioned

Category roles: `bug`, `enhancement`. Every triaged issue carries exactly one
category label and one state label in its `labels:` frontmatter.
