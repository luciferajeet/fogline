const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const {
  createGame,
  applyMove,
  useDoubleMove,
  currentPlayerId,
  viewFor,
  map
} = require("./game");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));
app.get("/map-meta", (req, res) => {
  res.json({ width: map.width, height: map.height, riverY: map.riverY, stations: map.stations, hubs: map.hubs, edges: map.edges });
});

const MAX_PLAYERS = 6;
const MIN_PLAYERS = 3;
const RECONNECT_GRACE_MS = 10 * 60 * 1000; // how long a seat is held for a disconnected player

// rooms[roomId] = {
//   id, hostId (persistent player token), status: 'lobby'|'playing',
//   players: [{ id: token, socketId, name }],   <- lobby roster / identity+routing table
//   state: gameState|null                       <- gameState.players is keyed by the same tokens
// }
const rooms = {};

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function newToken() {
  return crypto.randomUUID();
}

function lobbyPayload(room) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    status: room.status,
    players: room.players.map(p => ({ id: p.id, name: p.name }))
  };
}

// Send each player their own fog-of-war-filtered view, routed to their CURRENT socket
function broadcastState(room) {
  room.players.forEach(p => {
    if (p.socketId) io.to(p.socketId).emit("state_update", viewFor(room.state, p.id));
  });
}

function broadcastLobby(room) {
  room.players.forEach(p => {
    if (p.socketId) io.to(p.socketId).emit("lobby_update", lobbyPayload(room));
  });
}

function clearRoomTimeout(room) {
  if (room.emptyTimer) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }
}

function scheduleRoomCleanupIfEmpty(room) {
  const anyConnected = room.players.some(p => p.socketId);
  if (anyConnected) return;
  clearRoomTimeout(room);
  room.emptyTimer = setTimeout(() => {
    if (rooms[room.id] === room) delete rooms[room.id];
  }, RECONNECT_GRACE_MS);
}

io.on("connection", socket => {
  socket.on("create_room", ({ name, token }) => {
    const playerId = token || newToken();
    const id = roomCode();
    const room = {
      id,
      hostId: playerId,
      players: [{ id: playerId, socketId: socket.id, name: name || "Player" }],
      status: "lobby",
      state: null,
      emptyTimer: null
    };
    rooms[id] = room;
    socket.join(id);
    socket.data.roomId = id;
    socket.data.playerId = playerId;
    socket.emit("room_joined", { roomId: id, youId: playerId, token: playerId });
    broadcastLobby(room);
  });

  socket.on("join_room", ({ roomId, name, token }) => {
    const room = rooms[(roomId || "").toUpperCase()];
    if (!room) return socket.emit("error_message", "Room not found.");
    if (room.status !== "lobby") return socket.emit("error_message", "That game has already started.");
    if (room.players.length >= MAX_PLAYERS) return socket.emit("error_message", "Room is full.");
    const playerId = token || newToken();
    room.players.push({ id: playerId, socketId: socket.id, name: name || "Player" });
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerId = playerId;
    socket.emit("room_joined", { roomId: room.id, youId: playerId, token: playerId });
    broadcastLobby(room);
  });

  // Rejoin an in-progress (or lobby) game using a previously-issued token,
  // e.g. after a page refresh or dropped connection.
  socket.on("rejoin_room", ({ roomId, token, name }) => {
    const room = rooms[(roomId || "").toUpperCase()];
    if (!room || !token) return socket.emit("rejoin_failed");

    const rosterEntry = room.players.find(p => p.id === token);
    const gameEntry = room.state && room.state.players[token];

    if (!rosterEntry && !gameEntry) return socket.emit("rejoin_failed");

    clearRoomTimeout(room);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerId = token;

    if (rosterEntry) {
      rosterEntry.socketId = socket.id;
      if (name) rosterEntry.name = name;
    } else {
      room.players.push({ id: token, socketId: socket.id, name: (gameEntry && gameEntry.name) || name || "Player" });
    }

    if (gameEntry) {
      gameEntry.connected = true;
      room.state.log.push({ text: `${gameEntry.name} reconnected.`, round: room.state.round });
    }

    socket.emit("room_joined", { roomId: room.id, youId: token, token });

    if (room.status === "playing") {
      socket.emit("game_started");
      broadcastState(room);
    } else {
      broadcastLobby(room);
    }
  });

  socket.on("start_game", () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.hostId !== socket.data.playerId) return;
    if (room.players.length < MIN_PLAYERS) return socket.emit("error_message", `Need at least ${MIN_PLAYERS} players.`);
    if (room.players.length > MAX_PLAYERS) return socket.emit("error_message", `At most ${MAX_PLAYERS} players.`);

    const shuffled = [...room.players].sort(() => Math.random() - 0.5);
    const roles = shuffled.map((p, i) => ({ id: p.id, name: p.name, role: i === 0 ? "mrx" : "detective" }));
    room.status = "playing";
    room.state = createGame(room.id, roles);
    room.players.forEach(p => {
      if (p.socketId) io.to(p.socketId).emit("game_started");
    });
    broadcastState(room);
  });

  socket.on("request_move", ({ toStation, ticket }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.state) return;
    const result = applyMove(room.state, socket.data.playerId, toStation, ticket);
    if (!result.ok) return socket.emit("error_message", result.error);
    broadcastState(room);
  });

  socket.on("request_double", () => {
    const room = rooms[socket.data.roomId];
    if (!room || !room.state) return;
    const result = useDoubleMove(room.state, socket.data.playerId);
    if (!result.ok) return socket.emit("error_message", result.error);
    broadcastState(room);
  });

  socket.on("chat_message", ({ text }) => {
    const room = rooms[socket.data.roomId];
    if (!room || !text || !text.trim()) return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    room.players.forEach(p => {
      if (p.socketId) io.to(p.socketId).emit("chat_message", { name: player ? player.name : "?", text: text.slice(0, 300), ts: Date.now() });
    });
  });

  socket.on("disconnect", () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const playerId = socket.data.playerId;
    const rosterEntry = room.players.find(p => p.id === playerId);
    if (rosterEntry) rosterEntry.socketId = null;

    if (room.status === "playing" && room.state && room.state.players[playerId]) {
      // Keep their seat & tickets intact — they can rejoin with the same token.
      room.state.players[playerId].connected = false;
      room.state.log.push({ text: `${room.state.players[playerId].name} disconnected.`, round: room.state.round });
      broadcastState(room);
      scheduleRoomCleanupIfEmpty(room);
    } else {
      // Still in the lobby: no seat/tickets to preserve, just drop them from the roster.
      room.players = room.players.filter(p => p.id !== playerId);
      if (room.players.length === 0) {
        delete rooms[room.id];
      } else {
        if (room.hostId === playerId) room.hostId = room.players[0].id;
        broadcastLobby(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Scotland Yard server running on port ${PORT}`));
