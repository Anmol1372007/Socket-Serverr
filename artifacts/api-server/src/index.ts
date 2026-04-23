import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { desc, eq } from "drizzle-orm";
import { db, alertsTable, type Alert } from "@workspace/db";
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
  emergencyType: string;
  timestamp: number;
  status: "active" | "acknowledged" | "resolved";
  acknowledgedBy?: string;
  acknowledgedAt?: number;
  resolvedAt?: number;
}

function rowToAlert(row: Alert): SosAlert {
  const meta = ackMeta.get(row.id);
  return {
    id: String(row.id),
    room: row.roomNumber,
    emergencyType: row.emergencyType,
    timestamp: row.createdAt.getTime(),
    status: row.status as SosAlert["status"],
    acknowledgedBy: meta?.acknowledgedBy,
    acknowledgedAt: meta?.acknowledgedAt,
    resolvedAt: meta?.resolvedAt,
  };
}

interface AckMeta {
  acknowledgedBy?: string;
  acknowledgedAt?: number;
  resolvedAt?: number;
}
const ackMeta = new Map<number, AckMeta>();

async function loadRecentAlerts(limit = 50): Promise<SosAlert[]> {
  const rows = await db
    .select()
    .from(alertsTable)
    .orderBy(desc(alertsTable.createdAt))
    .limit(limit);
  return rows.map(rowToAlert);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function alertsToCsv(alerts: SosAlert[]): string {
  const header = [
    "id",
    "room",
    "emergency_type",
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
        a.emergencyType,
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

app.get("/api/alerts.csv", async (_req, res, next) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const all = await loadRecentAlerts(1000);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="sos-alerts-${stamp}.csv"`,
    );
    res.send(alertsToCsv(all));
  } catch (err) {
    next(err);
  }
});

app.get("/api/incidents", async (_req, res, next) => {
  try {
    const recent = await loadRecentAlerts(10);
    res.json({ incidents: recent });
  } catch (err) {
    next(err);
  }
});
let staffCount = 0;

function publishStaffCount() {
  io.to("staff").emit("staff:count", staffCount);
}

io.on("connection", (socket) => {
  logger.info({ socketId: socket.id }, "Socket connected");

  socket.on("staff:join", async () => {
    socket.join("staff");
    staffCount += 1;
    try {
      const snapshot = await loadRecentAlerts(50);
      socket.emit("alerts:snapshot", snapshot);
    } catch (err) {
      logger.error({ err }, "Failed to load alerts snapshot");
      socket.emit("alerts:snapshot", []);
    }
    publishStaffCount();
    logger.info({ socketId: socket.id, staffCount }, "Staff joined");
  });

  socket.on("guest:sos", async (rawRoom: unknown) => {
    const room =
      typeof rawRoom === "string" && rawRoom.trim().length > 0
        ? rawRoom.trim().slice(0, 16).toUpperCase()
        : "UNKNOWN";

    try {
      const [row] = await db
        .insert(alertsTable)
        .values({
          roomNumber: room,
          emergencyType: "SOS",
          status: "active",
        })
        .returning();
      if (!row) throw new Error("Insert returned no row");
      const alert = rowToAlert(row);

      io.to("staff").emit("alert:new", alert);
      socket.emit("guest:sos:received", alert);
      logger.warn({ alert }, "EMERGENCY SOS triggered");
    } catch (err) {
      logger.error({ err, room }, "Failed to persist SOS alert");
      socket.emit("guest:sos:error", "Could not save your alert. Try again.");
    }
  });

  socket.on(
    "alert:acknowledge",
    async (payload: { id?: unknown; by?: unknown } | undefined) => {
      const idStr = typeof payload?.id === "string" ? payload.id : null;
      const idNum = idStr ? Number(idStr) : NaN;
      if (!Number.isFinite(idNum)) return;
      const by =
        typeof payload?.by === "string" && payload.by.trim().length > 0
          ? payload.by.trim().slice(0, 32)
          : "Staff";
      try {
        const [row] = await db
          .update(alertsTable)
          .set({ status: "acknowledged" })
          .where(eq(alertsTable.id, idNum))
          .returning();
        if (!row) return;
        ackMeta.set(idNum, {
          ...(ackMeta.get(idNum) ?? {}),
          acknowledgedBy: by,
          acknowledgedAt: Date.now(),
        });
        io.to("staff").emit("alert:update", rowToAlert(row));
      } catch (err) {
        logger.error({ err, idNum }, "Failed to acknowledge alert");
      }
    },
  );

  socket.on(
    "alert:resolve",
    async (payload: { id?: unknown } | undefined) => {
      const idStr = typeof payload?.id === "string" ? payload.id : null;
      const idNum = idStr ? Number(idStr) : NaN;
      if (!Number.isFinite(idNum)) return;
      try {
        const [row] = await db
          .update(alertsTable)
          .set({ status: "resolved" })
          .where(eq(alertsTable.id, idNum))
          .returning();
        if (!row) return;
        ackMeta.set(idNum, {
          ...(ackMeta.get(idNum) ?? {}),
          resolvedAt: Date.now(),
        });
        io.to("staff").emit("alert:update", rowToAlert(row));
      } catch (err) {
        logger.error({ err, idNum }, "Failed to resolve alert");
      }
    },
  );

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
