# Project Layout

- `plugin/`: Chrome MV3 extension for Douyin favorite, audit, and backup workflows.
- `backend/`: Playwright automation scripts, dashboard server, config, and local state.
- `frontend/`: Reserved for a standalone dashboard UI if the inline dashboard is split out later.
- `docs/architecture-design.md`: Current product behavior and implementation rules.
- `docs/test-release-runbook.md`: Current verification and release checklist.
- `docs/project-audit-2026-10-09.md`: Confirmed business gaps, evidence, and acceptance criteria; distinguish implemented behavior from target requirements.

# Local Data

- Backend progress lives in `backend/data/` and is ignored by Git.
- Backend config lives in `backend/config/`.
- Build output and browser profiles are ignored and can be regenerated.
