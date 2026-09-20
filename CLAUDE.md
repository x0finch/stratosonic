# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project goal

Stratosonic reimplements the Subsonic / OpenSubsonic music protocol on
Cloudflare Workers + D1 + R2, migrating away from a Navidrome instance whose
music already lives in R2. v1 is spec-faithful and client-agnostic (primary
client: Substreamer), outputs both XML and JSON, and does no server-side
transcoding (returns original files). There is no separate CLI: a single
Worker serves the API and runs ingestion on a schedule (cron); music is
uploaded to R2 with rclone; the first admin user is created on first run from
`INITIAL_USER` / `INITIAL_PASSWORD`. It targets the Cloudflare free tier. See
`docs/adr/` for the load-bearing decisions.

## Working approach

- **Answer technical questions from the source projects, do not ask the user.**
  When a design question has an objective answer — how IDs are generated, how an
  endpoint must respond, what a field means — find it in the reference
  implementations (Navidrome, gonic, EdgeSonic, the OpenSubsonic spec) and
  follow the most faithful approach. Do not turn these into interview questions;
  that risks drifting the plan.
- **Stay faithful to the migration.** Prefer matching Navidrome's behavior and
  data model over inventing new ones, so the cutover and data migration stay
  simple.
- Reserve questions for the user for genuine product/scope trade-offs that no
  source can settle, and keep them rare.

## Language conventions

- **Chat / interaction with the user: Chinese (中文).** All conversational
  replies, explanations, questions, and status updates addressed to the user
  must be written in Chinese.
- **Everything committed to the repo or sent to GitHub: English.** This
  includes source code, code comments, documentation, commit messages, branch
  names, issue titles/bodies, and pull request titles/descriptions.

- **When presenting an English artifact (a spec, an issue or PR body, an ADR, a
  design doc) for the user to review, always include a short Chinese summary of
  it in the same message, unprompted.**

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
