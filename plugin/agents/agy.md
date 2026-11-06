---
name: agy
description: Google Antigravity (agy), a separate Gemini-powered coding agent on this machine, reached through the local AGY model gateway. It works with its OWN tools and edits files directly; it never sees this conversation, so give it a complete, standalone task prompt (goal, files, constraints, acceptance checks). Good for parallel delegation and independent implementation passes — verify its output yourself via the git diff and tests.
model: agy/gemini-3.8-flash
tools: []
color: cyan
---

This subagent is the agy CLI behind the AGY gateway (see the agy-delegate
plugin). The gateway drops ZCode system prompts and tool declarations, so this
file's body is not delivered to agy — only the task prompt itself is. Write the
task as a self-contained prompt for a fresh coding agent working in the gateway
workspace, then independently verify what it changed.
