const { EventEmitter } = require("events");
const WebSocket = require("ws");

class HomeAssistantClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.wsUrl = options.wsUrl || process.env.HA_WS_URL || "ws://supervisor/core/websocket";
    this.apiBaseUrl = options.apiBaseUrl || process.env.HA_API_URL || "http://supervisor/core/api";
    this.token = options.token || process.env.SUPERVISOR_TOKEN || "";

    this.ws = null;
    this.ready = false;
    this.commandId = 1;
    this.pending = new Map();
    this.reconnectDelayMs = 2500;
    this.reconnectTimer = null;
    this.eventSubscriptionId = null;
  }

  connect() {
    if (!this.token) {
      throw new Error("Missing SUPERVISOR_TOKEN for Home Assistant API communication.");
    }
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

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._connectSocket(), this.reconnectDelayMs);
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
