import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: { origin: "*" },
});

interface SosAlert {
  id: string;
  room: string;
  timestamp: number;
  status: "active" | "acknowledged" | "resolved";
  acknowledgedBy?: string;
  acknowledgedAt?: number;
  resolvedAt?: number;
}

const alerts: SosAlert[] = [];
const MAX_ALERTS = 200;

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function alertsToCsv(): string {
  const header = [
    "id",
    "room",
    "triggered_at",
    "status",
    "acknowledged_by",
    "acknowledged_at",
    "resolved_at",
    "response_time_seconds",
  ].join(",");
  const rows = alerts
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((a) => {
      const responseSecs =
        a.acknowledgedAt != null
          ? Math.round((a.acknowledgedAt - a.timestamp) / 1000).toString()
          : "";
      return [
        a.id,
        a.room,
        new Date(a.timestamp).toISOString(),
        a.status,
        a.acknowledgedBy ?? "",
        a.acknowledgedAt != null
          ? new Date(a.acknowledgedAt).toISOString()
          : "",
        a.resolvedAt != null ? new Date(a.resolvedAt).toISOString() : "",
        responseSecs,
      ]
        .map((v) => csvEscape(String(v)))
        .join(",");
    });
  return [header, ...rows].join("\n") + "\n";
}

app.get("/api/alerts.csv", (_req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="sos-alerts-${stamp}.csv"`,
  );
  res.send(alertsToCsv());
});
let staffCount = 0;

function publishStaffCount() {
  io.to("staff").emit("staff:count", staffCount);
}

io.on("connection", (socket) => {
  logger.info({ socketId: socket.id }, "Socket connected");

  socket.on("staff:join", () => {
    socket.join("staff");
    staffCount += 1;
    socket.emit("alerts:snapshot", alerts);
    publishStaffCount();
    logger.info({ socketId: socket.id, staffCount }, "Staff joined");
  });

  socket.on("guest:sos", (rawRoom: unknown) => {
    const room =
      typeof rawRoom === "string" && rawRoom.trim().length > 0
        ? rawRoom.trim().slice(0, 16).toUpperCase()
        : "UNKNOWN";

    const alert: SosAlert = {
      id: `${Date.now()}-${socket.id.slice(0, 6)}`,
      room,
      timestamp: Date.now(),
      status: "active",
    };
    alerts.unshift(alert);
    if (alerts.length > MAX_ALERTS) alerts.pop();

    io.to("staff").emit("alert:new", alert);
    socket.emit("guest:sos:received", alert);
    logger.warn({ alert }, "EMERGENCY SOS triggered");
  });

  socket.on(
    "alert:acknowledge",
    (payload: { id?: unknown; by?: unknown } | undefined) => {
      const id = typeof payload?.id === "string" ? payload.id : null;
      const by =
        typeof payload?.by === "string" && payload.by.trim().length > 0
          ? payload.by.trim().slice(0, 32)
          : "Staff";
      if (!id) return;
      const alert = alerts.find((a) => a.id === id);
      if (!alert || alert.status !== "active") return;
      alert.status = "acknowledged";
      alert.acknowledgedBy = by;
      alert.acknowledgedAt = Date.now();
      io.to("staff").emit("alert:update", alert);
    },
  );

  socket.on("alert:resolve", (payload: { id?: unknown } | undefined) => {
    const id = typeof payload?.id === "string" ? payload.id : null;
    if (!id) return;
    const alert = alerts.find((a) => a.id === id);
    if (!alert || alert.status === "resolved") return;
    alert.status = "resolved";
    alert.resolvedAt = Date.now();
    io.to("staff").emit("alert:update", alert);
  });

  socket.on("disconnect", () => {
    if (socket.rooms.has("staff") || socket.data["isStaff"]) {
      // no-op; rooms already left
    }
    // Decrement only if this socket was in staff room
    // socket.io has already removed it from rooms by now, so track via flag
    if ((socket as unknown as { _wasStaff?: boolean })._wasStaff) {
      staffCount = Math.max(0, staffCount - 1);
      publishStaffCount();
    }
    logger.info({ socketId: socket.id }, "Socket disconnected");
  });

  // Track staff membership for accurate disconnect counting
  const origJoin = socket.join.bind(socket);
  socket.join = ((room: string | string[]) => {
    const result = origJoin(room as string);
    const rooms = Array.isArray(room) ? room : [room];
    if (rooms.includes("staff")) {
      (socket as unknown as { _wasStaff?: boolean })._wasStaff = true;
    }
    return result;
  }) as typeof socket.join;
});

httpServer.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening (HTTP + Socket.IO)");
});
