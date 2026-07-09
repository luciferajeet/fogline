# Fogline — a Scotland-Yard-style hidden movement game

Real-time online detective game for 3–6 players. One player is secretly the
Fugitive; everyone else are Detectives hunting them across an original city
map using Taxi, Bus, and Underground tickets. The Fugitive's location is only
revealed on rounds 3, 8, 13, 18, and 24 (24-round game).

This is an **original map and rule implementation inspired by the genre** —
not a copy of any published board's artwork or exact station layout.

## Run it locally (same WiFi / LAN party)

```bash
npm install
npm start
```

Then open `http://localhost:3000` — anyone on the same network can join at
`http://<your-computer's-LAN-IP>:3000`.

## Play with friends anywhere (deploy for free)

The easiest options are **Render** or **Railway** (both have free tiers):

### Render
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), create a new **Web Service**, point it
   at your repo.
3. Build command: `npm install`  ·  Start command: `npm start`
4. Deploy — you'll get a public URL you can share.

### Railway
1. Push this folder to a GitHub repo.
2. On [railway.app](https://railway.app), "New Project" → "Deploy from GitHub repo".
3. Railway auto-detects `npm start`. Deploy, then generate a public domain
   under Settings.

### Glitch / Fly.io / a spare VPS
Any host that can run a persistent Node process + WebSockets works — this
is a plain Express + Socket.io app, nothing exotic.

## How to play

1. One person clicks **"Start a new case"** and shares the 5-letter room
   code with friends.
2. Everyone else enters their name and joins with that code.
3. Once 3–6 players are in the room, the host clicks **"Begin the case"** —
   roles are assigned randomly and secretly (only the Fugitive knows they're
   the Fugitive).
4. On your turn, pick a ticket type, then click a highlighted station to
   move there.
5. Detectives' spent tickets are automatically added to the Fugitive's
   pool (as in the original game) — so watch what tickets get "used up."
6. The Fugitive's location appears briefly on the board on reveal rounds
   (3, 8, 13, 18, 24), then goes dark again.
7. Detectives win by landing exactly on the Fugitive's station. The
   Fugitive wins by surviving to round 24, or if all detectives run out
   of legal moves.

## Project structure

```
server.js         Express + Socket.io server, room/lobby management
game.js            Core game engine: moves, tickets, reveal rounds, win checks
map.json           Generated station map (stations + taxi/bus/underground edges)
generate-map.js    Script that generated map.json (re-run to get a new city layout)
public/
  index.html       App shell (home, lobby, game, end screens)
  style.css        Visual design
  client.js        Client logic + SVG board rendering
```

## Customizing the map

Run `npm run generate-map` to regenerate a fresh random city layout (change
the seed at the top of `generate-map.js` for a different result), or hand-edit
`map.json` directly — it's just a list of stations with `x`/`y` coordinates
and three edge lists (`taxi`, `bus`, `underground`).

## Notes / known limitations (v1)

- No reconnect-to-same-seat after a page refresh mid-game (disconnecting
  currently just marks you as disconnected in that game).
- No spectator mode.
- Room list lives in server memory — restarting the server clears all
  active games.

These would be natural next additions if you want to keep building on it.
