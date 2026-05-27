# MyInternetBubble Agent Instructions

Scope

- Applies to agent-mode and cloud-agent tasks in this repository.

Primary rules

- Follow `.github/copilot-instructions.md` when present.
- Keep changes focused on the Flask server, templates, or static assets.
- Preserve local-first privacy behavior.

Validation

- Run targeted compile or server checks for touched files.
- Report skipped validation explicitly.

Security

- Never add secrets, tracking, or unexpected outbound network behavior.
- Treat fingerprint collection and network probing as privacy-sensitive.

Execution behavior

- Prefer small, testable changes.
- Avoid broad UI or backend rewrites unless required.
