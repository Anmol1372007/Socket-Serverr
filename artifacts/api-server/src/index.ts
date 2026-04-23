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

interface ChatMessage {
  id: string;
  user: string;
  text: string;
  timestamp: number;
}

const recentMessages: ChatMessage[] = [];
const MAX_HISTORY = 50;
const onlineUsers = new Map<string, string>();

function broadcastUserList() {
  io.emit("users", Array.from(new Set(onlineUsers.values())));
}

io.on("connection", (socket) => {
  logger.info({ socketId: socket.id }, "Socket connected");

  socket.emit("history", recentMessages);

  socket.on("join", (rawUser: unknown) => {
    const user =
      typeof rawUser === "string" && rawUser.trim().length > 0
        ? rawUser.trim().slice(0, 32)
        : `guest-${socket.id.slice(0, 4)}`;
    onlineUsers.set(socket.id, user);
    socket.data["user"] = user;
    io.emit("system", `${user} joined the chat`);
    broadcastUserList();
  });

  socket.on("message", (rawText: unknown) => {
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) return;
    const user = (socket.data["user"] as string) ?? "anonymous";
    const msg: ChatMessage = {
      id: `${Date.now()}-${socket.id}`,
      user,
      text: text.slice(0, 500),
      timestamp: Date.now(),
    };
    recentMessages.push(msg);
    if (recentMessages.length > MAX_HISTORY) {
      recentMessages.shift();
    }
    io.emit("message", msg);
  });

  socket.on("typing", (isTyping: unknown) => {
    const user = socket.data["user"] as string | undefined;
    if (!user) return;
    socket.broadcast.emit("typing", { user, isTyping: Boolean(isTyping) });
  });

  socket.on("disconnect", () => {
    const user = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    if (user) {
      io.emit("system", `${user} left the chat`);
    }
    broadcastUserList();
    logger.info({ socketId: socket.id }, "Socket disconnected");
  });
});

httpServer.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening (HTTP + Socket.IO)");
});
