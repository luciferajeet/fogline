const map = require("./map.json");

const REVEAL_ROUNDS = [3, 8, 13, 18, 24];
const MAX_ROUNDS = 24;
const DETECTIVE_COLORS = ["#3E7CB1", "#4C9A6B", "#C9974A", "#8E5FA2", "#C2555B"];

const MRX_TICKETS = { taxi: 4, bus: 3, underground: 3, black: 5, double: 2 };
const DETECTIVE_TICKETS = { taxi: 10, bus: 8, underground: 4 };

// Build adjacency: stationId -> ticketType -> Set(neighborIds)
const adjacency = {};
function addEdge(type, a, b) {
  adjacency[a] = adjacency[a] || {};
  adjacency[b] = adjacency[b] || {};
  adjacency[a][type] = adjacency[a][type] || new Set();
  adjacency[b][type] = adjacency[b][type] || new Set();
  adjacency[a][type].add(b);
  adjacency[b][type].add(a);
}
["taxi", "bus", "underground"].forEach(type => {
  map.edges[type].forEach(([a, b]) => addEdge(type, a, b));
});

function neighborsFor(stationId, ticketType) {
  const entry = adjacency[stationId];
  if (!entry) return [];
  if (ticketType === "black") {
    const all = new Set();
    ["taxi", "bus", "underground"].forEach(t => (entry[t] || new Set()).forEach(n => all.add(n)));
    return [...all];
  }
  return [...(entry[ticketType] || new Set())];
}

function randomStartingStations(count) {
  const ids = map.stations.map(s => s.id);
  const chosen = [];
  while (chosen.length < count) {
    const pick = ids[Math.floor(Math.random() * ids.length)];
    if (!chosen.includes(pick)) chosen.push(pick);
  }
  return chosen;
}

function createGame(roomId, players) {
  // players: [{id, name}] - first player is Mr X by convention set by caller
  const starts = randomStartingStations(players.length);
  const state = {
    roomId,
    status: "playing",
    round: 0,
    maxRounds: MAX_ROUNDS,
    revealRounds: REVEAL_ROUNDS,
    turnOrder: [],
    currentTurnIndex: 0,
    pendingDoubleMove: null, // {playerId, ticketsUsed: []}
    mrXLastRevealed: null, // last known public station for Mr X
    mrXTicketLog: [], // {round, ticket} shown to all, no location unless reveal round
    log: [],
    winner: null,
    players: {}
  };

  players.forEach((p, i) => {
    const isMrX = p.role === "mrx";
    state.players[p.id] = {
      id: p.id,
      name: p.name,
      role: p.role,
      color: isMrX ? "#8B2635" : DETECTIVE_COLORS[i % DETECTIVE_COLORS.length],
      position: starts[i],
      tickets: isMrX ? { ...MRX_TICKETS } : { ...DETECTIVE_TICKETS },
      connected: true
    };
  });

  state.turnOrder = [
    players.find(p => p.role === "mrx").id,
    ...players.filter(p => p.role !== "mrx").map(p => p.id)
  ];

  return state;
}

function currentPlayerId(state) {
  return state.turnOrder[state.currentTurnIndex];
}

function isMrXTurn(state) {
  return state.players[currentPlayerId(state)].role === "mrx";
}

function occupiedByDetective(state, stationId, excludePlayerId) {
  return Object.values(state.players).some(
    p => p.role === "detective" && p.id !== excludePlayerId && p.position === stationId
  );
}

function getValidMoves(state, playerId) {
  const player = state.players[playerId];
  if (!player) return {};
  const result = {};
  ["taxi", "bus", "underground"].forEach(type => {
    if (player.tickets[type] > 0) {
      const opts = neighborsFor(player.position, type).filter(
        n => !occupiedByDetective(state, n, playerId)
      );
      if (opts.length) result[type] = opts;
    }
  });
  if (player.role === "mrx" && player.tickets.black > 0) {
    const opts = neighborsFor(player.position, "black").filter(
      n => !occupiedByDetective(state, n, playerId)
    );
    if (opts.length) result.black = opts;
  }
  return result;
}

function canUseDoubleMove(state, playerId) {
  const player = state.players[playerId];
  return player.role === "mrx" && player.tickets.double > 0 && state.round < MAX_ROUNDS;
}

// Returns { ok, error } or { ok: true, event }
function applyMove(state, playerId, toStation, ticketType) {
  if (state.status !== "playing") return { ok: false, error: "Game is not active." };
  if (currentPlayerId(state) !== playerId) return { ok: false, error: "It's not your turn." };

  const player = state.players[playerId];
  const valid = getValidMoves(state, playerId);
  const options = valid[ticketType] || [];
  if (!options.includes(toStation)) return { ok: false, error: "That move isn't legal." };
  if (player.tickets[ticketType] <= 0) return { ok: false, error: "No tickets of that type." };

  const fromStation = player.position;
  player.tickets[ticketType] -= 1;
  player.position = toStation;

  // Detectives' spent tickets (except black/double, which they don't have) go to Mr X's pool
  if (player.role === "detective") {
    const mrx = Object.values(state.players).find(p => p.role === "mrx");
    if (mrx) mrx.tickets[ticketType] = (mrx.tickets[ticketType] || 0) + 1;
  }

  let captured = false;
  if (player.role === "detective") {
    const mrx = Object.values(state.players).find(p => p.role === "mrx");
    if (mrx && mrx.position === toStation) captured = true;
  }

  const event = { type: "move", playerId, role: player.role, fromStation, toStation, ticket: ticketType, round: state.round };

  if (player.role === "mrx") {
    state.mrXTicketLog.push({ round: state.round + 1, ticket: ticketType });
  }

  advanceTurn(state, player.role === "mrx");

  if (captured) {
    state.status = "ended";
    state.winner = "detectives";
    state.log.push({ text: `${player.name} captured Mr. X at station ${toStation}!`, round: state.round });
  }

  return { ok: true, event, captured };
}

function useDoubleMove(state, playerId) {
  if (currentPlayerId(state) !== playerId) return { ok: false, error: "It's not your turn." };
  if (!canUseDoubleMove(state, playerId)) return { ok: false, error: "Double move unavailable." };
  state.players[playerId].tickets.double -= 1;
  state.pendingDoubleMove = { playerId, movesLeft: 2 };
  return { ok: true };
}

function advanceTurn(state, wasMrX) {
  if (state.pendingDoubleMove && state.pendingDoubleMove.playerId === currentPlayerId(state)) {
    state.pendingDoubleMove.movesLeft -= 1;
    if (state.pendingDoubleMove.movesLeft > 0) {
      // Mr X moves again immediately, round still advances for reveal purposes
      state.round += 1;
      checkReveal(state);
      checkEnd(state);
      return;
    } else {
      state.pendingDoubleMove = null;
    }
  }

  if (wasMrX) {
    state.round += 1;
    checkReveal(state);
  }

  state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;

  // Skip detectives with zero tickets left entirely (they can't move)
  let loops = 0;
  while (
    state.players[currentPlayerId(state)].role === "detective" &&
    Object.values(getValidMoves(state, currentPlayerId(state))).every(arr => arr.length === 0) &&
    loops < state.turnOrder.length
  ) {
    state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
    loops++;
  }

  checkEnd(state);
}

function checkReveal(state) {
  if (state.revealRounds.includes(state.round)) {
    const mrx = Object.values(state.players).find(p => p.role === "mrx");
    state.mrXLastRevealed = mrx.position;
    state.log.push({ text: `Mr. X's location is revealed: station ${mrx.position}.`, round: state.round });
  }
}

function allDetectivesStuck(state) {
  return Object.values(state.players)
    .filter(p => p.role === "detective")
    .every(p => Object.values(getValidMoves(state, p.id)).every(arr => arr.length === 0));
}

function checkEnd(state) {
  if (state.status !== "playing") return;
  if (state.round >= MAX_ROUNDS && isMrXTurn(state) === false && currentPlayerId(state) === state.turnOrder[0]) {
    // full cycle completed past max rounds
  }
  if (state.round > MAX_ROUNDS) {
    state.status = "ended";
    state.winner = "mrx";
    state.log.push({ text: `Mr. X evaded capture for ${MAX_ROUNDS} rounds and wins!`, round: state.round });
    return;
  }
  if (allDetectivesStuck(state)) {
    state.status = "ended";
    state.winner = "mrx";
    state.log.push({ text: `All detectives are out of moves. Mr. X wins!`, round: state.round });
  }
}

// Build the state view sent to a specific player (hides Mr X's true position unless revealed/they are Mr X)
function viewFor(state, playerId) {
  const me = state.players[playerId];
  const players = {};
  Object.values(state.players).forEach(p => {
    if (p.role === "mrx" && me.role !== "mrx") {
      players[p.id] = {
        id: p.id,
        name: p.name,
        role: p.role,
        color: p.color,
        tickets: p.tickets,
        connected: p.connected,
        position: state.mrXLastRevealed // null until first reveal
      };
    } else {
      players[p.id] = p;
    }
  });
  return {
    roomId: state.roomId,
    status: state.status,
    round: state.round,
    maxRounds: state.maxRounds,
    revealRounds: state.revealRounds,
    turnOrder: state.turnOrder,
    currentTurnIndex: state.currentTurnIndex,
    currentPlayerId: state.turnOrder[state.currentTurnIndex],
    pendingDoubleMove: state.pendingDoubleMove,
    mrXTicketLog: state.mrXTicketLog,
    log: state.log,
    winner: state.winner,
    players,
    myValidMoves: state.status === "playing" ? getValidMoves(state, playerId) : {},
    canDouble: state.status === "playing" ? canUseDoubleMove(state, playerId) : false
  };
}

module.exports = {
  map,
  createGame,
  applyMove,
  useDoubleMove,
  getValidMoves,
  currentPlayerId,
  viewFor,
  MAX_ROUNDS,
  REVEAL_ROUNDS
};
