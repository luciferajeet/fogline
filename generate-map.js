// Generates an original hidden-movement city map: stations + taxi/bus/underground edges.
// Fixed seed so the map is stable across server restarts.

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260709);

const DISTRICT_NAMES = [
  "Ashcombe","Blackfriar's","Cinder Row","Draymoor","Elmstead","Foggmarsh","Greywick",
  "Halloway","Ivybrook","Juniper Yard","Kesterfield","Larkspur","Millbank End","Nettlewood",
  "Oxgate","Pemberly","Quillcross","Ravenscroft","Silverdock","Thornbury","Ulverston",
  "Vaultmoor","Wraithe Hill","Yewgate","Copperfield","Emberfall","Fenwick","Grimsby Yard",
  "Hollowmere","Inkwell","Kettlebrook","Lockhaven"
];

function name(i) {
  const base = DISTRICT_NAMES[i % DISTRICT_NAMES.length];
  const suffix = Math.floor(i / DISTRICT_NAMES.length);
  return suffix === 0 ? base : `${base} ${["II","III","IV","V"][suffix - 1] || suffix + 1}`;
}

const N = 84;
const WIDTH = 1000, HEIGHT = 760;
const RIVER_Y = HEIGHT * 0.56;

// Place stations: organic scatter with minimum spacing, avoiding a "river" band gap look
const stations = [];
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

let attempts = 0;
while (stations.length < N && attempts < 20000) {
  attempts++;
  const x = 40 + rand() * (WIDTH - 80);
  let y = 40 + rand() * (HEIGHT - 80);
  // gentle pull away from exact river line for visual breathing room, small chance to sit near bridges
  if (Math.abs(y - RIVER_Y) < 18 && rand() > 0.15) {
    y += (y < RIVER_Y ? -1 : 1) * (20 + rand() * 30);
  }
  const candidate = { x, y };
  const tooClose = stations.some(s => dist(s, candidate) < 58);
  if (!tooClose) stations.push(candidate);
}

stations.forEach((s, i) => {
  s.id = i + 1;
  s.name = name(i);
  s.side = s.y < RIVER_Y ? "north" : "south";
});

// --- TAXI edges: connect each station to its nearest few neighbors (dense local web) ---
function nearest(stationIdx, k, maxDist = 999999) {
  const s = stations[stationIdx];
  return stations
    .map((o, i) => ({ i, d: dist(s, o) }))
    .filter(o => o.i !== stationIdx && o.d <= maxDist)
    .sort((a, b) => a.d - b.d)
    .slice(0, k);
}

const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const taxiSet = new Set();
const taxiEdges = [];
stations.forEach((s, i) => {
  nearest(i, 4, 140).forEach(({ i: j }) => {
    const key = edgeKey(s.id, stations[j].id);
    if (!taxiSet.has(key)) {
      taxiSet.add(key);
      taxiEdges.push([s.id, stations[j].id]);
    }
  });
});

// Ensure connectivity: union-find, connect any isolated components via nearest cross-edge
function buildUF(n) {
  const parent = Array.from({ length: n + 1 }, (_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  return { find, union };
}
let uf = buildUF(N);
taxiEdges.forEach(([a, b]) => uf.union(a, b));
let roots = new Set(stations.map(s => uf.find(s.id)));
while (roots.size > 1) {
  const rootList = [...roots];
  const a = stations.find(s => uf.find(s.id) === rootList[0]);
  let best = null, bestD = Infinity;
  stations.forEach(s => {
    if (uf.find(s.id) !== rootList[0]) {
      const d = dist(a, s);
      if (d < bestD) { bestD = d; best = s; }
    }
  });
  taxiEdges.push([a.id, best.id]);
  taxiSet.add(edgeKey(a.id, best.id));
  uf.union(a.id, best.id);
  roots = new Set(stations.map(s => uf.find(s.id)));
}

// --- BUS edges: sparser, longer range, skip over taxi-only clusters ---
const busSet = new Set();
const busEdges = [];
stations.forEach((s, i) => {
  nearest(i, 2, 260).forEach(({ i: j, d }) => {
    if (d > 90) {
      const key = edgeKey(s.id, stations[j].id);
      if (!busSet.has(key) && rand() > 0.35) {
        busSet.add(key);
        busEdges.push([s.id, stations[j].id]);
      }
    }
  });
});

// --- UNDERGROUND: pick hub stations, connect them in a handful of "lines" for long jumps ---
const hubCount = 14;
const hubs = [];
const shuffled = [...stations].sort(() => rand() - 0.5);
for (const s of shuffled) {
  if (hubs.length >= hubCount) break;
  if (hubs.every(h => dist(h, s) > 130)) hubs.push(s);
}
const lineCount = 4;
const undergroundSet = new Set();
const undergroundEdges = [];
for (let l = 0; l < lineCount; l++) {
  const lineHubs = [...hubs].sort(() => rand() - 0.5).slice(0, 4 + Math.floor(rand() * 3));
  // order them by x to make a plausible "line" rather than a zigzag
  lineHubs.sort((a, b) => a.x - b.x);
  for (let i = 0; i < lineHubs.length - 1; i++) {
    const a = lineHubs[i], b = lineHubs[i + 1];
    const key = edgeKey(a.id, b.id);
    if (!undergroundSet.has(key)) {
      undergroundSet.add(key);
      undergroundEdges.push([a.id, b.id]);
    }
  }
}

const map = {
  width: WIDTH,
  height: HEIGHT,
  riverY: RIVER_Y,
  stations: stations.map(s => ({ id: s.id, name: s.name, x: Math.round(s.x), y: Math.round(s.y) })),
  hubs: hubs.map(h => h.id),
  edges: {
    taxi: taxiEdges,
    bus: busEdges,
    underground: undergroundEdges
  }
};

require("fs").writeFileSync(__dirname + "/map.json", JSON.stringify(map, null, 2));
console.log(`Generated ${stations.length} stations, ${taxiEdges.length} taxi, ${busEdges.length} bus, ${undergroundEdges.length} underground edges.`);
