# Issue tracker: local markdown

Issues live in this repo under `.scratch/`, one directory per feature/issue:

```
.scratch/<slug>/PRD.md      # PRDs (from /to-prd)
.scratch/<slug>/ISSUE.md    # regular issues (from /to-issues, /triage)
```

Frontmatter carries the metadata a hosted tracker would:

```yaml
---
title: Human-readable title
labels: [enhancement, ready-for-agent]   # one category + one state label
status: open                             # open | closed
created: 2026-07-04
---
```

Comments are appended to the same file under a `## Comments` heading, each starting
with an author + date line. No remote tracker exists; nothing about this project
leaves the machine.
