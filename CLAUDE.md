# Profile Course – race-profile course generator

A client-only static web app: upload a race GPX, pick a start point and radius, get a runnable
course nearby whose elevation profile matches the race. Full plan in `docs/build-plan.md` —
read it before starting a new phase.

## Architecture

- **Client-only** (HTML + TypeScript + Web Worker), no backend, no API keys. Hosted as static files.
- **UI layer** (main thread) talks to the **search worker** via typed `postMessage`
  (`src/shared/messages.ts`); never does heavy computation.
- **Map**: Leaflet with OSM raster tiles.
- **Data sources** (all free, CORS, no key): Overpass API (runnable ways + surface tags),
  Terrarium terrain tiles on AWS (elevation, decode `(R*256 + G + B/256) - 32768`),
  Open-Meteo elevation as fallback.
- **Cache**: IndexedDB (`idb-keyval`) for Overpass responses (rounded centre + radius) and DEM
  tiles (z/x/y).

## Data pipeline (per search, steps 2–4 cached)

1. Parse GPX → `TargetProfile { totalDistance, samples (25 m, relative to start), totalGain,
   totalLoss, gradientHistogram }`. 5-sample moving median before resampling.
2. Overpass query for runnable highways within radius (footway, path, track, cycleway,
   residential, living_street, unclassified, tertiary, service, pedestrian, steps, bridleway;
   exclude `access=private|no`, `foot=no`).
3. Build graph: nodes = shared OSM nodes + way endpoints; edges store length, geometry,
   surfaceClass (paved/gravel/trail/unknown), penalty, elevation every 25 m. Drop components
   not connected to the start, then prune dead-end subtrees (cul-de-sacs, driveways) — Leo
   explicitly wants no in-and-back-out detours. Surface mismatch uses a cost matrix where
   paved↔gravel ≈ 0.1 (near-equivalent for a runner) but paved↔trail = 1.0.
4. Sample elevation per edge from DEM tiles, bilinear, same median smoothing as GPX.
5. Snap start to nearest graph node within 100 m.

The radius is a **start/finish zone only** (Leo's decision): courses may go arbitrarily far
outside it. The network is fetched at `radius + targetLength/2` (capped 15 km); nodes inside
the user radius form a valid-end mask, and search states are Dijkstra-pruned when they can no
longer reach a valid end within the length budget.

## Matching algorithm

Score (lower = better) on 25 m samples:
`S = w_e·RMSE + w_g·gain/loss error + w_h·EMD(gradient histograms) + w_s·surfaceMismatch
+ w_p·penalties + w_r·repeatFraction`, weights `1.0 / 20 / 10 / 15 / 30 / 10` (debug-tunable).

Plus a confinement term: a course should reach at least 0.15 × its length away from its start
(a plain loop manages 0.32). Laps spaced more than the 1 km oscillation window apart are free to
the repeat term's eye and were invisible to the beam's partial rank entirely, which is how "the
circles in the cemetery" kept coming back — a dense patch of paths can fake any distance and any
profile. The beam now carries each state's reach from its own root and ranks on it, so laps lose
while they are being built rather than after scoring, when the whole beam already laps.

The corridor cells (~14 m, fine enough to keep opposite sidewalks distinct) also catch a lap that
comes back round on a *parallel* path — a twin bike/foot path, the next aisle of a cemetery.
Reuse within the 1 km oscillation window is a bounce or a tight circle; beyond it, it is a lap,
and counts as repeated ground. Without that, a course could re-climb the same hill for free and
manufacture the target's total gain instead of matching its features, which Leo wants always
discouraged.

The local-shape term is the RMS over 500 m windows of offset-corrected RMSE, not the worst
window. With a max, a course that had already ruined one stretch got every other stretch free,
so it could swap the race's one long climb for a sawtooth of small hills the whole way round and
pay only once — and the gradient histogram cannot object, because eight 4 % bumps and one 4 %
climb are the same distribution. Squaring still lets one awful window dominate a course that is
merely approximate throughout. Weight 9 (was 6, which the RMS aggregate would have softened by
about a quarter): Leo wants local similarity to outrank matching the totals, accepting that
where the terrain has no matching climb the course now under-delivers the race's gain rather
than faking it.

- Phase 2 baseline: 2 000 seeded random walks, keep best 20, local improvement.
- Phase 3: beam search over `(node, 100 m bucket)` states, B = 200/bucket, Dijkstra pruning on
  reachability, k-shortest-paths window replacement (300–1 500 m, k = 5, two passes).
- Deterministic via user-visible seed; "Try another" increments it.
- Budget: graph build ≤ 2 s, search ≤ 8 s on a mid-range phone (R = 5 km, 21 km target).
  If over: halve B, double bucket size.

The bottom sheet has four stops — collapsed, middle, full (≈55 % of the screen, the default) and
tall (nearly the whole screen). The box itself is up to 94 vh; a stop pushes the surplus below the
screen edge, and a spacer inside gives the hidden part room to scroll.

## Conventions

- Heavy loops use typed arrays and plain `for` loops; no per-step allocation in the beam search.
- Everything in `src/search/` and `src/graph/` must run in the worker (no DOM access).
- Every network call: cache read first, timeout, retry (Overpass has a mirror fallback).
- Finish a phase → run `npm test` and `npm run lint` → commit with the phase name → next phase.
- Test fixtures live in `test/fixtures/` (3 real GPX races; add saved Overpass JSON + a terrain
  tile in phase 1).
- Dev server: `npm run dev` (binds 0.0.0.0 for phone testing in Termux).

## Phase checklist

- [x] **Phase 0 – Scaffold**: Vite + TS strict + Vitest + ESLint + Prettier; Leaflet map, tap
      sets start marker, radius slider draws circle; worker wired with typed messages.
- [x] **Phase 1 – Data in**: GPX parser + profile builder (tests on the three fixtures),
      Overpass client + cache, graph builder, Terrarium fetcher/decoder/sampler, edge
      elevation, start snapping. Terrarium URL verified:
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`.
- [x] **Phase 2 – First courses**: scorer (6 terms + tests), random-walk baseline, result panel
      with overlaid profile chart, GPX export.
- [x] **Phase 3 – Beam search**: Dijkstra, beam search (per-node dedup for diversity,
      same-bucket queue for short edges, incremental gain/loss in the partial score),
      Yen's k-shortest-paths local improvement, baseline selectable in the debug panel.
      Perf on a real phone graph still to verify in phase 5 testing.
- [x] **Phase 4 – Surface & options**: surface presets (road/gravel/trail/any), safety
      penalties/bonuses from tags (sidewalk, maxspeed, cycleway, foot=designated, lit),
      return-to-start (Dijkstra-pruned), distance override, km range, seed/Try another,
      shareable URL hash.
- [ ] **Pre-built area graphs** (prioritised by Leo over Phase 5 — public Overpass servers
      proved unreliable even at 2 km): download/store an area once, search offline from it.
- [x] **Phase 5 (minus deploy)**: cancel button, offline-aware errors, PWA shell (manifest,
      icon, network-first/cache-first service worker, registered in prod builds only),
      gokartor.se layer switcher (`https://kartor.gokartor.se/Master/{z}/{y}/{x}.png` —
      note y/x order; usage terms not published, personal use). Deploy explicitly deferred
      by Leo.
- [x] **Via points**: must-pass markers (optional km each, adjustable ± window, pick-on-chart),
      enforced as a visit-order bitmask in the beam with reachability pruning; improve pass
      cannot remove a via. Resolution is point-to-segment, 25 m radius. The list orders itself by
      km (no km = last); editing one km re-sorts the list around that row, which is held still by
      scrolling the sheet to match.
- [x] **Comparison GPX**: upload an own course, map-matched (connectors on, skip-ahead over
      gaps), scored like a generated course, with an Improve button.
- [x] **Editing mode**: persistent — pull the course where you want it, or tap a point then its
      destination, repeatedly until Exit editing. Exit (✕) and Undo sit over the map. Each
      reroute replaces an adjustable window (default ±600 m) of the *current* course, so edits
      chain; the window start is chosen so the new point is reached near the km that was picked,
      and the end so the course keeps its length. Via points outrank edits: the window shrinks
      rather than route one away. Undo sets `resync` so the worker re-matches the restored course.
      While pulling, the grabbed point follows the finger with translucent straight legs to the
      two points the edit leaves in place (onthegomap-style); the course snaps to the routed
      result on release. A translucent box can also outline the window (off by default).
      **Node submode**
      ("Nodes" in the edit bar) treats course nodes as waypoints, ignoring the score entirely:
      every junction is drawn as a dot, a pull moves that node, a tap on a dot deletes it, a pull
      on the course *between* two dots adds a node on that leg (the rubber band hangs from the
      two dots either side), and a tap away from the course adds one on the leg whose geometry
      passes nearest the tap.
      Reconnection is by shortest path *excluding the old node*, so the course visibly stops
      going there (falling back to routing through it only when that is the sole connection); an
      out-and-back spur drops both legs. Nothing outside the two touched legs ever moves, and the
      start/finish cannot be moved or deleted this way. Distances along the course are cumulative
      haversine, never index × 25 m: each edge spreads its own samples, so the step is 25–50 m. Editing feedback also shows in a pill over the map, because
      the sheet may be collapsed.
- [x] **Multiple candidates**: a search offers up to 4 courses, each from a search of its own.
      Picking them out of one search's runners-up gave four near-copies leaving by the same
      street (on the test fixture the runners-up sit at 0.88–1.00 edge overlap with the winner),
      so every run after the first costs the previous courses' edges like unpleasant ground —
      a nudge, not a ban, since a park with one entrance still has to be enterable — and, when
      the start may be anywhere in the zone, drops start nodes within 300 m of one already used.
      A run whose winner still covers >0.8 of a course already offered is thrown away rather
      than shown as a false alternative. The runs are sequential, so tabs fill one at a time:
      an unfilled tab shows its own search's percentage and cannot be clicked, and `coursesDone`
      closes the ones nothing was found for. Run 0 is untouched by all this — it is the same
      search, improved from the same full candidate list, as before (picking before improving
      made the winner measurably worse, because improvement reorders the top candidates) — so
      the first course lands no later than it used to. Tabs sit in the sticky sheet top,
      labelled with the mismatch; unselected ones are quiet outlines against the app's solid
      blue so the selected one is obvious; 1–9 selects, and the arrows walk the strip once a
      tab has focus. Switching leaves editing mode and marks the
      worker's cached path stale, so the next edit or improve re-matches. An edit, undo or
      improve rewrites the shown tab in place; only the shown course is persisted or shared.
- [ ] **Phase 6 – Later** (Leo wants these, but last): Strava/Garmin course import, Strava
      personal heatmap, OSM GPS traces.
