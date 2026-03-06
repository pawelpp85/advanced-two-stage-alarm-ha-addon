# Changelog

## 0.0.1b3 - 2026-03-06

- Fixed ingress path handling for frontend assets and API calls.
- Replaced absolute UI paths with ingress-safe relative paths.
- Added dynamic `<base>` path setup so CSS/JS load correctly when add-on is opened under `/app/<slug>` style URLs.

## 0.0.1b2 - 2026-03-06

- Fixed Home Assistant Supervisor token handling.
- Added fallback token sources (`SUPERVISOR_TOKEN`, `HASSIO_TOKEN`, `HA_TOKEN`, supervisor token files).
- Add-on no longer exits immediately when token is temporarily unavailable; it retries connection.

## 0.0.1b1 - 2026-03-06

- Initial beta release of Advanced Two-Stage Alarm add-on.
- Added WebSocket connection to Home Assistant for live entity and state events.
- Added two-stage alarm engine:
  - warning phase,
  - delayed escalation to main alarm,
  - immediate trigger support,
  - false-positive cancellation when trigger clears.
- Added profile system for grouped trigger conditions.
- Added rich UI for:
  - entity discovery with search and metadata,
  - per-entity message editing,
  - per-profile entity assignment.
- Added trigger reason attributes for automation and TTS usage.
- Added system-theme-aware UI styling with dark-first fallback.
