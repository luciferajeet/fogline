const socket = io();

let myId = null;
let roomId = null;
let isHost = false;
let mapMeta = null;
let latestState = null;
let selectedTicket = null;
let stationEls = {}; // id -> {group, dot}

// ===================== PERSISTENT IDENTITY (for reconnect) =====================
function getToken() {
  let t = localStorage.getItem("fogline_token");
  if (!t) {
    t = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
    localStorage.setItem("fogline_token", t);
  }
  return t;
}
function rememberRoom(rid) { localStorage.setItem("fogline_room", rid); }
function forgetSession() {
  localStorage.removeItem("fogline_room");
  localStorage.removeItem("fogline_token");
}

// On load / on (re)connect, try to silently resume a session we were in before.
function attemptAutoRejoin() {
  const savedRoom = localStorage.getItem("fogline_room");
  const savedToken = localStorage.getItem("fogline_token");
  if (savedRoom && savedToken) {
    socket.emit("rejoin_room", { roomId: savedRoom, token: savedToken, name: getName() });
  }
}
socket.on("connect", () => {
  if (myId) return; // already active in a session this page-load, nothing to resume
  attemptAutoRejoin();
});
socket.on("rejoin_failed", () => {
  forgetSession();
});

const screens = {
  home: document.getElementById("screen-home"),
  lobby: document.getElementById("screen-lobby"),
  game: document.getElementById("screen-game"),
  end: document.getElementById("screen-end")
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
}

// ===================== HOME =====================
const inputName = document.getElementById("input-name");
const inputCode = document.getElementById("input-code");
const homeError = document.getElementById("home-error");

function getName() {
  const n = inputName.value.trim();
  return n || "Inspector";
}

document.getElementById("btn-create").addEventListener("click", () => {
  homeError.textContent = "";
  socket.emit("create_room", { name: getName(), token: getToken() });
});

document.getElementById("btn-join").addEventListener("click", () => {
  homeError.textContent = "";
  const code = inputCode.value.trim().toUpperCase();
  if (!code) { homeError.textContent = "Enter a room code."; return; }
  socket.emit("join_room", { roomId: code, name: getName(), token: getToken() });
});

socket.on("error_message", msg => {
  homeError.textContent = msg;
  document.getElementById("lobby-error").textContent = msg;
});

// ===================== LOBBY =====================
socket.on("room_joined", ({ roomId: rid, youId }) => {
  roomId = rid;
  myId = youId;
  rememberRoom(rid);
  // Default to the lobby screen; if we're actually mid-game, a "game_started"
  // event follows immediately and switches us to the game screen instead.
  showScreen("lobby");
});

socket.on("lobby_update", payload => {
  roomId = payload.roomId;
  isHost = payload.hostId === myId;
  document.getElementById("room-code-display").textContent = payload.roomId;
  document.getElementById("game-room-code").textContent = payload.roomId;

  const list = document.getElementById("lobby-players");
  list.innerHTML = "";
  payload.players.forEach(p => {
    const li = document.createElement("li");
    li.textContent = p.name;
    if (p.id === payload.hostId) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "HOST";
      li.appendChild(tag);
    }
    list.appendChild(li);
  });

  const startBtn = document.getElementById("btn-start");
  startBtn.style.display = isHost ? "block" : "none";
  startBtn.disabled = payload.players.length < 3 || payload.players.length > 6;
  document.getElementById("lobby-error").textContent = "";
});

document.getElementById("btn-start").addEventListener("click", () => {
  socket.emit("start_game");
});

// ===================== GAME START =====================
socket.on("game_started", async () => {
  if (!mapMeta) {
    const res = await fetch("/map-meta");
    mapMeta = await res.json();
    buildBoard();
  }
  showScreen("game");
});

// ===================== BOARD BUILD =====================
function buildBoard() {
  const container = document.getElementById("board-container");
  const { width, height, stations, edges } = mapMeta;
  const byId = {};
  stations.forEach(s => (byId[s.id] = s));

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", "1000");
  svg.setAttribute("height", "760");

  const edgeLayer = document.createElementNS(ns, "g");
  const stationLayer = document.createElementNS(ns, "g");
  const tokenLayer = document.createElementNS(ns, "g");
  tokenLayer.setAttribute("id", "token-layer");
  svg.appendChild(edgeLayer);
  svg.appendChild(stationLayer);
  svg.appendChild(tokenLayer);

  function drawEdges(type, className) {
    edges[type].forEach(([a, b]) => {
      const sa = byId[a], sb = byId[b];
      if (!sa || !sb) return;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", sa.x); line.setAttribute("y1", sa.y);
      line.setAttribute("x2", sb.x); line.setAttribute("y2", sb.y);
      line.setAttribute("class", className);
      line.setAttribute("stroke-width", type === "underground" ? 3 : 2);
      edgeLayer.appendChild(line);
    });
  }
  drawEdges("taxi", "edge-taxi");
  drawEdges("bus", "edge-bus");
  drawEdges("underground", "edge-underground");

  stations.forEach(s => {
    const g = document.createElementNS(ns, "g");
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", s.x);
    dot.setAttribute("cy", s.y);
    dot.setAttribute("r", mapMeta.hubs.includes(s.id) ? 7 : 5);
    dot.setAttribute("fill", mapMeta.hubs.includes(s.id) ? "#3E7CB1" : "#4A5568");
    dot.setAttribute("class", "station-dot");
    dot.dataset.id = s.id;
    dot.addEventListener("click", () => onStationClick(s.id));
    g.appendChild(dot);

    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", s.x + 8);
    label.setAttribute("y", s.y - 8);
    label.setAttribute("class", "station-label");
    label.textContent = s.id;
    g.appendChild(label);

    stationLayer.appendChild(g);
    stationEls[s.id] = { dot };
  });

  container.innerHTML = "";
  container.appendChild(svg);
}

function stationById(id) {
  return mapMeta.stations.find(s => s.id === id);
}

// ===================== STATE UPDATES =====================
socket.on("state_update", state => {
  latestState = state;
  renderState();
});

function renderState() {
  if (!latestState || !mapMeta) return;
  const s = latestState;

  document.getElementById("round-number").textContent = s.round;
  const myTurn = s.currentPlayerId === myId && s.status === "playing";
  const turnEl = document.getElementById("turn-indicator");
  if (s.status === "ended") {
    turnEl.textContent = "Case closed";
    turnEl.classList.remove("my-turn");
  } else if (myTurn) {
    turnEl.textContent = "Your move";
    turnEl.classList.add("my-turn");
  } else {
    const p = s.players[s.currentPlayerId];
    turnEl.textContent = p ? `${p.name}'s move` : "...";
    turnEl.classList.remove("my-turn");
  }

  const revealStrip = document.getElementById("reveal-strip");
  if (s.revealRounds.includes(s.round) && s.round > 0) {
    revealStrip.textContent = `Mr. X's location has been revealed`;
    revealStrip.classList.add("show");
  } else {
    revealStrip.classList.remove("show");
  }

  renderPlayers(s);
  renderTokens(s);
  renderTickets(s);
  renderLog(s);

  if (s.status === "ended") {
    setTimeout(() => renderEnd(s), 900);
  }
}

function ticketAbbrev(t) {
  return { taxi: "TX", bus: "BS", underground: "UG", black: "BLK", double: "2X" }[t] || t;
}

function renderPlayers(s) {
  const block = document.getElementById("players-block");
  block.innerHTML = "";
  s.turnOrder.forEach(pid => {
    const p = s.players[pid];
    if (!p) return;
    const row = document.createElement("div");
    row.className = "player-row" + (pid === s.currentPlayerId ? " active-turn" : "") + (p.connected === false ? " disconnected" : "");
    const dot = document.createElement("div");
    dot.className = "player-dot";
    dot.style.background = p.role === "mrx" && pid !== myId ? "#555" : p.color;
    row.appendChild(dot);

    const nameWrap = document.createElement("div");
    nameWrap.style.flex = "1";
    const nm = document.createElement("div");
    nm.className = "player-name";
    nm.textContent = p.name + (pid === myId ? " (you)" : "");
    const role = document.createElement("div");
    role.className = "player-role-tag";
    role.textContent = p.role === "mrx" ? (pid === myId ? "Fugitive" : "Fugitive (hidden)") : "Detective";
    nameWrap.appendChild(nm);
    nameWrap.appendChild(role);
    row.appendChild(nameWrap);

    const tix = document.createElement("div");
    tix.className = "player-tickets";
    Object.entries(p.tickets).forEach(([type, count]) => {
      const span = document.createElement("span");
      span.textContent = `${ticketAbbrev(type)} ${count}`;
      tix.appendChild(span);
    });
    row.appendChild(tix);

    block.appendChild(row);
  });
}

function renderTokens(s) {
  const layer = document.getElementById("token-layer");
  if (!layer) return;
  layer.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";

  const byStation = {};
  Object.values(s.players).forEach(p => {
    if (p.position == null) return;
    byStation[p.position] = byStation[p.position] || [];
    byStation[p.position].push(p);
  });

  Object.entries(byStation).forEach(([stationId, players]) => {
    const station = stationById(Number(stationId));
    if (!station) return;
    players.forEach((p, i) => {
      const angle = (i / players.length) * Math.PI * 2;
      const offset = players.length > 1 ? 10 : 0;
      const cx = station.x + Math.cos(angle) * offset;
      const cy = station.y + Math.sin(angle) * offset;

      const isHiddenMrX = p.role === "mrx" && p.id !== myId;
      const circle = document.createElementNS(ns, "circle");
      circle.setAttribute("cx", cx);
      circle.setAttribute("cy", cy);
      circle.setAttribute("r", isHiddenMrX ? 14 : 9);
      circle.setAttribute("fill", isHiddenMrX ? "#8B2635" : p.color);
      circle.setAttribute("fill-opacity", isHiddenMrX ? 0.35 : 1);
      circle.setAttribute("stroke", "#0d1116");
      circle.setAttribute("stroke-width", 2);
      if (isHiddenMrX) circle.setAttribute("class", "mrx-marker");
      layer.appendChild(circle);

      if (!isHiddenMrX) {
        const initial = document.createElementNS(ns, "text");
        initial.setAttribute("x", cx);
        initial.setAttribute("y", cy + 3);
        initial.setAttribute("text-anchor", "middle");
        initial.setAttribute("font-size", "9");
        initial.setAttribute("font-family", "IBM Plex Mono, monospace");
        initial.setAttribute("fill", "#0d1116");
        initial.setAttribute("font-weight", "700");
        initial.textContent = p.name.slice(0, 1).toUpperCase();
        layer.appendChild(initial);
      }
    });
  });

  Object.values(stationEls).forEach(({ dot }) => {
    dot.classList.remove("selectable");
    dot.setAttribute("r", dot.dataset.id && mapMeta.hubs.includes(Number(dot.dataset.id)) ? 7 : 5);
  });
}

function renderTickets(s) {
  const me = s.players[myId];
  const wrap = document.getElementById("ticket-buttons");
  wrap.innerHTML = "";
  const myTurn = s.currentPlayerId === myId && s.status === "playing";

  if (!me) return;

  const order = ["taxi", "bus", "underground", "black"];
  order.forEach(type => {
    if (!(type in me.tickets)) return;
    const btn = document.createElement("button");
    btn.className = `ticket-btn ${type}` + (selectedTicket === type ? " selected" : "");
    btn.textContent = `${type[0].toUpperCase() + type.slice(1)} (${me.tickets[type]})`;
    const hasMoves = myTurn && s.myValidMoves[type] && s.myValidMoves[type].length > 0;
    btn.disabled = !hasMoves;
    btn.addEventListener("click", () => {
      selectedTicket = selectedTicket === type ? null : type;
      renderTickets(s);
      highlightSelectable(s);
    });
    wrap.appendChild(btn);
  });

  const doubleBtn = document.getElementById("btn-double");
  doubleBtn.style.display = myTurn && s.canDouble ? "block" : "none";

  document.getElementById("move-hint").textContent = myTurn
    ? "Select a ticket, then tap a highlighted station."
    : "Waiting for the other players...";

  highlightSelectable(s);
}

function highlightSelectable(s) {
  Object.values(stationEls).forEach(({ dot }) => dot.classList.remove("selectable"));
  if (!selectedTicket || !s.myValidMoves[selectedTicket]) return;
  s.myValidMoves[selectedTicket].forEach(id => {
    const el = stationEls[id];
    if (el) el.dot.classList.add("selectable");
  });
}

function onStationClick(stationId) {
  if (!latestState || !selectedTicket) return;
  const valid = latestState.myValidMoves[selectedTicket] || [];
  if (!valid.includes(stationId)) return;
  socket.emit("request_move", { toStation: stationId, ticket: selectedTicket });
  selectedTicket = null;
}

document.getElementById("btn-double").addEventListener("click", () => {
  socket.emit("request_double");
});

function renderLog(s) {
  const events = document.getElementById("log-events");
  const wasScrolledDown = events.scrollHeight - events.scrollTop <= events.clientHeight + 40;
  events.innerHTML = "";
  s.mrXTicketLog.forEach(entry => {
    const div = document.createElement("div");
    div.className = "log-line";
    div.innerHTML = `<span class="r">R${entry.round}</span> Fugitive travelled by ${entry.ticket}.`;
    events.appendChild(div);
  });
  s.log.forEach(entry => {
    const div = document.createElement("div");
    div.className = "log-line";
    div.innerHTML = `<span class="r">R${entry.round}</span> ${entry.text}`;
    events.appendChild(div);
  });
  if (wasScrolledDown) events.scrollTop = events.scrollHeight;
}

// ===================== LOG TABS / CHAT =====================
document.querySelectorAll(".log-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".log-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".log-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(`log-${tab.dataset.tab}`).classList.add("active");
    document.getElementById("chat-input-row").style.display = tab.dataset.tab === "chat" ? "flex" : "none";
  });
});

function sendChat() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat_message", { text });
  input.value = "";
}
document.getElementById("btn-send-chat").addEventListener("click", sendChat);
document.getElementById("chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

socket.on("chat_message", ({ name, text }) => {
  const chat = document.getElementById("log-chat");
  const div = document.createElement("div");
  div.className = "chat-line";
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = name + ":";
  div.appendChild(who);
  div.appendChild(document.createTextNode(text));
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
});

// ===================== END SCREEN =====================
function renderEnd(s) {
  const won = (s.winner === "mrx" && s.players[myId] && s.players[myId].role === "mrx") ||
              (s.winner === "detectives" && s.players[myId] && s.players[myId].role === "detective");
  document.getElementById("end-tab").textContent = "CASE CLOSED";
  document.getElementById("end-title").textContent = s.winner === "mrx" ? "The Fugitive Escaped" : "The Fugitive Was Caught";
  document.getElementById("end-subtitle").textContent = won ? "Your side wins." : "Your side loses this time.";
  showScreen("end");
}

document.getElementById("btn-back-home").addEventListener("click", () => {
  forgetSession();
  location.reload();
});
