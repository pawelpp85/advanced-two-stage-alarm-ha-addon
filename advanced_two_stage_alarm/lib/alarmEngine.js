const { EventEmitter } = require("events");
const { normalizeConfig } = require("./store");

const NON_TRIGGER_STATES = new Set(["unknown", "unavailable", "none", "null", "", "off", "closed", "clear", "idle"]);
const DIRECT_TRIGGER_STATES = new Set([
  "on",
  "open",
  "opening",
  "detected",
  "motion",
  "occupied",
  "presence",
  "present",
  "home",
  "alarm",
  "triggered",
  "wet",
  "smoke",
  "gas",
  "tampered",
  "true"
]);
const SEARCHABLE_DOMAINS = new Set([
  "binary_sensor",
  "sensor",
  "group",
  "camera",
  "event",
  "image_processing",
  "person",
  "device_tracker",
  "cover",
  "lock"
]);

function toLower(value) {
  return String(value || "").trim().toLowerCase();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value, fallback = "profile") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

class TwoStageAlarmEngine extends EventEmitter {
  constructor({ haClient, store }) {
    super();
    this.haClient = haClient;
    this.store = store;
    this.config = normalizeConfig(store.get());

    this.connected = false;
    this.systemArmed = false;
    this.warningState = "disarmed";
    this.mainState = "disarmed";
    this.suppressedUntilClear = false;

    this.warningTimer = null;
    this.warningDeadline = null;
    this.mainTimer = null;
    this.mainDeadline = null;

    this.entityStates = new Map();
    this.entityRegistryById = new Map();
    this.deviceRegistryById = new Map();
    this.areaRegistryById = new Map();
    this.observedStatesByEntity = new Map();
    this.transitionLatchedEntities = new Set();

    this.currentTriggerSummary = {
      display: "",
      tts: "",
      entities: []
    };
    this.lastMainTriggerSummary = {
      display: "",
      tts: "",
      entities: [],
      at: null
    };

    this.evaluating = false;
    this.evaluateAgain = false;
    this.publishing = false;
    this.publishRequested = false;

    this.clockTimer = setInterval(() => {
      this.emit("status_changed", this.getStatus());
    }, 1000);
  }

  async start() {
    this.haClient.on("connected", () => this._onConnected());
    this.haClient.on("disconnected", () => {
      this.connected = false;
      this.emit("status_changed", this.getStatus());
    });
    this.haClient.on("event", (eventPayload) => this._onEvent(eventPayload));
    this.haClient.on("error", (error) => this.emit("error", error));
    this.haClient.connect();
  }

  getConfig() {
    return clone(this.config);
  }

  getStatus() {
    const now = Date.now();
    return {
      connectedToHa: this.connected,
      systemArmed: this.systemArmed,
      warningState: this.warningState,
      mainState: this.mainState,
      warningCountdownSec: this.warningDeadline ? Math.max(0, Math.ceil((this.warningDeadline - now) / 1000)) : 0,
      alarmCountdownSec: this.mainDeadline ? Math.max(0, Math.ceil((this.mainDeadline - now) / 1000)) : 0,
      suppressedUntilClear: this.suppressedUntilClear,
      currentTriggerText: this.currentTriggerSummary.display,
      currentTriggerTextTts: this.currentTriggerSummary.tts,
      currentTriggerEntities: [...this.currentTriggerSummary.entities],
      lastMainTriggerText: this.lastMainTriggerSummary.display,
      lastMainTriggerTextTts: this.lastMainTriggerSummary.tts,
      lastMainTriggerAt: this.lastMainTriggerSummary.at
    };
  }

  getBootstrap() {
    const config = this.getConfig();
    const monitored = config.monitoredEntities.map((entry) => ({
      ...entry,
      details: this.getEntityDetails(entry.entity_id),
      stateOptions: this.getEntityStateOptions(entry.entity_id)
    }));
    return {
      config,
      status: this.getStatus(),
      monitored
    };
  }

  async setSystemArmed(armed) {
    this.systemArmed = Boolean(armed);
    if (this.systemArmed) {
      if (this.mainState !== "triggered") {
        this.mainState = "armed_away";
      }
      this.warningState = this.suppressedUntilClear ? "disarmed" : "armed_away";
    } else {
      this.suppressedUntilClear = false;
      this._clearWarningTimer();
      this._clearMainTimer();
      this.warningState = "disarmed";
      this.mainState = "disarmed";
      this.currentTriggerSummary = { display: "", tts: "", entities: [] };
    }
    this._evaluate();
    this._queuePublish();
    this.emit("status_changed", this.getStatus());
  }

  async disarmWarning() {
    if (!this.systemArmed || this.mainState === "triggered") {
      return;
    }
    this.suppressedUntilClear = true;
    this.warningState = "disarmed";
    this._clearWarningTimer();
    this._evaluate();
    this._queuePublish();
    this.emit("status_changed", this.getStatus());
  }

  async selectProfile(profileId) {
    await this._updateConfig((draft) => {
      const normalized = toLower(profileId);
      if (!draft.profiles.some((profile) => profile.id === normalized)) {
        throw new Error(`Profile ${profileId} does not exist.`);
      }
      draft.activeProfileId = normalized;
      return draft;
    });
  }

  async addProfile(name) {
    return this._updateConfig((draft) => {
      const baseName = String(name || "New profile").trim() || "New profile";
      const existing = new Set(draft.profiles.map((profile) => profile.id));
      const baseId = slugify(baseName, "profile");
      let nextId = baseId;
      let index = 2;
      while (existing.has(nextId)) {
        nextId = `${baseId}_${index}`;
        index += 1;
      }

      draft.profiles.push({
        id: nextId,
        name: baseName,
        enabledEntities: draft.monitoredEntities.map((entry) => entry.entity_id)
      });
      draft.activeProfileId = nextId;
      return draft;
    });
  }

  async renameProfile(profileId, name) {
    return this._updateConfig((draft) => {
      const profile = draft.profiles.find((entry) => entry.id === toLower(profileId));
      if (!profile) {
        throw new Error(`Profile ${profileId} does not exist.`);
      }
      profile.name = String(name || "").trim() || profile.name;
      return draft;
    });
  }

  async removeProfile(profileId) {
    return this._updateConfig((draft) => {
      if (draft.profiles.length === 1) {
        throw new Error("At least one profile is required.");
      }
      const targetId = toLower(profileId);
      const nextProfiles = draft.profiles.filter((profile) => profile.id !== targetId);
      if (nextProfiles.length === draft.profiles.length) {
        throw new Error(`Profile ${profileId} does not exist.`);
      }
      draft.profiles = nextProfiles;
      if (!nextProfiles.some((profile) => profile.id === draft.activeProfileId)) {
        draft.activeProfileId = nextProfiles[0].id;
      }
      return draft;
    });
  }

  async setProfileEntityEnabled(profileId, entityId, enabled) {
    return this._updateConfig((draft) => {
      const profile = draft.profiles.find((entry) => entry.id === toLower(profileId));
      if (!profile) {
        throw new Error(`Profile ${profileId} does not exist.`);
      }
      const normalizedEntityId = toLower(entityId);
      if (!draft.monitoredEntities.some((entry) => entry.entity_id === normalizedEntityId)) {
        throw new Error(`Entity ${entityId} is not monitored.`);
      }
      const active = new Set(profile.enabledEntities.map((item) => toLower(item)));
      if (enabled) {
        active.add(normalizedEntityId);
      } else {
        active.delete(normalizedEntityId);
      }
      profile.enabledEntities = [...active];
      return draft;
    });
  }

  async addMonitoredEntity(entityId, immediate = false) {
    return this._updateConfig((draft) => {
      const normalizedEntityId = toLower(entityId);
      if (!normalizedEntityId.includes(".")) {
        throw new Error(`Invalid entity_id: ${entityId}`);
      }
      if (!draft.monitoredEntities.some((entry) => entry.entity_id === normalizedEntityId)) {
        draft.monitoredEntities.push({
          entity_id: normalizedEntityId,
          immediate: Boolean(immediate),
          message: "",
          messageTts: "",
          triggerStates: [],
          fromStates: []
        });
      }
      for (const profile of draft.profiles) {
        if (!profile.enabledEntities.some((item) => toLower(item) === normalizedEntityId)) {
          profile.enabledEntities.push(normalizedEntityId);
        }
      }
      return draft;
    });
  }

  async updateMonitoredEntity(entityId, patch) {
    return this._updateConfig((draft) => {
      const normalizedEntityId = toLower(entityId);
      const entity = draft.monitoredEntities.find((entry) => entry.entity_id === normalizedEntityId);
      if (!entity) {
        throw new Error(`Entity ${entityId} is not monitored.`);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "immediate")) {
        entity.immediate = Boolean(patch.immediate);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "message")) {
        entity.message = String(patch.message || "").trim();
      }
      if (Object.prototype.hasOwnProperty.call(patch, "messageTts")) {
        entity.messageTts = String(patch.messageTts || "").trim();
      }
      if (Object.prototype.hasOwnProperty.call(patch, "triggerStates")) {
        entity.triggerStates = [...new Set((patch.triggerStates || []).map((state) => toLower(state)).filter(Boolean))];
      }
      if (Object.prototype.hasOwnProperty.call(patch, "fromStates")) {
        entity.fromStates = [...new Set((patch.fromStates || []).map((state) => toLower(state)).filter(Boolean))];
      }
      return draft;
    });
  }

  async removeMonitoredEntity(entityId) {
    return this._updateConfig((draft) => {
      const normalizedEntityId = toLower(entityId);
      const nextEntities = draft.monitoredEntities.filter((entry) => entry.entity_id !== normalizedEntityId);
      if (nextEntities.length === draft.monitoredEntities.length) {
        throw new Error(`Entity ${entityId} is not monitored.`);
      }
      draft.monitoredEntities = nextEntities;
      for (const profile of draft.profiles) {
        profile.enabledEntities = profile.enabledEntities.filter((item) => toLower(item) !== normalizedEntityId);
      }
      return draft;
    });
  }

  async setTimings(warningDelaySec, alarmDurationSec) {
    return this._updateConfig((draft) => {
      draft.timings.warningDelaySec = Number(warningDelaySec);
      draft.timings.alarmDurationSec = Number(alarmDurationSec);
      return draft;
    });
  }

  async setPanelEntities(warningEntityId, mainEntityId) {
    return this._updateConfig((draft) => {
      draft.panelEntities.warning = toLower(warningEntityId);
      draft.panelEntities.main = toLower(mainEntityId);
      return draft;
    });
  }

  suggestMessage(entityId, language) {
    const details = this.getEntityDetails(entityId);
    return this._buildSuggestedMessage(details, language);
  }

  getEntityDetails(entityId) {
    const normalizedEntityId = toLower(entityId);
    const stateObject = this.entityStates.get(normalizedEntityId) || null;
    const entityRecord = this.entityRegistryById.get(normalizedEntityId) || null;
    const deviceRecord = entityRecord ? this.deviceRegistryById.get(entityRecord.device_id) || null : null;

    const areaId = entityRecord?.area_id || deviceRecord?.area_id || null;
    const areaRecord = areaId ? this.areaRegistryById.get(areaId) || null : null;
    const attrs = stateObject?.attributes || {};
    const domain = normalizedEntityId.split(".")[0] || "";
    const friendlyName =
      attrs.friendly_name || entityRecord?.name || entityRecord?.original_name || deviceRecord?.name_by_user || normalizedEntityId;
    const deviceClass = attrs.device_class || entityRecord?.device_class || "";

    return {
      entity_id: normalizedEntityId,
      domain,
      state: stateObject?.state || "unknown",
      friendly_name: friendlyName,
      device_class: deviceClass,
      area_name: areaRecord?.name || "",
      device_name: deviceRecord?.name_by_user || deviceRecord?.name || "",
      manufacturer: deviceRecord?.manufacturer || "",
      model: deviceRecord?.model || "",
      icon: attrs.icon || ""
    };
  }

  getEntityStateOptions(entityId) {
    const normalizedEntityId = toLower(entityId);
    const observed = this.observedStatesByEntity.get(normalizedEntityId) || new Set();
    const details = this.getEntityDetails(normalizedEntityId);
    const domain = details.domain;
    const defaults = new Set();

    if (domain === "binary_sensor" || domain === "group" || domain === "input_boolean") {
      defaults.add("on");
      defaults.add("off");
    } else if (domain === "cover") {
      defaults.add("open");
      defaults.add("closed");
      defaults.add("opening");
      defaults.add("closing");
    } else if (domain === "lock") {
      defaults.add("locked");
      defaults.add("unlocked");
    } else {
      defaults.add(String(details.state || "unknown").toLowerCase());
    }

    const union = new Set([...defaults, ...observed]);
    return [...union].filter(Boolean).sort();
  }

  searchAlarmPanels(query, limit = 50) {
    const tokens = String(query || "")
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const matches = [];

    for (const entityId of this.entityStates.keys()) {
      if (!entityId.startsWith("alarm_control_panel.")) {
        continue;
      }
      const details = this.getEntityDetails(entityId);
      const haystack = `${details.entity_id} ${details.friendly_name} ${details.state} ${details.area_name} ${details.device_name}`.toLowerCase();
      if (tokens.some((token) => !haystack.includes(token))) {
        continue;
      }
      matches.push(details);
    }

    matches.sort((a, b) => a.friendly_name.localeCompare(b.friendly_name));
    return matches.slice(0, Math.max(1, Number(limit) || 50));
  }

  searchEntities(query, limit = 120) {
    const tokens = String(query || "")
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    const monitored = new Set(this.config.monitoredEntities.map((entry) => entry.entity_id));
    const results = [];

    for (const [entityId] of this.entityStates) {
      const details = this.getEntityDetails(entityId);
      if (!SEARCHABLE_DOMAINS.has(details.domain)) {
        continue;
      }
      const haystack = [
        details.entity_id,
        details.friendly_name,
        details.state,
        details.device_name,
        details.area_name,
        details.manufacturer,
        details.model,
        details.device_class
      ]
        .join(" ")
        .toLowerCase();

      if (tokens.some((token) => !haystack.includes(token))) {
        continue;
      }

      let score = 0;
      if (tokens.length) {
        if (details.friendly_name.toLowerCase().includes(tokens[0])) {
          score += 4;
        }
        if (details.entity_id.includes(tokens[0])) {
          score += 3;
        }
      }
      if (monitored.has(details.entity_id)) {
        score += 2;
      }
      if (details.area_name) {
        score += 1;
      }

      results.push({
        ...details,
        monitored: monitored.has(details.entity_id),
        _score: score
      });
    }

    results.sort((a, b) => {
      if (b._score !== a._score) {
        return b._score - a._score;
      }
      return a.friendly_name.localeCompare(b.friendly_name);
    });

    return results.slice(0, Math.max(1, Number(limit) || 120)).map(({ _score, ...entry }) => entry);
  }

  async _onConnected() {
    this.connected = true;
    try {
      const states = await this.haClient.getStates();
      this.entityStates.clear();
      this.observedStatesByEntity.clear();
      this.transitionLatchedEntities.clear();
      for (const stateObject of states || []) {
        const entityId = toLower(stateObject.entity_id);
        this.entityStates.set(entityId, stateObject);
        this._rememberObservedState(entityId, stateObject.state);
      }

      try {
        const registries = await this.haClient.getRegistries();
        this.entityRegistryById.clear();
        this.deviceRegistryById.clear();
        this.areaRegistryById.clear();

        for (const entityRecord of registries.entityRegistry || []) {
          this.entityRegistryById.set(toLower(entityRecord.entity_id), entityRecord);
        }
        for (const deviceRecord of registries.deviceRegistry || []) {
          this.deviceRegistryById.set(deviceRecord.id, deviceRecord);
        }
        for (const areaRecord of registries.areaRegistry || []) {
          this.areaRegistryById.set(areaRecord.area_id, areaRecord);
        }
      } catch (error) {
        this.emit("error", new Error(`Unable to load HA registries: ${error.message}`));
      }

      await this.haClient.ensureEventSubscription();
      this._rebuildTransitionLatches();
      this._evaluate();
      this._queuePublish();
      this.emit("status_changed", this.getStatus());
    } catch (error) {
      this.emit("error", error);
    }
  }

  async _onEvent(eventPayload) {
    if (eventPayload?.event_type !== "state_changed") {
      return;
    }
    const entityId = toLower(eventPayload?.data?.entity_id);
    if (!entityId) {
      return;
    }
    const previousStateObject = this.entityStates.get(entityId) || null;
    const nextState = eventPayload?.data?.new_state;
    if (nextState) {
      this.entityStates.set(entityId, nextState);
      this._rememberObservedState(entityId, nextState.state);
    } else {
      this.entityStates.delete(entityId);
    }
    this._updateTransitionLatch(entityId, previousStateObject, nextState);
    this._evaluate();
  }

  async _updateConfig(mutator) {
    const draft = clone(this.config);
    const nextDraft = mutator(draft);
    const nextConfig = await this.store.save(normalizeConfig(nextDraft));
    this.config = nextConfig;
    this._rebuildTransitionLatches();
    this._evaluate();
    this._queuePublish();
    this.emit("config_changed", this.getBootstrap());
    return this.getBootstrap();
  }

  _evaluate() {
    if (this.evaluating) {
      this.evaluateAgain = true;
      return;
    }

    this.evaluating = true;
    try {
      do {
        this.evaluateAgain = false;
        this._evaluateOnce();
      } while (this.evaluateAgain);
    } finally {
      this.evaluating = false;
    }
  }

  _evaluateOnce() {
    const activeTriggers = this._getActiveTriggers();
    this.currentTriggerSummary = this._buildTriggerSummary(activeTriggers);

    if (!this.systemArmed) {
      this._clearWarningTimer();
      if (this.mainState !== "triggered") {
        this.mainState = "disarmed";
      }
      this.warningState = "disarmed";
      this._queuePublish();
      this.emit("status_changed", this.getStatus());
      return;
    }

    if (this.suppressedUntilClear) {
      if (!activeTriggers.length) {
        this.suppressedUntilClear = false;
        if (this.mainState !== "triggered") {
          this.warningState = "armed_away";
        }
      }
      this._queuePublish();
      this.emit("status_changed", this.getStatus());
      return;
    }

    if (this.mainState === "triggered") {
      this._queuePublish();
      this.emit("status_changed", this.getStatus());
      return;
    }

    if (!activeTriggers.length) {
      this._clearWarningTimer();
      this.warningState = "armed_away";
      this.mainState = "armed_away";
      this._queuePublish();
      this.emit("status_changed", this.getStatus());
      return;
    }

    const hasImmediateTrigger = activeTriggers.some((entry) => entry.config.immediate);
    if (hasImmediateTrigger) {
      this._startMainAlarm(activeTriggers);
      return;
    }

    if (this.warningState !== "triggered") {
      this.warningState = "triggered";
      this._scheduleWarningEscalation();
      this._queuePublish();
      this.emit("status_changed", this.getStatus());
      return;
    }

    if (!this.warningTimer) {
      this._scheduleWarningEscalation();
    }

    this._queuePublish();
    this.emit("status_changed", this.getStatus());
  }

  _scheduleWarningEscalation() {
    this._clearWarningTimer();
    const waitMs = Math.max(1000, Number(this.config.timings.warningDelaySec || 45) * 1000);
    this.warningDeadline = Date.now() + waitMs;
    this.warningTimer = setTimeout(() => {
      this.warningTimer = null;
      this.warningDeadline = null;

      const activeTriggers = this._getActiveTriggers();
      if (!this.systemArmed || this.suppressedUntilClear || this.mainState === "triggered") {
        this._evaluate();
        return;
      }
      if (!activeTriggers.length || this.warningState !== "triggered") {
        this._evaluate();
        return;
      }
      this._startMainAlarm(activeTriggers);
    }, waitMs);
  }

  _startMainAlarm(activeTriggers) {
    this._clearWarningTimer();
    this.warningState = "triggered";
    this.mainState = "triggered";
    this.lastMainTriggerSummary = {
      ...this._buildTriggerSummary(activeTriggers),
      at: new Date().toISOString()
    };

    this._clearMainTimer();
    const durationMs = Math.max(1000, Number(this.config.timings.alarmDurationSec || 180) * 1000);
    this.mainDeadline = Date.now() + durationMs;
    this.mainTimer = setTimeout(() => {
      this.mainTimer = null;
      this.mainDeadline = null;
      if (this.systemArmed) {
        this.mainState = "armed_away";
        this.warningState = this.suppressedUntilClear ? "disarmed" : "armed_away";
      } else {
        this.mainState = "disarmed";
        this.warningState = "disarmed";
      }
      this._evaluate();
      this._queuePublish();
      this.emit("status_changed", this.getStatus());
    }, durationMs);

    this._queuePublish();
    this.emit("status_changed", this.getStatus());
  }

  _clearWarningTimer() {
    if (!this.warningTimer) {
      this.warningDeadline = null;
      return;
    }
    clearTimeout(this.warningTimer);
    this.warningTimer = null;
    this.warningDeadline = null;
  }

  _clearMainTimer() {
    if (!this.mainTimer) {
      this.mainDeadline = null;
      return;
    }
    clearTimeout(this.mainTimer);
    this.mainTimer = null;
    this.mainDeadline = null;
  }

  _rememberObservedState(entityId, stateValue) {
    const normalizedEntityId = toLower(entityId);
    const normalizedState = toLower(stateValue);
    if (!normalizedEntityId || !normalizedState) {
      return;
    }
    if (!this.observedStatesByEntity.has(normalizedEntityId)) {
      this.observedStatesByEntity.set(normalizedEntityId, new Set());
    }
    this.observedStatesByEntity.get(normalizedEntityId).add(normalizedState);
  }

  _rebuildTransitionLatches() {
    const next = new Set();
    for (const monitored of this.config.monitoredEntities) {
      if (!monitored.fromStates?.length) {
        continue;
      }
      const stateObject = this.entityStates.get(monitored.entity_id);
      if (!this._matchesTriggerState(monitored, stateObject)) {
        continue;
      }
      if (this.transitionLatchedEntities.has(monitored.entity_id)) {
        next.add(monitored.entity_id);
      }
    }
    this.transitionLatchedEntities = next;
  }

  _updateTransitionLatch(entityId, previousStateObject, nextStateObject) {
    const monitored = this.config.monitoredEntities.find((entry) => entry.entity_id === entityId);
    if (!monitored || !monitored.fromStates?.length) {
      this.transitionLatchedEntities.delete(entityId);
      return;
    }

    const toStateMatches = this._matchesTriggerState(monitored, nextStateObject);
    if (!toStateMatches) {
      this.transitionLatchedEntities.delete(entityId);
      return;
    }

    const previousState = toLower(previousStateObject?.state);
    const fromStates = new Set((monitored.fromStates || []).map((value) => toLower(value)));
    if (fromStates.has(previousState)) {
      this.transitionLatchedEntities.add(entityId);
    }
  }

  _getActiveTriggers() {
    const activeProfile = this.config.profiles.find((profile) => profile.id === this.config.activeProfileId) || this.config.profiles[0];
    const enabled = new Set((activeProfile?.enabledEntities || []).map((entityId) => toLower(entityId)));
    const active = [];

    for (const monitored of this.config.monitoredEntities) {
      if (!enabled.has(monitored.entity_id)) {
        continue;
      }
      const stateObject = this.entityStates.get(monitored.entity_id);
      if (!this._isTriggered(monitored, stateObject)) {
        continue;
      }
      const details = this.getEntityDetails(monitored.entity_id);
      const message = monitored.message || this._buildSuggestedMessage(details, "en");
      const messageTts = monitored.messageTts || message.replace(/\n+/g, ". ");
      active.push({
        config: monitored,
        details,
        message,
        messageTts
      });
    }

    return active;
  }

  _isTriggered(monitored, stateObject) {
    if (!monitored.fromStates?.length) {
      return this._matchesTriggerState(monitored, stateObject);
    }
    if (!this.transitionLatchedEntities.has(monitored.entity_id)) {
      return false;
    }
    return this._matchesTriggerState(monitored, stateObject);
  }

  _matchesTriggerState(monitored, stateObject) {
    if (!stateObject) {
      return false;
    }
    const state = toLower(stateObject.state);
    if (monitored.triggerStates?.length) {
      return monitored.triggerStates.map((item) => toLower(item)).includes(state);
    }
    if (NON_TRIGGER_STATES.has(state)) {
      return false;
    }
    if (DIRECT_TRIGGER_STATES.has(state)) {
      return true;
    }

    const domain = String(monitored.entity_id || "").split(".")[0];
    if (domain === "binary_sensor" || domain === "group") {
      return state === "on";
    }
    if (domain === "cover") {
      return state === "open" || state === "opening";
    }
    if (domain === "lock") {
      return state === "unlocked";
    }
    if (domain === "camera") {
      return state !== "idle";
    }
    return false;
  }

  _buildSuggestedMessage(details, language) {
    const lang = String(language || "en").toLowerCase().split("-")[0];
    const name = details?.friendly_name || details?.entity_id || "Sensor";
    const state = details?.state || "unknown";
    const klass = toLower(details?.device_class);

    let key = "generic";
    if (["door", "window", "opening", "garage_door"].includes(klass)) {
      key = "opening";
    } else if (["motion", "occupancy", "presence"].includes(klass)) {
      key = "presence";
    } else if (klass === "vibration") {
      key = "vibration";
    } else if (details.domain === "camera" || details.entity_id.includes("person")) {
      key = "person";
    }

    const dictionary = {
      en: {
        opening: `${name} opened`,
        presence: `Presence detected by ${name}`,
        vibration: `Vibration detected by ${name}`,
        person: `Person detected by ${name}`,
        generic: `${name} triggered (${state})`
      },
      pl: {
        opening: `${name} otwarte`,
        presence: `Wykryto obecnosc: ${name}`,
        vibration: `Wykryto wibracje: ${name}`,
        person: `Wykryto osobe: ${name}`,
        generic: `${name} aktywne (${state})`
      },
      de: {
        opening: `${name} geoeffnet`,
        presence: `Praesenz erkannt von ${name}`,
        vibration: `Vibration erkannt von ${name}`,
        person: `Person erkannt von ${name}`,
        generic: `${name} ausgeloest (${state})`
      }
    };

    const selected = dictionary[lang] || dictionary.en;
    return selected[key] || selected.generic;
  }

  _buildTriggerSummary(activeTriggers) {
    if (!activeTriggers.length) {
      return {
        display: "",
        tts: "",
        entities: []
      };
    }
    const lines = [...new Set(activeTriggers.map((entry) => entry.message.trim()).filter(Boolean))];
    const ttsLines = [...new Set(activeTriggers.map((entry) => entry.messageTts.trim()).filter(Boolean))];
    return {
      display: `Triggered by:\n- ${lines.join("\n- ")}`,
      tts: `Triggered by ${ttsLines.join(". ")}.`,
      entities: [...new Set(activeTriggers.map((entry) => entry.config.entity_id))]
    };
  }

  _queuePublish() {
    this.publishRequested = true;
    if (this.publishing) {
      return;
    }
    this._flushPublish();
  }

  async _flushPublish() {
    this.publishing = true;
    try {
      while (this.publishRequested) {
        this.publishRequested = false;
        await this._publishPanelStates();
      }
    } finally {
      this.publishing = false;
    }
  }

  async _publishPanelStates() {
    if (!this.connected) {
      return;
    }
    const activeProfile = this.config.profiles.find((profile) => profile.id === this.config.activeProfileId) || this.config.profiles[0];
    const commonAttributes = {
      supported_features: 2,
      code_arm_required: false,
      active_profile_id: activeProfile.id,
      active_profile_name: activeProfile.name,
      warning_delay_sec: this.config.timings.warningDelaySec,
      alarm_duration_sec: this.config.timings.alarmDurationSec,
      trigger_text: this.currentTriggerSummary.display,
      trigger_text_tts: this.currentTriggerSummary.tts,
      trigger_entities: this.currentTriggerSummary.entities,
      last_trigger_text: this.lastMainTriggerSummary.display,
      last_trigger_text_tts: this.lastMainTriggerSummary.tts,
      last_trigger_entities: this.lastMainTriggerSummary.entities,
      last_trigger_at: this.lastMainTriggerSummary.at,
      suppressed_until_clear: this.suppressedUntilClear
    };

    const warningAttributes = {
      ...commonAttributes,
      friendly_name: "Two-Stage Alarm Warning"
    };
    const mainAttributes = {
      ...commonAttributes,
      friendly_name: "Two-Stage Alarm Main"
    };

    try {
      await this.haClient.setState(this.config.panelEntities.warning, this.warningState, warningAttributes);
      await this.haClient.setState(this.config.panelEntities.main, this.mainState, mainAttributes);
    } catch (error) {
      this.emit("error", error);
    }
  }
}

module.exports = {
  TwoStageAlarmEngine
};
