# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Language conventions

- **Chat / interaction with the user: Chinese (中文).** All conversational
  replies, explanations, questions, and status updates addressed to the user
  must be written in Chinese.
- **Everything committed to the repo or sent to GitHub: English.** This
  includes source code, code comments, documentation, commit messages, branch
  names, issue titles/bodies, and pull request titles/descriptions.

In short: talk to the user in Chinese, write the artifacts in English.

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues (via the `gh` CLI).
See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: a root `CONTEXT.md` plus `docs/adr/`.
See `docs/agents/domain.md`.
