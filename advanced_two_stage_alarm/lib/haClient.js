const { EventEmitter } = require("events");
const fs = require("fs");
const WebSocket = require("ws");

class HomeAssistantClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.wsUrl = options.wsUrl || process.env.HA_WS_URL || "ws://supervisor/core/websocket";
    this.apiBaseUrl = options.apiBaseUrl || process.env.HA_API_URL || "http://supervisor/core/api";
    this.token = String(options.token || "").trim();
    this.tokenFileCandidates = [
      "/run/s6/container_environment/SUPERVISOR_TOKEN",
      "/run/secrets/supervisor_token"
    ];

    this.ws = null;
    this.ready = false;
    this.commandId = 1;
    this.pending = new Map();
    this.reconnectDelayMs = 2500;
    this.reconnectTimer = null;
    this.eventSubscriptionId = null;
    this.missingTokenReported = false;
  }

  connect() {
    const resolvedToken = this._resolveToken();
    if (!resolvedToken) {
      if (!this.missingTokenReported) {
        this.emit(
          "error",
          new Error(
            "Missing SUPERVISOR_TOKEN for Home Assistant API communication. Checked env vars and supervisor token files."
          )
        );
      }
      this.missingTokenReported = true;
      this._scheduleReconnect();
      return;
    }
    this.missingTokenReported = false;
    this.token = resolvedToken;
    this._connectSocket();
  }

  _connectSocket() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }

    this.ws = new WebSocket(this.wsUrl);
    this.ws.on("message", (buffer) => this._handleMessage(buffer));
    this.ws.on("close", () => this._handleClose());
    this.ws.on("error", (error) => this.emit("error", error));
  }

  _handleMessage(buffer) {
    let message;
    try {
      message = JSON.parse(buffer.toString());
    } catch (error) {
      this.emit("error", new Error("Failed to parse Home Assistant WS message."));
      return;
    }

    if (message.type === "auth_required") {
      this.ws.send(
        JSON.stringify({
          type: "auth",
          access_token: this.token
        })
      );
      return;
    }

    if (message.type === "auth_ok") {
      this.ready = true;
      this.emit("connected");
      return;
    }

    if (message.type === "auth_invalid") {
      this.emit("error", new Error(`Home Assistant WS auth failed: ${message.message || "unknown error"}`));
      this.ws.close();
      return;
    }

    if (message.type === "result" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.success) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error?.message || "Home Assistant WS command failed."));
      }
      return;
    }

    if (message.type === "event") {
      this.emit("event", message.event);
    }
  }

  _handleClose() {
    this.ready = false;
    this.eventSubscriptionId = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Home Assistant WS request ${id} failed due to disconnection.`));
    }
    this.pending.clear();
    this.emit("disconnected");
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelayMs);
  }

  _resolveToken() {
    const envCandidates = [
      this.token,
      process.env.SUPERVISOR_TOKEN,
      process.env.HASSIO_TOKEN,
      process.env.HA_TOKEN
    ];
    for (const candidate of envCandidates) {
      const value = String(candidate || "").trim();
      if (value) {
        return value;
      }
    }

    for (const tokenPath of this.tokenFileCandidates) {
      try {
        const value = fs.readFileSync(tokenPath, "utf8").trim();
        if (value) {
          return value;
        }
      } catch (_error) {
        continue;
      }
    }
    return "";
  }

  sendCommand(type, payload = {}, timeoutMs = 10000) {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Home Assistant WS is not ready."));
    }

    const id = this.commandId++;
    const packet = { id, type, ...payload };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Home Assistant WS command timed out: ${type}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify(packet), (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async ensureEventSubscription() {
    if (!this.ready) {
      throw new Error("Cannot subscribe to events while Home Assistant WS is disconnected.");
    }
    if (this.eventSubscriptionId) {
      return;
    }
    const result = await this.sendCommand("subscribe_events", { event_type: "state_changed" });
    this.eventSubscriptionId = result;
  }

  async getStates() {
    return this.sendCommand("get_states");
  }

  async getRegistries() {
    const [entityRegistry, deviceRegistry, areaRegistry] = await Promise.all([
      this.sendCommand("config/entity_registry/list"),
      this.sendCommand("config/device_registry/list"),
      this.sendCommand("config/area_registry/list")
    ]);
    return { entityRegistry, deviceRegistry, areaRegistry };
  }

  async setState(entityId, state, attributes = {}) {
    if (!this.token) {
      this.token = this._resolveToken();
    }
    if (!this.token) {
      throw new Error("Cannot call Home Assistant state API without SUPERVISOR_TOKEN.");
    }
    const response = await fetch(`${this.apiBaseUrl}/states/${entityId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        state: String(state),
        attributes
      })
    });

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`Failed to update state ${entityId}: HTTP ${response.status} ${payload}`);
    }
  }
}

module.exports = {
  HomeAssistantClient
};
