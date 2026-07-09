# Project Layout

- `plugin/`: Chrome MV3 extension for Douyin favorite, audit, and backup workflows.
- `backend/`: Playwright automation scripts, dashboard server, config, and local state.
- `frontend/`: Reserved for a standalone dashboard UI if the inline dashboard is split out later.
- `SPEC.md`: Current product and implementation spec.

# Local Data

- Backend progress lives in `backend/data/` and is ignored by Git.
- Backend config lives in `backend/config/`.
- Build output and browser profiles are ignored and can be regenerated.
