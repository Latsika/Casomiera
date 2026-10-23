# Global working agreement

## Communication
- Use English for communication, documentation, code, and comments.
- Explain briefly in plain language for a nontechnical reader.
- Prefer questions over guesses. Clearly distinguish facts from assumptions.

## Starting a session
- Read applicable instructions and available project documentation.
- Clarify the intended outcome, scope, constraints, and success criteria.
- Ask as many focused questions as needed before dependent work.
- Recommend a suitable primary role and explain the choice briefly.
- Continue after clarification without requiring a separate role selection.
- Use role profiles from ~/.codex/roles when available.
- A role profile does not authorize parallel agents or additional actions.

## Approval
- Read-only inspection may proceed without approval.
- Before each individual file creation, modification, deletion, or move,
  show its path, purpose, and proposed content or diff, then ask for approval.
- Approval covers only the proposed change to that file.
- Request approval again if its proposed content materially changes.
- Before running a command that changes files, explain the affected files
  and request approval for each intended change.
- Ask before installation, commit, push, deployment, or destructive actions
  unless the user has explicitly authorized that specific action.
- Never interpret silence as approval.
- Respect tool permissions; these instructions do not bypass access controls.

## Code quality
- Write clear, readable code with descriptive names and focused functions.
- Prefer simple designs that support maintenance and future features.
- Follow established project conventions and preserve existing behavior
  unless the agreed task requires changing it.
- Avoid unrelated refactoring, speculative abstractions, and unnecessary
  dependencies.
- Handle relevant errors explicitly and protect sensitive information.
- Run checks appropriate to the change, subject to the approval rules.
- Report what was verified and any remaining limitations.

## Documentation and portability
- Projects on this PC are located under C:\projects.
- Use each project's README.md as the primary project documentation.
- Use each project's AGENTS.md for agent instructions, durable technical
  notes, important decisions, and concise handover information.
- Keep global preferences, role profiles, and reusable templates in the
  user's ~/.codex directory.
- Keep shared instructions in plain Markdown, usable by different agents.
- Keep tool-specific adapters small and avoid duplicating shared rules.
- Do not store credentials, private keys, or sensitive data in documentation.
- Do not replace existing instructions without reviewing and reconciling them.
- Propose project documentation setup when a project is next opened;
  do not initialize every existing project automatically.
- Keep notes current and concise; do not accumulate raw conversation logs.

## Finishing a task
- Briefly explain the result, verification, and unresolved issues.
- Offer these closing options:
  1. Document only.
  2. Document and commit.
  3. Document, commit, and push.
- Allow the user to finish without further changes.
- Obtain approval for each documentation edit before writing it.
- Commit only agreed files and preserve unrelated user changes.
- Before a push, identify the target remote and branch.
- Do not claim completion of actions that were not performed.
