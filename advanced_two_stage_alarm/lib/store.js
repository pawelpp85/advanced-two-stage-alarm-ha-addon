const fs = require("fs/promises");

const DEFAULT_CONFIG_PATH = "/data/two_stage_alarm_config.json";

function createDefaultConfig() {
  return {
    panelEntities: {
      warning: "alarm_control_panel.two_stage_warning",
      main: "alarm_control_panel.two_stage_main"
    },
    timings: {
      warningDelaySec: 45,
      alarmDurationSec: 180
    },
    monitoredEntities: [],
    profiles: [
      {
        id: "default",
        name: "Default",
        enabledEntities: []
      }
    ],
    activeProfileId: "default"
  };
}

function normalizeEntityId(value, fallback) {
  const candidate = String(value || fallback || "").trim().toLowerCase();
  if (!candidate || !candidate.includes(".")) {
    return fallback;
  }
  return candidate;
}

function dedupeStrings(values) {
  return [...new Set((values || []).map((x) => String(x).trim()).filter(Boolean))];
}

function normalizeConfig(input) {
  const fallback = createDefaultConfig();
  const raw = input || {};

  const monitoredEntities = Array.isArray(raw.monitoredEntities) ? raw.monitoredEntities : [];
  const normalizedMonitored = dedupeStrings(monitoredEntities.map((entry) => entry?.entity_id)).map((entityId) => {
    const source = monitoredEntities.find((x) => String(x?.entity_id).toLowerCase() === entityId.toLowerCase()) || {};
    return {
      entity_id: entityId.toLowerCase(),
      immediate: Boolean(source.immediate),
      message: String(source.message || "").trim(),
      messageTts: String(source.messageTts || "").trim(),
      triggerStates: dedupeStrings(source.triggerStates || []).map((x) => x.toLowerCase()),
      fromStates: dedupeStrings(source.fromStates || []).map((x) => x.toLowerCase())
    };
  });

  const entityIds = normalizedMonitored.map((x) => x.entity_id);
  const profilesInput = Array.isArray(raw.profiles) ? raw.profiles : [];
  const normalizedProfiles = profilesInput
    .map((profile, index) => {
      const id = String(profile?.id || `profile_${index + 1}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_");
      return {
        id: id || `profile_${index + 1}`,
        name: String(profile?.name || `Profile ${index + 1}`).trim() || `Profile ${index + 1}`,
        enabledEntities: dedupeStrings(profile?.enabledEntities || []).filter((entityId) =>
          entityIds.includes(entityId.toLowerCase())
        )
      };
    })
    .filter((profile) => profile.id);

  if (!normalizedProfiles.length) {
    normalizedProfiles.push({
      id: "default",
      name: "Default",
      enabledEntities: [...entityIds]
    });
  }

  const uniqueProfiles = [];
  const seenIds = new Set();
  for (const profile of normalizedProfiles) {
    if (seenIds.has(profile.id)) {
      continue;
    }
    seenIds.add(profile.id);
    uniqueProfiles.push(profile);
  }

  let activeProfileId = String(raw.activeProfileId || "").trim().toLowerCase();
  if (!activeProfileId || !uniqueProfiles.some((profile) => profile.id === activeProfileId)) {
    activeProfileId = uniqueProfiles[0].id;
  }

  return {
    panelEntities: {
      warning: normalizeEntityId(raw?.panelEntities?.warning, fallback.panelEntities.warning),
      main: normalizeEntityId(raw?.panelEntities?.main, fallback.panelEntities.main)
    },
    timings: {
      warningDelaySec: Math.max(5, Math.min(900, Number(raw?.timings?.warningDelaySec) || fallback.timings.warningDelaySec)),
      alarmDurationSec: Math.max(
        5,
        Math.min(7200, Number(raw?.timings?.alarmDurationSec) || fallback.timings.alarmDurationSec)
      )
    },
    monitoredEntities: normalizedMonitored,
    profiles: uniqueProfiles,
    activeProfileId
  };
}

class ConfigStore {
  constructor(filePath = DEFAULT_CONFIG_PATH) {
    this.filePath = filePath;
    this.config = createDefaultConfig();
  }

  async init() {
    try {
      const rawText = await fs.readFile(this.filePath, "utf8");
      this.config = normalizeConfig(JSON.parse(rawText));
      await this.save(this.config);
    } catch (error) {
      this.config = createDefaultConfig();
      await this.save(this.config);
    }
  }

  get() {
    return JSON.parse(JSON.stringify(this.config));
  }

  async save(nextConfig) {
    this.config = normalizeConfig(nextConfig);
    await fs.writeFile(this.filePath, `${JSON.stringify(this.config, null, 2)}\n`, "utf8");
    return this.get();
  }
}

module.exports = {
  ConfigStore,
  createDefaultConfig,
  normalizeConfig
};
