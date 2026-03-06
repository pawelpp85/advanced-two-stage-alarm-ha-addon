const path = require("path");
const express = require("express");
const { ConfigStore } = require("./lib/store");
const { HomeAssistantClient } = require("./lib/haClient");
const { TwoStageAlarmEngine } = require("./lib/alarmEngine");

const PORT = Number(process.env.PORT || 8099);

function sendError(res, error, status = 400) {
  res.status(status).json({
    ok: false,
    error: error?.message || String(error)
  });
}

async function bootstrap() {
  const store = new ConfigStore(process.env.CONFIG_PATH || "/data/two_stage_alarm_config.json");
  await store.init();

  const haClient = new HomeAssistantClient({
    wsUrl: process.env.HA_WS_URL || "ws://supervisor/core/websocket",
    apiBaseUrl: process.env.HA_API_URL || "http://supervisor/core/api",
    token: process.env.SUPERVISOR_TOKEN || ""
  });

  const engine = new TwoStageAlarmEngine({ haClient, store });
  await engine.start();

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const sseClients = new Set();
  const sendSse = (eventName, payload) => {
    const packet = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of sseClients) {
      response.write(packet);
    }
  };

  engine.on("status_changed", (status) => sendSse("status", status));
  engine.on("config_changed", (bootstrapPayload) => sendSse("bootstrap", bootstrapPayload));
  engine.on("error", (error) => {
    console.error(`[alarm-engine] ${error.message}`);
    sendSse("error", { message: error.message });
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      connectedToHa: engine.getStatus().connectedToHa
    });
  });

  app.get("/api/bootstrap", (_req, res) => {
    res.json({
      ok: true,
      ...engine.getBootstrap()
    });
  });

  app.get("/api/entities", (req, res) => {
    const query = String(req.query.query || "");
    const limit = Number(req.query.limit || 120);
    res.json({
      ok: true,
      entities: engine.searchEntities(query, limit)
    });
  });

  app.get("/api/suggest-message", (req, res) => {
    const entityId = String(req.query.entity_id || "").toLowerCase();
    const language = String(req.query.lang || "en");
    if (!entityId) {
      return sendError(res, new Error("Missing entity_id"));
    }
    res.json({
      ok: true,
      message: engine.suggestMessage(entityId, language)
    });
  });

  app.post("/api/actions/arm", async (req, res) => {
    try {
      await engine.setSystemArmed(Boolean(req.body?.armed));
      res.json({ ok: true, status: engine.getStatus() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/actions/disarm-warning", async (_req, res) => {
    try {
      await engine.disarmWarning();
      res.json({ ok: true, status: engine.getStatus() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/actions/select-profile", async (req, res) => {
    try {
      await engine.selectProfile(req.body?.profileId);
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/monitored", async (req, res) => {
    try {
      await engine.addMonitoredEntity(req.body?.entity_id, Boolean(req.body?.immediate));
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch("/api/monitored/:entityId", async (req, res) => {
    try {
      const entityId = decodeURIComponent(req.params.entityId);
      await engine.updateMonitoredEntity(entityId, req.body || {});
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete("/api/monitored/:entityId", async (req, res) => {
    try {
      const entityId = decodeURIComponent(req.params.entityId);
      await engine.removeMonitoredEntity(entityId);
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/profiles", async (req, res) => {
    try {
      const name = String(req.body?.name || "New profile");
      await engine.addProfile(name);
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch("/api/profiles/:profileId", async (req, res) => {
    try {
      const profileId = decodeURIComponent(req.params.profileId);
      await engine.renameProfile(profileId, req.body?.name);
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete("/api/profiles/:profileId", async (req, res) => {
    try {
      const profileId = decodeURIComponent(req.params.profileId);
      await engine.removeProfile(profileId);
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/profiles/:profileId/entities/:entityId", async (req, res) => {
    try {
      const profileId = decodeURIComponent(req.params.profileId);
      const entityId = decodeURIComponent(req.params.entityId);
      await engine.setProfileEntityEnabled(profileId, entityId, Boolean(req.body?.enabled));
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/settings/timings", async (req, res) => {
    try {
      await engine.setTimings(req.body?.warningDelaySec, req.body?.alarmDurationSec);
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/settings/panel-entities", async (req, res) => {
    try {
      await engine.setPanelEntities(req.body?.warning, req.body?.main);
      res.json({ ok: true, ...engine.getBootstrap() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    res.write(`event: bootstrap\ndata: ${JSON.stringify(engine.getBootstrap())}\n\n`);
    sseClients.add(res);

    req.on("close", () => {
      sseClients.delete(res);
    });
  });

  app.use("/", express.static(path.join(__dirname, "public")));

  app.listen(PORT, () => {
    console.log(`Advanced Two-Stage Alarm add-on listening on port ${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
