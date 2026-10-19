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
4. Sample elevation per edge from DEM tiles, bilinear, **raw — no median smoothing**. The
   median belongs to GPX, where it removes barometric spikes; the DEM is already smooth. An
   edge is a street between two junctions, and most are 25–50 m, so a 5-wide window spanned
   the whole edge and flattened it to a single value — on the test graph that lost four fifths
   of the real relief (469 m of edge-local gain down to 83 m) and moved edge-end heights by 3 m
   on average, 56 m at worst, with a shared junction coming out at a different height depending
   on which edge was asked.
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
  B is a floor: start-anywhere subsamples the zone to at most 120 roots and widens the beam to
  16 states per root (capped at 10 × the asked-for effort), because one shared beam left each
  lineage barely a state and every start simply faked the profile in its own corner. That is
  why start-anywhere is the slow option, and it is labelled as such in the UI.
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
      chain. Both ends of the replaced stretch must lie *inside* the window, so the course either
      side of it keeps its exact shape and length; the stretch between them may well come out
      longer or shorter, which only shifts the km marks after it, and that is fine by Leo. The
      pair is chosen so the detour costs about what the stretch it replaces cost — a tighter pair
      spikes out to the point and straight back — with ties to the shorter stretch. The dragged
      point no longer has to be reached at the km that was picked, which was the old objective
      and is what let the splice wander outside the window. An edit is refused only when no node
      inside the window can reach the tapped point within the Dijkstra budget (4 × the window).
      The window is a **radius as well as a distance**: where the course laps, ground a long way
      round comes back within reach along the course, and replacing the stretch between two such
      nodes rewrote a whole lap nowhere near the drag. So the stretch runs out from the drag only
      until the course first leaves a `windowM` circle round it (the two nodes either side always
      count, since one edge can be longer than the radius). The drawn window and the rubber band
      follow the same rule, so the band never promises more than it keeps.
      Via points outrank edits: the window shrinks
      rather than route one away. **Every course carries its own path** — the edge indices it
      was built from, plus the recipe for the graph they index into (the four `ensurePrepared`
      arguments and the edge/node counts as a fingerprint). An edit sends that back, and the
      worker rebuilds the graph if it is not the one in hand; a graph is deterministic given the
      network response, which is cached in IndexedDB, so the rebuild costs no network.
      Map-matching a course we generated ourselves back to the graph is lossy — it rewrites the
      course wherever the match prefers another way through, anywhere at all, which is what used
      to change the course far outside the edit window after a tab switch or an undo. It was
      first fixed with a worker-side cache under an id the course carried, but an id dies with
      the worker, so after a reload every restored course fell back to matching and the match
      threw ("could not follow the course near km 20.2") — the whole tab strip became
      uneditable. Matching is now the fallback only: geometry we never produced (an uploaded
      course), or a rebuild that is unavailable (offline, Overpass down — then whatever graph is
      in hand is matched against rather than refusing) or that comes out a different size,
      meaning OSM has changed under the course.
      While pulling, the grabbed point follows the finger with translucent straight legs to the
      two points the edit leaves in place (onthegomap-style); the course snaps to the routed
      result on release. A translucent box can also outline the window (off by default).
      The **wheel while the point is still held** resizes that window, ×1.25 a notch away from
      the user and ×0.8 towards, rounded to 50 m and clamped to the panel's 100–3000 m. The box
      is shown for the length of the gesture whether or not the checkbox is on, the rubber
      band's two ends move with it, and the new size is said in the pill over the point — so the
      reach is judged against the map rather than guessed from a number in the panel. The map's
      own wheel zoom is switched off for the length of a pull, since the gesture owns the wheel.
      Node edits have no window (they reach to the two neighbouring junctions and no further),
      so the submode leaves the wheel to the map.
      **Picking which pass.** A tap resolves to a course point by pixels alone, so the two passes
      of a stretch the course covers twice used to collapse to whichever was a hair nearer, and
      one of them was simply unreachable. Two ways in now, both keeping the plain tap and pull
      untouched: *holding* a point where the course passes more than once offers each pass in
      turn every 2 s, with the km and "pass n of m" in a pill *above the point itself* (the eye
      is on the point, not on the status bar at the side) and a short vibration on
      each switch, and the drag or release then means the pass last offered — crossing the drag
      threshold stops the cycling, so a pull is never stolen by a switch mid-gesture. Passes are
      told apart by index gap among the grab points (≥ 8 apart is a second pass, closer is one
      pass, a hairpin included), because the map layer knows pixels, not distances. Second way:
      scrubbing the profile chart and *letting go* picks that distance as the edit's origin, the
      same commit-on-release as a via marker, and the map is then armed for the destination tap.
      The chart's samples sit at exactly 25 m while the export points sit at 25–50 m, so the
      marker is found by cumulative distance, never by the same index. Holding a *multi-pass* dot
      in node submode therefore cycles instead of marking, which means such a dot cannot join a
      batch delete — known gap, deliberate.
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
      haversine, never index × 25 m: each edge spreads its own samples, so the step is 25–50 m.
      *Holding* a dot marks it red instead of pulling it and reveals a Delete button; several can
      be marked, and they go in one edit, because deleting them one at a time would route each
      reconnection through the next node about to go. Neighbouring marked nodes are bypassed as
      one run, by a single shortest path excluding all of them, and every run's way round avoids
      every marked node, not just its own — otherwise a node the user marked came back on the
      course by the side door, as another run's detour. On a tight network that can leave no way
      round at all, and then the batch is refused rather than half done. Tapping a marked dot releases it;
      Esc backs out exactly one step, innermost first: a pull in progress or a half-finished
      two-tap edit (dropped with the course untouched, still in editing mode), then the marks,
      then node submode, then editing itself. Editing feedback also shows in a
      pill over the map, because the sheet may be collapsed — and on desktop that pill, the edit
      bar and the via bar all start beside the left panel, not over it.
      **A refused edit says why**, in the pill *after* the re-arm — the re-arm would otherwise
      talk over the reason with its own invitation, which left every refusal looking like
      nothing had happened at all. If the worker no longer held the course's path and had to
      match it back to the network to edit it, the refusal says that too: a lossy match is a
      likelier reason for it than the window being too tight.
      A pull also used to take the page's text with it. Leaflet exempts only tiles and marker
      icons from selection, so a pull could mark the tooltips, the controls and on into the
      panel, and the next press then dragged the selection instead of the course (and a native
      drag cancels the pointer, so the edit was dropped). The map is now `user-select: none`,
      and taking a pull clears the selection and preventDefaults the press. A via marker under
      the press keeps its own drag.
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
      the first course lands no later than it used to. The tabs are a strip of browser tabs dropping
      from the top of the window over the map, labelled with the mismatch: the shown one is
      accent filled, hangs lower and overlaps the tabs either side of it with a drop shadow, a
      course that has arrived but is not shown sits shorter and greyer as if
      behind it, and one still being searched for spins a ring beside its percentage — so the
      strip says what is ready without being read. The strip itself is `pointer-events: none`
      so the map stays usable between tabs, and it publishes its height as `--tab-strip-h`,
      which pushes the edit/via bars and the status pill down. 1–9 selects, and the arrows walk the strip
      once a tab has focus. Switching leaves editing mode; every tab carries its own path, so an
      edit lands on the course on screen. An edit, undo or improve rewrites the shown
      tab in place. The whole strip survives a reload (every course is persisted, with which one
      was shown); only the shown course goes into the URL hash. A restored strip whose courses
      predate them carrying their own path is dropped on load — such a course can only be
      map-matched to be edited, and a tab that cannot be edited is not worth keeping. The GPX and
      the settings stay, so it is one Search away.
- [x] **Hover readout** (onthegomap-style): with the mouse within 18 px of the course, a
      translucent point follows it along the line with a pill above reading distance, height
      above sea level and gradient. It tracks the nearest *leg* and interpolates along it, not
      the nearest point — export points are 25–50 m apart and a readout that hops between them
      does not read as following the course. The gradient is taken over ±50 m for the same
      reason the course is: one step of a ~30 m DEM grid is as much noise as slope. Mouse only
      (a finger has no hover, and on touch the course is for pulling), suppressed while a point
      is being pulled, and on its own marker and tooltip so it never clobbers the editing ones.
      **The two hovers answer each other**: the chart has always marked the map, and the map now
      moves the chart's crosshair too, so a hill can be found from either side. The crosshair a
      map hover puts up is not a scrub — it sets no pick — or letting go over the chart
      afterwards would commit a distance the user never chose while editing.
- [ ] **Phase 6 – Strava, Garmin, GPS traces** (all opt-in; nothing is fetched until switched on):
      - [x] Public **GPS traces** from OSM (`gps.tile.openstreetmap.org/lines/{z}/{x}/{y}.png`) as
        a translucent overlay, under Advanced settings — where people actually run, which the
        OSM network alone does not say.
      - [x] A **Strava & Garmin** section: course/route import (both export GPX, so it is the
        same map-match-and-score path as "compare your own course"), and a personal **Strava
        heatmap** overlay. Strava's heatmap tiles are CloudFront-signed for one logged-in
        account, so the URL template has to be pasted from the user's own browser; it lives in
        the session on that device and expires. Strava's *API* is out of reach: the token
        exchange needs a client secret, and a client-only app has nowhere to keep one.
      - [ ] Course import straight from the services (needs the above resolved).

Panel sections (Offline areas, Strava & Garmin, Advanced settings) are `details.section`: a
full-width 44 px row with a chevron, not the small grey hint text they used to be, which read as
fine print and left only the words themselves tappable.
