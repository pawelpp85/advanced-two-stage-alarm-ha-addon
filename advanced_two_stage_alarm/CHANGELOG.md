# Changelog

## 0.0.1b7 - 2026-03-06

- Simplified Trigger Reason template section to one template only:
  - `{{ state_attr('<main_alarm_entity_id>', 'trigger_text') }}`
- Kept one copy button for this single template.

## 0.0.1b6 - 2026-03-06

- Added Trigger Reason source section with explicit warning/main `entity_id` values.
- Clarified that trigger reason values are exposed as attributes on alarm panel entities (no separate helper entities).
- Added one-click copy buttons for ready-to-use HA templates (`trigger_text`, `trigger_text_tts`, `trigger_entities`, last trigger fields).

## 0.0.1b5 - 2026-03-06

- Documented persistent storage path for profiles/entities (`/data/two_stage_alarm_config.json`).
- Explicitly enabled add-on backup metadata in manifest (`backup: hot`, `backup_exclude: []`) to keep config included in add-on backups.

## 0.0.1b4 - 2026-03-06

- Added HA-driven trigger state suggestions per monitored entity.
- Added optional transition rule (`fromStates` -> trigger state) to ignore unwanted transitions such as `unavailable -> on`.
- Added alarm control panel suggestions from Home Assistant for warning and main panel entity IDs.
- Improved monitored entity card layout and moved "Trigger main alarm immediately" closer to entity header.
- Added profile board with per-profile tabs and drag-and-drop between Active and Quarantine lists.

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
