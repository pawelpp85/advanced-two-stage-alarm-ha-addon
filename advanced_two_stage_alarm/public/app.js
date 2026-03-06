const state = {
  bootstrap: null,
  searchResults: [],
  searchQuery: "",
  searchTimer: null,
  language: navigator.language || "en",
  noticeTimer: null
};

const $ = (id) => document.getElementById(id);
const ABSOLUTE_URL_PATTERN = /^[a-z]+:\/\//i;

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(url, options = {}) {
  const requestUrl = ABSOLUTE_URL_PATTERN.test(url) ? url : String(url || "").replace(/^\/+/, "");
  const config = {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    }
  };
  if (options.body !== undefined) {
    config.body = JSON.stringify(options.body);
  }

  const response = await fetch(requestUrl, config);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function showNotice(message, isError = false) {
  let notice = document.getElementById("noticeBar");
  if (!notice) {
    notice = document.createElement("div");
    notice.id = "noticeBar";
    notice.className = "notice";
    document.body.appendChild(notice);
  }
  notice.textContent = message;
  notice.className = `notice ${isError ? "notice-error" : "notice-ok"}`;
  notice.style.display = "block";
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => {
    notice.style.display = "none";
  }, 3600);
}

function applyBootstrap(payload) {
  state.bootstrap = {
    config: payload.config,
    status: payload.status,
    monitored: payload.monitored || []
  };
  renderAll();
}

function setBadge(node, text, mode) {
  node.textContent = text;
  node.className = `badge ${
    mode === "success"
      ? "badge-success"
      : mode === "danger"
        ? "badge-danger"
        : mode === "warning"
          ? "badge-warning"
          : "badge-muted"
  }`;
}

function renderStatus() {
  if (!state.bootstrap) {
    return;
  }
  const status = state.bootstrap.status;

  setBadge(
    $("connectionStatus"),
    status.connectedToHa ? "Connected to HA (WS)" : "Disconnected from HA",
    status.connectedToHa ? "success" : "danger"
  );
  setBadge($("armedStatus"), status.systemArmed ? "System armed_away" : "System disarmed", status.systemArmed ? "warning" : "muted");

  $("warningState").textContent = status.warningState;
  $("mainState").textContent = status.mainState;
  $("warningCountdown").textContent = `${status.warningCountdownSec} s`;
  $("mainCountdown").textContent = `${status.alarmCountdownSec} s`;
  $("triggerText").textContent = status.currentTriggerText || "No active trigger";
  $("triggerTextTts").textContent = status.currentTriggerTextTts || "No active trigger";
  $("lastTriggerText").textContent = status.lastMainTriggerText || "No main alarm triggered yet";

  $("armButton").disabled = !status.connectedToHa;
  $("disarmButton").disabled = !status.connectedToHa;
  $("disarmWarningButton").disabled = !status.connectedToHa || !status.systemArmed;
}

function renderSettings() {
  if (!state.bootstrap) {
    return;
  }
  const config = state.bootstrap.config;
  $("warningDelayInput").value = config.timings.warningDelaySec;
  $("alarmDurationInput").value = config.timings.alarmDurationSec;
  $("warningEntityIdInput").value = config.panelEntities.warning;
  $("mainEntityIdInput").value = config.panelEntities.main;
}

function renderProfiles() {
  if (!state.bootstrap) {
    return;
  }
  const config = state.bootstrap.config;
  const activeSelect = $("activeProfileSelect");
  activeSelect.innerHTML = config.profiles
    .map(
      (profile) =>
        `<option value="${escapeHtml(profile.id)}" ${profile.id === config.activeProfileId ? "selected" : ""}>${escapeHtml(profile.name)}</option>`
    )
    .join("");

  const container = $("profilesList");
  container.innerHTML = config.profiles
    .map(
      (profile) => `
        <div class="profile-item" data-profile-id="${escapeHtml(profile.id)}">
          <input type="radio" name="profileActive" value="${escapeHtml(profile.id)}" ${profile.id === config.activeProfileId ? "checked" : ""} />
          <input data-role="profile-name" type="text" value="${escapeHtml(profile.name)}" />
          <span class="badge badge-muted">${profile.enabledEntities.length} entities</span>
          <button data-action="delete-profile" class="btn btn-secondary" ${config.profiles.length === 1 ? "disabled" : ""}>Delete</button>
        </div>
      `
    )
    .join("");
}

function renderSearchResults() {
  const container = $("searchResults");
  if (!state.searchResults.length) {
    container.innerHTML = `<p class="helper">No matching entities.</p>`;
    return;
  }
  container.innerHTML = state.searchResults
    .map(
      (item) => `
      <article class="search-item">
        <p class="entity-title">${escapeHtml(item.friendly_name || item.entity_id)}</p>
        <p class="entity-id">${escapeHtml(item.entity_id)}</p>
        <p class="search-meta">State: <strong>${escapeHtml(item.state)}</strong> | Class: ${escapeHtml(item.device_class || "-")} | Area: ${escapeHtml(item.area_name || "-")}</p>
        <p class="search-meta">Device: ${escapeHtml(item.device_name || "-")} | Model: ${escapeHtml(item.manufacturer || "-")} ${escapeHtml(item.model || "")}</p>
        <div class="search-actions">
          <button data-action="add-monitored" data-entity-id="${escapeHtml(item.entity_id)}" data-immediate="false" class="btn btn-secondary">Add staged</button>
          <button data-action="add-monitored" data-entity-id="${escapeHtml(item.entity_id)}" data-immediate="true" class="btn btn-warning">Add immediate</button>
          ${
            item.monitored
              ? '<span class="badge badge-success">Already monitored</span>'
              : '<span class="badge badge-muted">Not monitored</span>'
          }
        </div>
      </article>
      `
    )
    .join("");
}

function isEnabledInProfile(profileId, entityId) {
  const profile = state.bootstrap.config.profiles.find((item) => item.id === profileId);
  if (!profile) {
    return false;
  }
  return profile.enabledEntities.includes(entityId);
}

function renderMonitoredEntities() {
  if (!state.bootstrap) {
    return;
  }
  const container = $("monitoredContainer");
  const monitored = state.bootstrap.monitored || [];
  if (!monitored.length) {
    container.innerHTML = `<p class="helper">No monitored entities yet. Add entities from discovery section above.</p>`;
    return;
  }

  const profileChecksHeader = state.bootstrap.config.profiles
    .map((profile) => `<span class="check-pill">${escapeHtml(profile.name)}</span>`)
    .join("");

  container.innerHTML = monitored
    .map((entry) => {
      const details = entry.details || {};
      const triggerStates = (entry.triggerStates || []).join(", ");
      const profileChecks = state.bootstrap.config.profiles
        .map(
          (profile) => `
          <label class="check-pill">
            <input
              type="checkbox"
              data-role="profile-entity-toggle"
              data-profile-id="${escapeHtml(profile.id)}"
              data-entity-id="${escapeHtml(entry.entity_id)}"
              ${isEnabledInProfile(profile.id, entry.entity_id) ? "checked" : ""}
            />
            ${escapeHtml(profile.name)}
          </label>
        `
        )
        .join("");

      return `
        <article class="entity-card" data-entity-id="${escapeHtml(entry.entity_id)}">
          <div class="entity-head">
            <div>
              <p class="entity-title">${escapeHtml(details.friendly_name || entry.entity_id)}</p>
              <p class="entity-id">${escapeHtml(entry.entity_id)}</p>
            </div>
            <span class="badge ${entry.immediate ? "badge-warning" : "badge-muted"}">${entry.immediate ? "Immediate" : "Staged"}</span>
          </div>

          <div class="entity-meta-row">
            <p class="search-meta">State: <strong>${escapeHtml(details.state || "unknown")}</strong></p>
            <p class="search-meta">Area: <strong>${escapeHtml(details.area_name || "-")}</strong></p>
            <p class="search-meta">Device: <strong>${escapeHtml(details.device_name || "-")}</strong></p>
            <p class="search-meta">Class: <strong>${escapeHtml(details.device_class || "-")}</strong></p>
          </div>

          <label><input data-field="immediate" type="checkbox" ${entry.immediate ? "checked" : ""} /> Trigger main alarm immediately</label>
          <label>Display trigger message<textarea data-field="message" rows="2">${escapeHtml(entry.message || "")}</textarea></label>
          <label>TTS trigger message<textarea data-field="messageTts" rows="2">${escapeHtml(entry.messageTts || "")}</textarea></label>
          <label>Trigger states (comma separated, optional)<input data-field="triggerStates" value="${escapeHtml(triggerStates)}" /></label>

          <div>
            <p class="key">Profile membership</p>
            <div class="profile-check-grid">${profileChecks || profileChecksHeader}</div>
          </div>

          <div class="entity-actions">
            <button data-action="save-entity" data-entity-id="${escapeHtml(entry.entity_id)}" class="btn btn-primary">Save</button>
            <button data-action="suggest-message" data-entity-id="${escapeHtml(entry.entity_id)}" class="btn btn-secondary">Suggest message</button>
            <button data-action="remove-entity" data-entity-id="${escapeHtml(entry.entity_id)}" class="btn btn-warning">Remove</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderAll() {
  renderStatus();
  renderSettings();
  renderProfiles();
  renderSearchResults();
  renderMonitoredEntities();
}

async function refreshBootstrap() {
  const payload = await api("api/bootstrap");
  applyBootstrap(payload);
}

async function searchEntities() {
  const query = $("entitySearchInput").value.trim();
  state.searchQuery = query;
  const payload = await api(`api/entities?query=${encodeURIComponent(query)}&limit=80`);
  state.searchResults = payload.entities || [];
  renderSearchResults();
}

function scheduleSearch() {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    searchEntities().catch((error) => showNotice(error.message, true));
  }, 220);
}

async function postAction(path, body) {
  const payload = await api(path, { method: "POST", body });
  if (payload.config && payload.status) {
    applyBootstrap(payload);
  } else if (payload.status && state.bootstrap) {
    state.bootstrap.status = payload.status;
    renderStatus();
  }
}

function getEntityCard(entityId) {
  return document.querySelector(`.entity-card[data-entity-id="${CSS.escape(entityId)}"]`);
}

function getEntityPatch(entityId) {
  const card = getEntityCard(entityId);
  const triggerStates = card
    .querySelector('[data-field="triggerStates"]')
    .value.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return {
    immediate: card.querySelector('[data-field="immediate"]').checked,
    message: card.querySelector('[data-field="message"]').value.trim(),
    messageTts: card.querySelector('[data-field="messageTts"]').value.trim(),
    triggerStates
  };
}

function registerEventHandlers() {
  $("armButton").addEventListener("click", () => {
    postAction("api/actions/arm", { armed: true }).catch((error) => showNotice(error.message, true));
  });
  $("disarmButton").addEventListener("click", () => {
    postAction("api/actions/arm", { armed: false }).catch((error) => showNotice(error.message, true));
  });
  $("disarmWarningButton").addEventListener("click", () => {
    postAction("api/actions/disarm-warning", {}).catch((error) => showNotice(error.message, true));
  });

  $("activeProfileSelect").addEventListener("change", (event) => {
    postAction("api/actions/select-profile", { profileId: event.target.value }).catch((error) => showNotice(error.message, true));
  });

  $("saveTimingButton").addEventListener("click", async () => {
    try {
      const payload = await api("api/settings/timings", {
        method: "POST",
        body: {
          warningDelaySec: Number($("warningDelayInput").value),
          alarmDurationSec: Number($("alarmDurationInput").value)
        }
      });
      applyBootstrap(payload);
      showNotice("Timing saved.");
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  $("savePanelEntitiesButton").addEventListener("click", async () => {
    try {
      const payload = await api("api/settings/panel-entities", {
        method: "POST",
        body: {
          warning: $("warningEntityIdInput").value.trim(),
          main: $("mainEntityIdInput").value.trim()
        }
      });
      applyBootstrap(payload);
      showNotice("Panel entity IDs updated.");
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  $("addProfileButton").addEventListener("click", async () => {
    try {
      const name = $("newProfileNameInput").value.trim() || "New profile";
      const payload = await api("api/profiles", {
        method: "POST",
        body: { name }
      });
      applyBootstrap(payload);
      $("newProfileNameInput").value = "";
      showNotice("Profile added.");
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  $("profilesList").addEventListener("change", async (event) => {
    try {
      const profileRow = event.target.closest("[data-profile-id]");
      if (!profileRow) {
        return;
      }
      const profileId = profileRow.dataset.profileId;

      if (event.target.matches('input[type="radio"][name="profileActive"]')) {
        const payload = await api("api/actions/select-profile", {
          method: "POST",
          body: { profileId }
        });
        applyBootstrap(payload);
        return;
      }
      if (event.target.matches('input[data-role="profile-name"]')) {
        const payload = await api(`api/profiles/${encodeURIComponent(profileId)}`, {
          method: "PATCH",
          body: { name: event.target.value }
        });
        applyBootstrap(payload);
        showNotice("Profile renamed.");
      }
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  $("profilesList").addEventListener("click", async (event) => {
    const button = event.target.closest('[data-action="delete-profile"]');
    if (!button) {
      return;
    }
    const profileId = button.closest("[data-profile-id]").dataset.profileId;
    try {
      const payload = await api(`api/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
      applyBootstrap(payload);
      showNotice("Profile removed.");
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  $("entitySearchInput").addEventListener("input", scheduleSearch);

  $("searchResults").addEventListener("click", async (event) => {
    const button = event.target.closest('[data-action="add-monitored"]');
    if (!button) {
      return;
    }
    try {
      const payload = await api("api/monitored", {
        method: "POST",
        body: {
          entity_id: button.dataset.entityId,
          immediate: button.dataset.immediate === "true"
        }
      });
      applyBootstrap(payload);
      showNotice("Entity added.");
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  $("monitoredContainer").addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) {
      return;
    }
    const entityId = actionButton.dataset.entityId;
    try {
      if (actionButton.dataset.action === "save-entity") {
        const payload = await api(`api/monitored/${encodeURIComponent(entityId)}`, {
          method: "PATCH",
          body: getEntityPatch(entityId)
        });
        applyBootstrap(payload);
        showNotice("Entity updated.");
        return;
      }

      if (actionButton.dataset.action === "remove-entity") {
        const payload = await api(`api/monitored/${encodeURIComponent(entityId)}`, { method: "DELETE" });
        applyBootstrap(payload);
        showNotice("Entity removed.");
        return;
      }

      if (actionButton.dataset.action === "suggest-message") {
        const suggestion = await api(
          `api/suggest-message?entity_id=${encodeURIComponent(entityId)}&lang=${encodeURIComponent(state.language)}`
        );
        const card = getEntityCard(entityId);
        card.querySelector('[data-field="message"]').value = suggestion.message || "";
        if (!card.querySelector('[data-field="messageTts"]').value.trim()) {
          card.querySelector('[data-field="messageTts"]').value = suggestion.message || "";
        }
        showNotice("Suggested message inserted.");
      }
    } catch (error) {
      showNotice(error.message, true);
    }
  });

  $("monitoredContainer").addEventListener("change", async (event) => {
    const checkbox = event.target.closest('input[data-role="profile-entity-toggle"]');
    if (!checkbox) {
      return;
    }
    try {
      const payload = await api(
        `api/profiles/${encodeURIComponent(checkbox.dataset.profileId)}/entities/${encodeURIComponent(
          checkbox.dataset.entityId
        )}`,
        {
          method: "POST",
          body: {
            enabled: checkbox.checked
          }
        }
      );
      applyBootstrap(payload);
    } catch (error) {
      showNotice(error.message, true);
      checkbox.checked = !checkbox.checked;
    }
  });
}

function connectEventStream() {
  const source = new EventSource("api/stream");

  source.addEventListener("bootstrap", (event) => {
    const payload = JSON.parse(event.data);
    applyBootstrap(payload);
  });

  source.addEventListener("status", (event) => {
    if (!state.bootstrap) {
      return;
    }
    state.bootstrap.status = JSON.parse(event.data);
    renderStatus();
  });

  source.addEventListener("error", (event) => {
    if (!event.data) {
      return;
    }
    try {
      const payload = JSON.parse(event.data);
      if (payload.message) {
        showNotice(payload.message, true);
      }
    } catch (error) {
      console.error(error);
    }
  });

  source.onerror = () => {
    setBadge($("connectionStatus"), "Waiting for stream reconnect...", "warning");
  };
}

async function init() {
  registerEventHandlers();
  await refreshBootstrap();
  await searchEntities();
  connectEventStream();
}

init().catch((error) => {
  console.error(error);
  showNotice(error.message, true);
});
