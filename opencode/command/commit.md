---
description: Commit staged changes (conventional message)
model: opencode/minimax-m2.1-free
---

You are helping me create a high-quality git commit.

Context:
- Current status:
!`git status`

## Required behavior

1. Determine whether there are staged changes.
   - Use `git diff --cached --name-status` to check.

2. If there are **staged changes**:
   - Inspect what will be committed:
     - `git diff --cached --name-status`
     - `git diff --cached`
   - Draft a **Conventional Commits** message and show it to me for approval.
     - Subject format: `type(scope): subject`
     - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`
     - Subject: imperative mood, no trailing period
     - Body: a small bullet list (2–6 bullets) summarizing the changes (outcomes, not filenames)
   - Only after I approve, run the commit.

3. If there are **no staged changes**:
   - Say "No staged changes to commit." and stop.

## Safety

- If any files look like they may contain secrets (e.g. `.env`, credentials), warn me and do not include them unless I explicitly confirm.
