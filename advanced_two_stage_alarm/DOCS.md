# Advanced Two-Stage Alarm (HA Add-on)

Two-stage alarm manager for Home Assistant with:
- warning stage before main alarm,
- immediate alarm entities,
- profile-based trigger sets (Sleep, Vacation, etc.),
- search-first entity selection with rich details,
- trigger reason text for UI and TTS automations.

## Release Status

- Current version: `0.0.1b7`
- Channel: `beta`
- Repository: `git@github-nuc:pawelpp85/advanced-two-stage-alarm-ha-addon.git`

## Architecture

- Add-on backend: Node.js (`server.js`)
- Home Assistant communication: WebSocket (`ws://supervisor/core/websocket`) for live state stream
- Entity state publishing: Home Assistant state API (`/api/states/...`) for two `alarm_control_panel` entities
- UI: static SPA (`public/`)

## Runtime Flow

1. System is armed with `armed_away`.
2. Trigger from staged entity starts warning panel (`triggered`).
3. If trigger persists for `warningDelaySec`, main panel goes to `triggered`.
4. Main alarm stays active for `alarmDurationSec`.
5. If staged trigger clears during warning phase, escalation is canceled.
6. If warning is disarmed during warning phase, main alarm is not started.

## Exposed Alarm Entities

Defaults:
- `alarm_control_panel.two_stage_warning`
- `alarm_control_panel.two_stage_main`

Both are editable in UI.

Main states used:
- `disarmed`
- `armed_away`
- `triggered`

`armed_away` is the only arming mode used.

## Profiles

- Each profile defines which monitored entities are active.
- New profile includes all currently monitored entities by default.
- Active profile can be switched in UI or via API.
- Profiles make it easy to model modes such as `Sleep`, `Away`, `Vacation`.

## Trigger Reason Attributes

Attributes are published on both alarm entities:
- `trigger_text`: multiline human-readable format
- `trigger_text_tts`: plain text for TTS
- `trigger_entities`: list of entity IDs currently triggering
- `last_trigger_text`, `last_trigger_text_tts`, `last_trigger_entities`, `last_trigger_at`

Both formatted and plain-text reason variants are always available for automations.

## Automation Example

```yaml
alias: "Main alarm action"
trigger:
  - platform: state
    entity_id: alarm_control_panel.two_stage_main
    to: triggered
action:
  - service: notify.mobile_app_my_phone
    data:
      title: "Alarm Triggered"
      message: "{{ state_attr('alarm_control_panel.two_stage_main', 'trigger_text') }}"
  - service: tts.speak
    target:
      entity_id: tts.piper
    data:
      media_player_entity_id: media_player.living_room
      message: "{{ state_attr('alarm_control_panel.two_stage_main', 'trigger_text_tts') }}"
mode: single
```

## No Add-on Options Required

`config.yaml` has empty `options` and empty `schema`. All setup is in UI.

## Data and Backup

- Profiles, monitored entities, trigger settings and active profile are stored in:
  - `/data/two_stage_alarm_config.json`
- Add-on manifest explicitly enables backup support:
  - `backup: hot`
  - `backup_exclude: []`
- As a result, this data file is included in standard Home Assistant add-on backups.

## API Summary

- `GET /api/bootstrap`
- `GET /api/entities?query=...`
- `POST /api/monitored`
- `PATCH /api/monitored/:entityId`
- `DELETE /api/monitored/:entityId`
- `POST /api/profiles`
- `PATCH /api/profiles/:profileId`
- `DELETE /api/profiles/:profileId`
- `POST /api/actions/arm`
- `POST /api/actions/disarm-warning`
