# Limit State — Solver and Product Specification

The normative specification for this repository: the architecture boundaries, the finite-element
solver maths, the data model and sharing format, the UI contract, the presets, the worker
protocol, the honesty gates, the decision log, the verified constants, and the numbered feature
requirements.

**This document is authoritative.** Source comments cite it by section number; when implementation
and specification disagree, bring them back into agreement and record intentional contract changes
here.

Scope note: this is a **teaching** structural tool. It states its own honesty ceilings — true
aeroelastic flutter, warping torsion, and member-level lateral-torsional buckling are out of
scope and must stay labelled as such. Never fake a result the product cannot truthfully claim.

---

## 3. Architecture

**Stack:** Next.js 16 (App Router, `output: 'export'` — fully static) + React 19 + TypeScript (strict) + Zustand. Rendering: single Canvas2D layer for the structure (devicePixelRatio-aware), React/CSS for chrome. Eigen solves in a Web Worker (`new Worker(new URL('./eigen.worker.ts', import.meta.url))` — bundled natively by Next); statics and Newmark stepping on the main thread (they're back-substitutions — see budgets). Tests: Vitest (standalone `vitest.config.ts`; independent of Next's bundler). Lint: oxlint. Deploy configurations target GitHub Pages and GitLab Pages (`.github/workflows/ci.yml`, `.gitlab-ci.yml`). **Zero runtime numerics dependencies** — the solver is hand-rolled on `Float64Array`, keeping the numerical core auditable.

Next.js notes (see §12): SSR is intentionally unused; every interactive surface is a `'use client'` component and the app exports to plain static files in `out/`. Subpath hosting uses the `BASE_PATH` env var (set per pipeline; empty for custom domains) since static export has no relative-base mode. `next build` type-checks the whole project (tsconfig `include` covers `fem/` and tests), so CI order is build → test. The fem/ kernel and its tests are bundler-agnostic — the framework can change again without touching them.

Why not SVG/WebGL: SVG per-frame attribute churn is the wrong tool at hundreds of members; WebGL is over-tooled for line art. Why no node-graph lib: a structural editor's semantics (grid snap, supports, member splitting) share nothing with dataflow canvases.

**Module map** (`src/`):

```
app/            Next.js shell (layout, page; interactive surfaces are client components)
fem/            pure, DOM-free, deterministic — the truth kernel
  types.ts      model + result types (single source of truth)
  materials.ts  material & section presets, derived A, I, c
  mesh.ts       member → 2 sub-elements, dof numbering, model validation
  assemble.ts   element k, kg, m (local), transforms, global assembly, load vectors
  solve.ts      dense LDLᵀ factor/solve, SPD failure → mechanism detection
  eigen.ts      subspace iteration (modal & buckling), Jacobi for Ritz problems
  dynamics.ts   Newmark-β, Rayleigh damping, modal projection, DAF, resonance detect
  failure.ts    criteria evaluation, collapse cascade, mechanism report
  deck.ts       contiguous deck path → analysis elements (traffic + influence)
  influence.ts  unit-load influence lines + two-axle envelope from η (Phase 2D)
  cables.ts     tension-only slack iteration (Phase 2E)
  pushover.ts   plastic hinge event-to-event pushover (Phase 2F)
  moving-mass.ts vehicle mass lumping for optional dynamic traffic (Phase 2H)
  second-order.ts P-Δ iteration (Phase 2B)
  spectrum.ts   SDOF response spectrum (Phase 2C)
  records.ts    earthquake ground-motion records (Phase 2C)
  space/        Phase 3 3D space-frame kernel (types, assemble, mesh, statics)
state/          zustand store, undo/redo (snapshot stack), analysis orchestration
canvas/         rendering + hit-testing + tools (draw/select/support/load)
stories/        traffic, wind, ramp, earthquake, pushover controllers
share/          JSON schema v1, URL hash serialize (deflate via CompressionStream)
ui/             panels, inspector, failure banner, why-panel, presets menu
workers/        eigen.worker.ts (comlink-free, hand-rolled postMessage protocol)
presets/        scene files (data only; includes guyed-mast + portal-pushover)
challenges/     constrained-budget challenge catalog + pure evaluator (Phase 2G)
gallery/        curated gallery sources; hashes frozen in public/gallery.json (Phase 2G)
```

**Data flow:** editor mutations → model snapshot in store → `mesh.ts` produces `AnalysisMesh` (cached by model hash) → analyses read the mesh, never the editor model → results flow to canvas/panels as immutable objects. The fem/ package must run under Node (Vitest) with no DOM import — enforced by tests running in `environment: 'node'`.

**Determinism:** all randomness (gusts, preset noise) through seeded mulberry32; seed lives in the share URL. Same URL ⇒ same playback.

```ts
export function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

**Performance budgets** (M1-class laptop): static re-solve (factored) < 1 ms at 300 elements; full refactor < 5 ms; 8-mode eigen < 150 ms in worker; Newmark 60 fps with 4 substeps/frame at 900 DOF; editor caps at 200 members (~400 elements, ~1200 DOF) with a soft warning at 120.

---

## 4. Solver spec (the math)

Everything here was numerically validated against closed forms before this doc was written; the tolerances in §9 are measured, not hoped.

### 4.1 Element matrices

2-node Euler–Bernoulli plane-frame element, local DOFs `[u1, v1, θ1, u2, v2, θ2]`, x along the member. E young's modulus, A area, I second moment, L length, ρ density. Sign conventions: tension-positive axial force N; counterclockwise-positive rotations and moments.

Local stiffness `k` (symmetric):

```
      [  EA/L      0         0      -EA/L      0         0     ]
      [   0     12EI/L³   6EI/L²      0    -12EI/L³   6EI/L²   ]
k =   [   0      6EI/L²   4EI/L       0     -6EI/L²   2EI/L    ]
      [ -EA/L      0         0       EA/L      0         0     ]
      [   0    -12EI/L³  -6EI/L²      0     12EI/L³  -6EI/L²   ]
      [   0      6EI/L²   2EI/L       0     -6EI/L²   4EI/L    ]
```

Consistent geometric stiffness `k_g` (function of current axial force N; only the `[v1,θ1,v2,θ2]` block is nonzero):

```
k_g = (N/L) ·  [  6/5     L/10    -6/5     L/10   ]
               [  L/10   2L²/15  -L/10   -L²/30   ]
               [ -6/5    -L/10    6/5    -L/10    ]
               [  L/10   -L²/30  -L/10   2L²/15   ]
```

Compression (N < 0) reduces effective stiffness — that is buckling's engine.

Consistent mass `m`: axial block `(ρAL/6)·[[2,1],[1,2]]` on `[u1,u2]`; bending block `(ρAL/420)` times:

```
[ 156    22L    54    -13L  ]
[ 22L    4L²    13L   -3L²  ]
[ 54     13L    156   -22L  ]
[ -13L   -3L²   -22L   4L²  ]
```

on `[v1,θ1,v2,θ2]`. Lumped node masses (from deck/vehicle) add to translational diagonal entries only.

**Timoshenko option (Phase 2A).** Analysis toggle `shearFlexible` replaces the Euler–Bernoulli bending block with the standard shear-flexible form. Shear factor φ = 12EI/(G A_s L²); φ → 0 recovers §4.1 above. With φ:

```
k_bend = EI / (L³(1+φ)) ·
  [  12      6L      -12      6L     ]
  [  6L   (4+φ)L²   -6L   (2-φ)L² ]
  [ -12     -6L       12     -6L    ]
  [  6L   (2-φ)L²   -6L   (4+φ)L² ]
```

Per-material G (isotropic G = E/(2(1+ν)) for steel/alu/spaghetti; timber softwood G ≈ E/16). Per-section shear area A_s: rect κA with κ = 5/6; I-beam and box = web area only; tube = 0.5 A. Cantilever tip under tip load P = PL³/3EI + PL/(G A_s) (gate G14). UI shows a stocky-member note when any member has L/h < 10.

**Transformation.** With member angle α, c = cos α, s = sin α, per-node block `R = [[c,s,0],[−s,c,0],[0,0,1]]`, T = blockdiag(R,R): `K_e^global = Tᵀ k T` (same for k_g, m). Element end forces in local axes: `f_local = k·(T·u_e) − f_fixedEnd`.

**End releases** (truss members, plastic hinges): release a rotational DOF by static condensation of the local 6×6 before transformation. For released set r and kept set k: `k_cond = k_kk − k_kr · k_rr⁻¹ · k_rk` (and condense fixed-end loads the same way: `f_cond = f_k − k_kr k_rr⁻¹ f_r`). Truss member = both ends released. This one mechanism serves both trusses and the cascade's hinge insertion (§4.7).

### 4.2 Loads

- **Nodal:** direct entries in F.
- **Member UDL** w (local −y, e.g., self-weight projected): fixed-end vector `[0, wL/2, wL²/12, 0, wL/2, −wL²/12]` (equilibrating nodal loads = negative of fixed-end forces; keep one convention in code and test it against the SS-beam gate).
- **Self-weight:** every member gets UDL `ρ·A·g` resolved into local components (axial component `ρAg·s`, transverse `ρAg·c`); axial distributed load lumps `pL/2` to each node.
- **Point load P at position ξ = a/L inside an element** (traffic): consistent nodal vector via Hermite shape functions —
  `N_v = [1−3ξ²+2ξ³, L(ξ−2ξ²+ξ³), 3ξ²−2ξ³, L(−ξ²+ξ³)]`, so `f = P·N_v` mapped onto `[v1,θ1,v2,θ2]`. This is what makes the truck glide smoothly instead of stair-stepping node to node.

### 4.3 Assembly and static solve

Global K as dense `Float64Array(n·n)`, n = 3·nodes of the analysis mesh. DOF numbering: node i → `[3i, 3i+1, 3i+2]`. Constraints by free-DOF index list (no penalty method — clean mechanism detection matters more than convenience). Factor `K_ff = L·D·Lᵀ` (LDLᵀ, no pivoting).

**Mechanism detection:** during factorization, if any `D_ii ≤ εₘ · max_j(K_jj)` with εₘ = 1e−10, abort and report `mechanism` with the offending DOF (maps back to a node — "this node can move freely; add a support or member"). This is failure taxonomy class (a), and it's also the editor's live stability lint.

Factor is cached; traffic re-solves are one forward/back substitution per frame. Refactor only on model/mesh change.

Conditioning note: SI units throughout (N, m, kg, Pa) with E ~ 2e11 keeps K entries within float64 comfort; no scaling needed at our sizes. Display units: kN, m, Hz, tonnes.

### 4.4 Meshing

Every drawn frame member is subdivided into **2 analysis elements** (mid-node). A member released at both ends is represented by one exact axial truss element: splitting it would create an artificial collinear mid-node with an unrestrained transverse DOF. Measured accuracy at 2 frame subdivisions: Euler buckling +0.75%, first modal frequency +0.39% (both converge from above; 4 subdivisions gives +0.05%/+0.03%). 2 is the right default — errors are invisible at UI precision and DOF count stays low. `mesh.ts` owns the member→elements map; results aggregate back to members by max over sub-elements. Do not expose meshing in the UI.

### 4.5 Eigenanalysis

Both problems reduce to a generalized symmetric eigenproblem solved by **subspace iteration** (Bathe's method) using the existing LDLᵀ solve, with a Jacobi eigensolver on the small Ritz block. Extract k = 8 modes with subspace size p = 14; converge when all wanted eigenvalues change < 1e−8 relative between iterations (typically < 10 iterations).

**Modal:** `K φ = ω² M φ`. Subspace iteration on (K, M): iterate `K X̄ = M X`, Ritz-project `K* = X̄ᵀK X̄`, `M* = X̄ᵀM X̄`, solve the p×p problem by Jacobi with Cholesky reduction (`M* = LLᵀ`, eig of `L⁻¹K*L⁻ᵀ`), rotate, M-orthonormalize. Output: `ω_i` (rad/s), `f_i = ω_i/2π`, mass-normalized shapes (`φᵀMφ = 1`).

**Buckling:** run statics under the story's reference load → member axial forces N_e → assemble K_g(N_ref). Solve `K φ = μ (−K_g) φ` by the same machinery (K is SPD post-constraints; −K_g may be indefinite — that's fine, it sits on the right side). Then **λ_cr = 1/μ_max over μ > 0**; the buckling mode is φ of μ_max. If no μ > 0, report "no buckling under this load direction" (all-tension structures). Belt-and-braces: also compute per-member Euler check `|N_e| vs π²EI/L_member²` (pinned-pinned effective length — conservative; label it "member check" in the why-panel and report whichever governs).

### 4.6 Dynamics

**Newmark-β**, average acceleration (γ = 1/2, β = 1/4, unconditionally stable). With Δt, constants `a0 = 1/(βΔt²)`, `a1 = γ/(βΔt)`, `a2 = 1/(βΔt)`, `a3 = 1/(2β)−1`, `a4 = γ/β−1`, `a5 = Δt(γ/(2β)−1)`:

```
K̂ = K + a0·M + a1·C                      (factor once per story config)
F̂ₜ₊₁ = Fₜ₊₁ + M(a0·uₜ + a2·u̇ₜ + a3·üₜ) + C(a1·uₜ + a4·u̇ₜ + a5·üₜ)
uₜ₊₁ = K̂⁻¹F̂ₜ₊₁
üₜ₊₁ = a0(uₜ₊₁−uₜ) − a2·u̇ₜ − a3·üₜ ;  u̇ₜ₊₁ = u̇ₜ + Δt((1−γ)üₜ + γ·üₜ₊₁)
```

Δt = 1/240 s (4 substeps per 60 fps frame); if f₈ > 40 Hz, that's fine — Newmark stays stable, high modes just go inaccurate and we don't display them.

**Rayleigh damping** `C = a·M + b·K` fit to damping ratio ζ at ω₁ and ω₂ (first two modal frequencies): `a = 2ζω₁ω₂/(ω₁+ω₂)`, `b = 2ζ/(ω₁+ω₂)`. Default ζ = 2% (steel); user slider 0.5–10% in the wind story — watching damping kill a resonance is core pedagogy.

**Modal projection for the explainer layer:** `q_i(t) = φ_iᵀ M u(t)` (mass-normalized). Displayed per-mode bars show where the energy is. **DAF meter:** current dynamic amplitude of the dominant modal coordinate ÷ static response to the same load amplitude.

**Resonance detection:** trigger when (i) forcing frequency within ±10% of some f_i, (ii) envelope of q_i grows by >1.5× over the last 5 forcing cycles, (iii) ζ < 5%. Report class (d): "Resonance with mode i (f_i Hz)". If max combined stress crosses f_y during resonance, the banner reads "Resonance → yield at member m" (mechanism is resonance; consequence is yield).

### 4.7 Failure engine

Evaluated per story tick (statics) or per second (dynamics):

- **(a) Mechanism** — LDLᵀ pivot failure (§4.3). Message names the free node.
- **(b) Yield** — utilization `U_m = max over sub-elements, both ends, both fibers of |N/A ± M·c/I| / f_y`. In-span moment max: for elements with UDL, check the interior extremum `x* = L·V₁/(V₁−V₂)` when V changes sign. U ≥ 1 ⇒ yield at the governing section.
- **(c) Buckling** — story load factor ≥ λ_cr from §4.5 (global), or member Euler check (local); report whichever governs with both numbers.
- **(d) Resonance** — §4.6 detector.

**Load-ramp story:** because statics is linear, capacity is exact without search: `λ_yield = 1/max_m U_m` (at unit story load), λ_buckle = λ_cr. Governing factor = min; the ramp animates load factor 0 → min and fires the failure at the exact value. No bisection, no fake suspense — linearity is the feature.

**Collapse cascade (quasi-static, deterministic):**

```
repeat up to 20 steps:
  solve statics at current load
  offenders = members with U ≥ 1 or member-buckling exceeded
  if none: stable — stop
  worst = max by (U or N/N_cr)
  if buckling, or axial stress ≥ 80% of combined:  remove member
  else (bending yield):                            insert hinge (end release) at max-|M| end
  re-mesh, re-factor; if mechanism → COLLAPSE, stop
```

Each step is a timeline entry: "① Member 7 buckled → ② load redistributed, member 8 at 1.4× yield → ③ hinge at member 8 → ④ mechanism — collapse." Honesty label in the UI: "quasi-static sequence — inertia not modeled." The post-onset visual animates the computed mode/mechanism shape with growing amplitude and a persistent "illustrative animation ×N" badge. Onset values are exact; the cinematic is staging.

### 4.8 Materials & sections (presets, `materials.ts`)

| Material                   | E (GPa) | G (GPa)         | f_y (MPa) | ρ (kg/m³) |
| -------------------------- | ------- | --------------- | --------- | --------- |
| Steel S355                 | 200     | 76.923 (ν=0.3)  | 355       | 7850      |
| Aluminum 6061-T6           | 69      | 25.940 (ν=0.33) | 276       | 2700      |
| Timber (softwood, ∥ grain) | 11      | 0.688 (≈E/16)   | 40        | 500       |
| Spaghetti (dry)            | 3.8     | 1.462 (ν=0.3)   | 20        | 1500      |

Spaghetti is deliberate: the classroom spaghetti-bridge tradition, with honest numbers. Sections: solid rect (b,h), box (b,h,t), I-beam (b,h,t_f,t_w), tube (d,t) — A, I≡I_z, I_y, c, A_s, J derived in code and unit-tested against hand calcs. Default: steel box 200×200×8 mm.

**Section inertia for 3D (Phase 3):** local y is the section "width" axis, local z the "depth" axis matching 2D's in-plane bending. So `I` (2D) ≡ `I_z = b h³/12` (rect); `I_y = h b³/12`. St. Venant torsion `J`: solid rect series approx; thin tube `J = 2I`; thin closed box `J = 4 A_m² / ∮ ds/t`; I-beam open-section approx (flanges + web). Warping torsion is out of scope and is labelled as such in the 3D results.

### 4.9 Space-frame element

2-node Euler–Bernoulli space frame, 12 local DOFs
`[u1, v1, w1, θx1, θy1, θz1, u2, v2, w2, θx2, θy2, θz2]`.
Local x along the member (node 1 → 2); y, z principal section axes (right-handed triad). Sign conventions: tension-positive axial; right-hand positive rotations. St. Venant torsion only (no warping DOF).

**Local stiffness** (symmetric) is the superposition of four decoupled contributions:

- Axial on `[u1, u2]`: `(EA/L)·[[1,−1],[−1,1]]`
- Torsion on `[θx1, θx2]`: `(GJ/L)·[[1,−1],[−1,1]]`
- Bending about z (plane xy) on `[v1, θz1, v2, θz2]` — identical to the §4.1 bending block with `I → I_z`
- Bending about y (plane xz) on `[w1, θy1, w2, θy2]` — same magnitudes with right-hand sign flip on the `6EI/L²` couplings:

```
k_y = EI_y / L³ ·
  [  12    -6L    -12    -6L  ]
  [ -6L   4L²     6L    2L²  ]
  [ -12    6L     12     6L  ]
  [ -6L   2L²     6L    4L²  ]
```

**Transformation.** Member direction `e_x = (x_b − x_a)/L`. Complete a right-handed triad `(e_x, e_y, e_z)` from a reference vector (prefer global Z; fall back to global Y when `|e_x·Z| > 0.9`) then optional roll angle ψ about `e_x`. Rows of `R` (3×3) are the local basis in global coords. `T = blockdiag(R,R,R,R)` (four identical 3×3 blocks for the two translation + two rotation triples). `K_e^global = Tᵀ k T`.

**DOF numbering:** node i → `[6i … 6i+5]` = `[ux, uy, uz, θx, θy, θz]`. Global K is skyline/profile (`src/fem/skyline.ts`); free-DOF LDLᵀ uses RCM-ordered profile extract. Dense `Float64Array` retained for eigen bridge (`assembleK3dDense`).

**Supports (3D):** pin restrains `ux,uy,uz`; roller restrains the supported translation(s) only; fixed restrains all six. End releases condense any of `{θx, θy, θz}` at either end via the same static condensation as §4.1.

**Meshing:** same §4.4 rule — 2 analysis elements per frame member; both-ends-released (truss/cable) stays one axial bar (no mid-node).

**2D regression bridge:** a planar model in the global XY plane with all `uz, θx, θy` constrained must reproduce the 2D solver to 1e−9 relative (gate G23).

**Geometric stiffness / consistent mass (12×12):** Cook ch. 9 analogues — axial geometric terms on both bending planes plus the torsional spin terms; mass = axial + torsional rotary + two Hermite bending blocks. Implemented with the buckling/modal 3D gates; statics gates do not depend on them.

**Closed forms used by gates:** cantilever tip P along local y → `v = PL³/3EI_z`, `θz = PL²/2EI_z`; along local z → `w = PL³/3EI_y`, `θy = −PL²/2EI_y` (sign from k_y); tip torque T → `θx = TL/GJ`.

---

## 5. Data model & sharing

`fem/types.ts` is the single source of truth (already scaffolded). Serialization schema v1 (JSON):

```json
{
  "v": 1,
  "name": "Pratt truss",
  "seed": 42,
  "nodes": [{ "id": 1, "x": 0, "y": 0 }],
  "members": [
    {
      "id": 1,
      "a": 1,
      "b": 2,
      "material": "steel-s355",
      "section": { "kind": "box", "b": 0.2, "h": 0.2, "t": 0.008 },
      "releaseA": false,
      "releaseB": false
    }
  ],
  "supports": [{ "node": 1, "kind": "pin" }],
  "loads": { "gravity": true, "points": [{ "node": 4, "fx": 0, "fy": -10000 }] },
  "deck": [1, 2, 3],
  "story": { "kind": "traffic", "weightkN": 300, "speed": 12 }
}
```

URL sharing: `#m=<base64url(deflate-raw(json))>` via `CompressionStream('deflate-raw')`; fallback to uncompressed base64url with prefix `#mu=` where CompressionStream is unavailable. Round-trip property test required (§9). IDs are stable ints; never reindex on delete.

---

## 6. UI spec

### 6.1 Layout

Top bar: logo, model name (editable), Build/Test mode switch, share button, presets menu. Left rail (Build): tool palette — select, node, member, support, load, deck-paint, delete. Right panel: context inspector. Bottom (Test): story transport (play/pause/scrub) + story dials. Canvas center, always.

### 6.2 Build mode

- Grid 0.5 m snap (toggleable), ground line at y = 0; nodes on ground offer support glyphs (cycle pin → roller → fixed).
- Member tool: click-drag node to node; drawing through an existing node splits naturally (members reference node ids).
- Inspector: node (position, support), member (material, section, releases, computed mass), multi-select for bulk section assignment.
- Deck-paint: click members to mark the traffic path (must be contiguous; validated with a friendly error).
- Live stability lint: mechanism check runs on idle (debounced 300 ms); unstable models tint the affected node amber before the user ever hits Test.
- Undo/redo: snapshot stack, cap 100 (models are tiny; snapshots beat command inverses on simplicity).
- Keyboard: `V` select, `N` node, `M` member, `S` support, `L` load, `D` deck, `⌫` delete, `⌘Z/⇧⌘Z`, `space` play/pause in Test.

### 6.3 Test mode — three stories

**Traffic:** two axles, W/2 each, 4 m spacing, weight 10–500 kN, speed 5–30 m/s, auto-run or scrub. Per frame: position → per-element Hermite load vectors → back-substitution → results. Envelope toggle accumulates max |M| per member and shades it. Optional **Moving mass** (§14 2H): Newmark with vehicle mass lumped at axle contacts and M rebuilt each step — the honest dynamic-amplification cousin of the quasi-static default.

**Wind:** pattern steady | sine | gusts (seeded sum of 5 sinusoids, band 0.1–2 Hz); amplitude as line load (kN/m) on the projected vertical extent of windward members → tributary nodal forces; frequency dial 0.05–5 Hz; damping slider ζ 0.5–10%. Live: DAF meter, per-mode energy bars, f-dial marks at f₁…f₄ (the invitation to cause trouble). Label: "simplified uniform wind field."

**Load ramp:** proportional factor on current loads 0 → failure; big numeric readout of λ as it climbs; stops exactly at the governing factor (§4.7).

### 6.4 Results display

Members colored by utilization (diverging blue→paper→red, saturating at U = 1); width by |N|; toggles: axial/shear/moment diagrams (drawn as classic hatched diagrams on the members), deformed shape ON by default with **auto-exaggeration badge** ("deformation ×120 — true max 3.2 mm"). Mode ghosts: dashed overlay animating φ_i at its natural frequency (slowed to 1/4 speed above 2 Hz, labeled).

### 6.5 Failure UX

Banner (one line): mechanism class + governing element + the two numbers that decide it. Why-panel (expand): the criterion formula with live values substituted, the mode shape or cascade timeline, and one plain-language paragraph per mechanism class (write these four paragraphs once, well). Replay button: re-run the cinematic; prefers-reduced-motion honored (static mode-shape with arrow annotations instead).

### 6.6 Capacity panel (always visible in Test)

"Max truck: 412 kN (governed by member 12, yield)" · "Buckling margin λ = 2.3" · "f₁ = 1.9 Hz" · "Mass: 4.2 t" · "**Capacity/weight: 98 kN/t**". Resonance is excluded from the score (it's frequency- not amplitude-governed; a tooltip says so).

### 6.7 Visual language

IBM Plex Sans (UI) + IBM Plex Mono (numbers). Paper `#f4f1ea`, ink `#1a1d21`, blueprint accent `#2456a4`, stress ramp `#2456a4 → paper → #c0392b`. Dark mode: not in v1 (cut: one aesthetic done well). Empty state: faint ghost of a hand-sketched truss with "draw a member to begin."

### 6.8 A/S/M diagram ordinates

This section is the normative contract for the diagram sampling implemented in
`src/canvas/diagram-samples.ts` and verified by
`src/canvas/__tests__/diagram-samples.test.ts`.

The axial, shear, and moment diagrams are pedagogy, not decoration. Their job is to make the shape
of the internal actions legible, so the contract is about shape, not only about extremes.

**Sampling.** Ordinates are sampled at `DIAGRAM_STATIONS = 12` interior stations per mesh element,
ordered from each member's A node to its B node, with the shared station at an element joint emitted
once so the polyline does not double back. Sampling is pure and lives outside the canvas; the
drawing code only maps model-space ordinates through `toScreen`.

**Per-diagram shape.**

- **Axial** is constant within an element — for the axial diagram a block _is_ the correct shape.
- **Shear** varies linearly across an element between its end values.
- **Moment** uses Hermite recovery: end moments interpolated linearly, plus the parabolic term the
  transverse load contributes in span.

**Scaling.** A single maximum, shared across all three diagrams and floored at 1, so ordinates stay
comparable and a zero-action model cannot divide by zero.

**Acceptance criteria (G37).** For the gravity-loaded `simple-beam` preset:

1. the moment diagram is a sagging parabola whose peak is at midspan (within one station), and
2. the moment at each simply supported end is essentially zero (< 2 % of the peak), and
3. the shear diagram is linear and changes sign at midspan.

**Internal-action recovery contract.** `recoverElementForces` publishes the local
element end-force vector
`f_local = k_local · (T · u_global) + FEA`, where `FEA` is the assembled fixed-end action vector
for member loads. The display layer maps the local vector to the internal-action convention:
`V(0)=+Fy1`, `V(L)=−Fy2`, `M(0)=−M1`, `M(L)=+M2`. This is the physics convention, not a fixture
fit; the UDL and midspan point-load oracles in
`src/fem/__tests__/recovery-oracle.test.ts` assert the simply-supported end reactions and zero
pin moments directly against the recovery layer.

The downstream utilization, influence-line, pushover, and traffic paths use the same mapped
actions. The simple-beam checks assert a parabolic moment diagram with a midspan peak and zero pin
moments, plus a shear diagram that changes sign at midspan.

**Slender-deck traffic re-derivation (GAP-10 follow-through).** The preset is a 60 m simply
supported span with `w_g = ρAg = 5,912.233152 N/m`, `M_y = f_y I/c = 2,908,160 N·m`, and gravity
midspan moment `w_g L²/8 = 2,660,504.9184 N·m` (`U_g = 0.9148413149`). A vehicle front axle at
station 0 is on the pin and its rear axle is off-deck, so it adds no member action and has no
finite yield capacity; the controller correctly reports `undefined`. At station 30, the
recovered-force bisection returns a finite `16.2859384058 kN` capacity; this is the value used by
the traffic controller test after the recovery contract was re-derived.

---

## 7. Presets

| #   | Name                       | Teaches                 | Notes                                                                                                                                                                        |
| --- | -------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Simple beam                | diagrams, deflection    | 8 m, UDL + traffic                                                                                                                                                           |
| 2   | Pratt truss (24 m)         | axial flow, efficiency  | releases on, deck on bottom chord                                                                                                                                            |
| 3   | Two-span cantilever bridge | negative moment, hinges | Forth-style balance                                                                                                                                                          |
| 4   | Radio mast (30 m)          | buckling, slenderness   | ramp story default                                                                                                                                                           |
| 5   | Slender deck (60 m)        | resonance               | tuned so f₁ ≈ 0.3–0.5 Hz, wind story default, in-app note: _real Tacoma Narrows failed in torsional aeroelastic flutter — a 3D phenomenon; this shows its 2D bending cousin_ |
| 6   | Blank grid                 | —                       | default landing state                                                                                                                                                        |

Preset files are data (`presets/*.ts` exporting schema-v1 objects with authored coordinates). Tune member sizes so each preset's default story produces its teaching moment within ~20 s of play.

---

## 8. Worker protocol

`eigen.worker.ts`: request `{ id, kind: 'modal'|'buckling', mesh: TransferableMesh, nRef?: Float64Array }` → response `{ id, values: Float64Array, vectors: Float64Array, iterations }`. Transferables for all big arrays. Main thread keeps a single in-flight request per kind; stale responses (id mismatch) dropped. Statics/Newmark stay on main thread — they're sub-millisecond back-substitutions and moving them would add latency, not remove it.

---

## 9. Test plan (the honesty gates)

All in `fem/__tests__/`, Vitest, node environment. These exact tolerances were measured during planning; regressions are bugs, not "numerical noise."

| Gate                       | Setup                                                       | Expect                                                                | Tol                                |
| -------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| G1 tip deflection          | cantilever, 1 elem, tip P                                   | PL³/3EI and θ = PL²/2EI                                               | 1e−10 rel                          |
| G2 SS midspan UDL          | 2 subdivisions, consistent FEF                              | 5wL⁴/384EI at mid-node                                                | 1e−10 rel (nodal exactness of E-B) |
| G3 Euler buckling          | pinned column, 2 elem                                       | π²EI/L²                                                               | +0.8% (measured +0.75%)            |
| G3b Euler buckling         | 4 elem                                                      | π²EI/L²                                                               | +0.1% (measured +0.051%)           |
| G4 SS beam ω₁              | 2 elem, consistent mass                                     | π²√(EI/ρAL⁴)                                                          | +0.5% (measured +0.39%)            |
| G5 K symmetry & Betti      | random frames (seeded)                                      | Kᵀ = K; δ_ab = δ_ba                                                   | 1e−9                               |
| G6 mechanism detect        | unsupported / underbraced models                            | flagged, correct node                                                 | exact                              |
| G7 releases                | truss vs frame same geometry                                | truss members carry M ≈ 0                                             | 1e−8                               |
| G8 Newmark SDOF            | ζ = 2%, r = 1, 50 cycles                                    | steady amp = static × 1/(2ζ)                                          | 2%                                 |
| G9 Rayleigh fit            | ζ at ω₁, ω₂                                                 | modal ζ₁ = ζ₂ = target                                                | 1e−6                               |
| G10 sections               | each section kind                                           | A, I vs hand calc                                                     | 1e−12                              |
| G11 share round-trip       | property: random models                                     | decode(encode(m)) = m                                                 | exact                              |
| G12 cascade golden         | preset 4 overload                                           | exact step sequence                                                   | frozen fixture                     |
| G13 load positioning       | P at ξ sweep                                                | reactions sum to P; continuity at nodes                               | 1e−10                              |
| G14 Timoshenko tip         | cantilever, shearFlexible, tip P                            | PL³/3EI + PL/(G A_s)                                                  | 1e−9 rel                           |
| G15 P-Δ amplification      | beam-column, tip H + axial P                                | moment amp ≈ tan(μ)/μ ≈ 1/(1−P/P_cr)                                  | 2%                                 |
| G16 earthquake spectrum    | SDOF Sa peak vs Newmark SDOF                                | peak Sa match                                                         | 2%                                 |
| G17 influence midspan M    | SS beam, unit-load deck sweep                               | piecewise-linear η peak L/4                                           | exact                              |
| G18 tension-only cables    | guyed mast, tip lateral load                                | load-side guy slack, restraint taut                                   | golden                             |
| G19 plastic pushover       | fixed portal, eaves H                                       | collapse H vs 4M_p/h                                                  | 3%                                 |
| G20 challenges + gallery   | 4 budget challenges + curated hashes                        | starter fail / solution pass; gallery.json `#mu=` round-trip          | exact                              |
| G21 moving-mass traffic    | SS beam, parked vehicle + lumped M                          | mass conserved; Newmark settles to quasi-static midspan               | 2%                                 |
| G22 3D cantilever tip      | 1 space-frame elem; tip P_y, P_z, T_x                       | PL³/3EI + TL/GJ closed forms                                          | 1e−10 rel                          |
| G23 2D↔3D regression       | G1 cantilever as 3D XY-plane model, out-of-plane DOFs fixed | tip matches 2D analyzeStaticModel                                     | 1e−9 rel                           |
| G24 space corner frame     | two orthogonal members, tip load off both axes              | reactions ∑F = P; K symmetric; energy W=U                             | 1e−9                               |
| G25 3D Euler buckling      | pinned column, 2 space-frame elems, 2D DOF pattern embedded | π²EI/L² (matches G3)                                                  | +0.8%                              |
| G26 3D modal               | SS beam 2 elems (embed + biaxial Iy≠Iz)                     | ω₁ ≈ π²√(EI/ρAL⁴); biaxial ∝ √I                                       | +0.5%                              |
| G27 spatial buckling       | pinned column along Z, both bending planes free, G=1        | λ_cr = π² E I_min / L²                                                | +0.8%                              |
| G28 schema v2 migrate      | golden v1 URL + migrateV1toV2                               | v1 decode identical; v2 round-trip; z=0 planar                        | exact                              |
| G29 3D influence midspan M | clamped-clamped deck, unit-load station sweep               | η peak = L/8 at midspan                                               | 1e−6 rel                           |
| G30 3D traffic envelope    | deck station sweep, two-axle                                | monotonic under repeated merges; ≥ single-station \|M\|               | exact                              |
| G31 3D wind DAF            | synthetic modal coords driven at f₁                         | measured DAF = 1/(2ζ); resonance fires only inside ±10% / 1.5× / ζ<5% | 2%                                 |
| G32 3D Timoshenko tip      | stubby cantilever (L/h = 3), shearFlexible, tip P           | PL³/3EI_y + PL/(G A_s)                                                | 1e−6 rel                           |
| G33 3D P-Δ amplification   | space beam-column, tip H + axial P = 0.25 P_cr              | M amp ≈ tan(μ)/μ ≈ 1/(1−P/P_cr); linear recovery at P=0               | 2%                                 |
| G34 3D live cable slack    | guyed mast through `analyzeStaticModel3d`                   | load-side guy slack, restraint guy taut                               | golden                             |
| G35 3D gallery round-trip  | curated v2 `#mu=` hashes in gallery.json                    | `decodeModel3d` matches authored source; hash < 32 kB                 | exact                              |
| G36 3D editor history      | undo/redo + `MEMBER_HARD_LIMIT_3D`                          | counts restored; adds past the cap rejected; load/reset clear history | exact                              |

**G29 spatial influence criterion.** A single-element pinned-pinned space frame is singular about
its own axis, so the gate uses a clamped-clamped deck and its exact `L/8` midspan peak. The planar
simply-supported `L/4` case remains covered by G17 in 2D.

Gates G1–G37 are real Vitest checks (not `it.todo`) and must stay green. Both CI configurations run
version coherence, the production dependency audit, typecheck, lint, citation and format checks,
build, CSP and bundle checks, Playwright against the static export, and the complete Vitest suite.
Deployment occurs only from a green `main` build.

---

## 12. Decision log

| Decision                                             | Alternatives                            | Why                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2D plane frames as the base model                    | 3D-only core                            | The 2D core keeps the introductory mechanics legible; the 3D layer adds torsion and spatial behavior while reusing the dimension-agnostic solver pieces.                                                                                          |
| Euler–Bernoulli default; Timoshenko optional (2A)    | Timoshenko-only                         | shear deformation < 2% for slender members that dominate bridges/towers; E-B keeps matrices textbook-clean as the default. Timoshenko is an analysis toggle with φ = 12EI/(G A_s L²) and gate G14.                                                |
| "Tacoma-style" honesty                               | pretend 2D flutter                      | true Tacoma = torsional aeroelastic flutter, impossible in-plane; we ship honest bending resonance + an in-app note. Faking it would break the product's one promise.                                                                             |
| Auto-mesh ×2 hidden                                  | user meshing                            | measured 0.75%/0.39% errors invisible at UI precision; meshing UI is expert noise                                                                                                                                                                 |
| Dense LDLᵀ (2D + early 3D)                           | sparse/skyline                          | Teaching sizes; dense typed-array factor < 5 ms at n ≲ 300 free DOF                                                                                                                                                                               |
| Skyline + RCM free factor (3S)                       | keep dense only                         | Dense storage is prohibitive around 1.5k free DOF; the current skyline+RCM profile stays in single-digit milliseconds at that scale and meets the §3 target around 300 elements.                                                                  |
| Subspace iteration                                   | full Jacobi on K                        | Jacobi is O(n³) on the full matrix — fine at 300 DOF, not 1200; subspace reuses the LDLᵀ solve we already have                                                                                                                                    |
| Quasi-static traffic                                 | moving-mass dynamics                    | envelope + smooth sweep deliver the pedagogy; Phase 2H adds optional moving-mass Newmark (lumped vehicle M) as the honest ~10–30% amplification cousin                                                                                            |
| Collapse cascade                                     | stop at first failure                   | Redistribution makes progressive collapse visible, and quasi-static re-solving keeps the sequence computationally tractable and explicitly labelled.                                                                                              |
| Capacity/weight readout                              | gamified scoring                        | A dimensional engineering ratio is more informative than an opaque score and works without a backend.                                                                                                                                             |
| Honesty badges (deformation ×N, quasi-static labels) | silent exaggeration                     | They keep visual staging distinct from computed onset values.                                                                                                                                                                                     |
| Earthquake story (2C)                                | omit dynamic base excitation            | Base excitation −M·ι·ü_g plus the Sa spectrum exposes a distinct dynamic load case without claiming site-specific prediction.                                                                                                                     |
| Tension-only cables (2E)                             | compression-capable cable members       | Slack iteration matches the element's intended unilateral behavior and supports the guyed-mast teaching preset.                                                                                                                                   |
| No runtime numerics deps                             | math.js et al.                          | A hand-rolled, typed-array kernel keeps the numerical implementation auditable.                                                                                                                                                                   |
| Next.js static export                                | Vite                                    | Static export preserves the no-backend contract. Accepted costs: `BASE_PATH` must be set per host (no relative-base mode) and framework weight for a client-only app. Kernel + tests remain bundler-agnostic.                                     |
| Dual CI (GitHub + GitLab)                            | pick one                                | Both configurations run the same verification gates and preserve a choice of Pages host; activation and host settings are deployment concerns rather than repository state.                                                                       |
| three.js for Phase 3 WebGL                           | stay on Canvas2D; Babylon; raw WebGL    | Orbit/pan plus extruded LOD need a scene graph; three is the smallest mature fit. The kernel stays dependency-free.                                                                                                                               |
| Playwright (devDep) for README stills (3Z)           | manual OS screenshots; Puppeteer        | Automated Build/Test 2D+3D captures via `scripts/capture-screenshots.mjs` against `out/`. Dev-only — not a runtime dependency.                                                                                                                    |
| Internal-action recovery                             | keep `k·u − FEA`; alter fixtures to fit | Physics requires `k·u + FEA` for the stored fixed-end actions, followed by the §6.8 end-action display mapping. UDL and point-load recovery oracles, diagram gates, influence G17, and downstream utilization/traffic paths verify that contract. |

---

## 13. Appendix

**A. Worked constants for gates.** With E=1, A=1, I=1, L=1, ρ=1: G1 v=1/3, θ=1/2 · G3 expects 9.9438 (2 elem) vs π²=9.8696 · G4 expects ω₁=9.9086 (2 elem) vs 9.8696. (Measured values — use them to verify the harness itself.)

**B. References for the curious** (not required to build): Cook, Malkus, Plesha, Witt — _Concepts and Applications of Finite Element Analysis_; Bathe — _Finite Element Procedures_ (subspace iteration); Chopra — _Dynamics of Structures_ (Newmark, Rayleigh).

**C. Repo conventions.** Strict TS (`strict`, `noUncheckedIndexedAccess`); fem/ imports nothing from DOM or React; no new runtime deps without a decision-log entry; prettier formatting enforced; every fem/ function that implements a §4 formula cites its section in a doc comment.

---

## 14. Feature requirements (2A–4J)

The numbered requirement ids below are cited from source comments. Each row states what the
feature must do; all of them are implemented.

### Depth requirements (2A–2H)

| #   | Feature                    | Spec                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A  | Timoshenko option          | Shear-flexible element via φ = 12EI/(G·A_s·L²): the §4.1 bending block gains standard (1+φ) denominators; per-material G, per-section shear area A_s (κ presets: rect 5/6, I-web-only, tube 0.5). Analysis toggle + "when it matters" in-app note (L/h < 10). Gate: cantilever tip = PL³/3EI + PL/(G A_s) vs closed form, 1e−9.                |
| 2B  | P-Δ second-order statics   | Iterate K + K_g(N) → re-solve → update N until ‖ΔN‖ < 1e−6 rel (2–4 iterations typical; divergence ⇒ report as buckling-adjacent instability). Show amplification vs linear side by side. Gate: beam-column moment amplification ≈ 1/(1−P/P_cr) within 2%.                                                                                     |
| 2C  | Earthquake story           | Base excitation: effective load −M·ι·ü_g(t) (ι = influence vector, x-direction unity); 2–3 synthetic records + scaled classic record; response-spectrum panel (SDOF sweep 0.1–10 Hz, the record's teeth made visible); story copy parallels wind. Gate: SDOF spectrum peak matches Newmark SDOF run, 2%.                                       |
| 2D  | Influence lines            | First-class view: unit-load sweep along deck per response quantity (reaction, member N, section M); envelope integration with traffic story. Gate: SS beam midspan-moment influence line = piecewise-linear peak L/4, exact.                                                                                                                   |
| 2E  | Tension-only cables        | Member flag `cableOnly`: iterative slack removal (deactivate compression members, re-solve, reactivate if tension returns; oscillation guard: freeze after 10 iterations, report). Unlocks guyed-mast; 3D suspension teaching preset is §14 3X. Gate: guyed mast under lateral load — load-side guy slack, restraint guy taut, golden fixture. |
| 2F  | Plastic pushover           | Bilinear moment-curvature (M_p from section modulus × f_y); incremental lateral load with hinge insertion (reuse §4.7 cascade machinery); pushover curve panel (base shear vs roof displacement) with hinge-formation markers. Gate: portal frame collapse load vs plastic-analysis hand calc (4M_p/h), 3%.                                    |
| 2G  | Challenge scenes + gallery | 4 constrained-budget challenges ("span 40 m under 6 t of steel"); curated shared-URL gallery page (static, no backend — a JSON of curated hashes). Gate G20: evaluator geometry/budget + starter fail / solution pass + gallery.json round-trip.                                                                                               |
| 2H  | Moving-mass note upgrade   | Optional dynamic traffic: vehicle mass lumped at contact nodes, time-stepped (mass matrix updated per frame position — the honest version of the v1 footnote). Toggle on traffic story; Newmark ζ=2%; amp badge vs static. Gate G21.                                                                                                           |

### Spatial requirements (3-series)

The 3D implementation applies the same truth contract one dimension up while keeping the solver,
rendering, editor, and story boundaries explicit.

- **Solver:** 12-DOF space-frame element — formulas in §4.9 (axial EA/L, St. Venant torsion GJ/L, biaxial bending, triad transform, releases, 12×12 K_g and consistent M). Kernel lives under `fem/space/` so the 2D path stays untouched. Solver core (LDLᵀ, subspace iteration, Newmark) is dimension-agnostic and reused via `modalAssembled` / `bucklingAssembled`. Gates **G22–G27** (tip closed forms, 2D↔3D regression, space corner, embed Euler, 3D modal, spatial buckling).
- **Rendering:** three.js WebGL layer; orbit/pan camera; members as extruded sections (LOD: lines when zoomed out); stress color/width mapping carried over; mode ghosts in 3D.
- **Editor:** workplane model — draw in a gizmo-selected plane (ground, elevation, **custom**); replicate/extrude; node/member semantics unchanged. Schema v2 (`v: 2`, z coords, roll angles) with automatic v1→v2 migration in `serialize.ts` — old share URLs must keep working (gate **G28**). Ground + XZ/YZ + **custom (3-click)** shipped (3T).
- **Stories in 3D:** wind direction dial; traffic deck polyline; buckling includes spatial modes; honesty note: warping / member-level LTB out of scope.
- **Polish:** presets rebuilt as 3D scenes (slender deck St. Venant torsional cousin + Tacoma note refresh), landing refresh, performance pass.

### Spatial closeout requirements (3P–3Z)

Spatial parity items completing the 3-series.

| #   | Item                                    | Spec                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3P  | 3D preset polish                        | Spatial §7 rebuilds; twin-girder slender deck with early St. Venant torsional mode; Tacoma honesty graduated (2D = bending cousin, 3D f₂ = torsion — not flutter).                                                                                                         |
| 3Q  | Landing refresh                         | Empty/first-load 2D + 3D states earn their pixels; brand + one clear invitation to draw or load a preset; no dashboard clutter.                                                                                                                                            |
| 3R  | Performance pass                        | Profile at editor soft/hard member caps and ~1–5k DOF 3D; harden WebGL LOD; keep 60 fps traffic / Newmark budgets (§3); expose measured numbers in the status footer.                                                                                                      |
| 3S  | Skyline (or confirmed dense)            | Profile global K at n ≳ 5k DOF. If dense factor blows the §3 budget, ship skyline/profile storage for assembled K (and matching free-DOF factor path). If dense stays inside budget with headroom, record the measurement and keep dense — either outcome closes the item. |
| 3T  | Custom workplanes                       | Editor workplane beyond ground/XZ/YZ: user-defined plane (origin + two axes or point-normal), draw/extrude against it.                                                                                                                                                     |
| 3U  | 3D share URLs                           | Wire Share in 3D to `encodeModel3d` / `decodeModel3d`; load `#m`/`#mu` v2 hashes on boot; keep v1 hashes decoding via migrate. Round-trip property test for authored 3D presets.                                                                                           |
| 3V  | 3D story parity — ramp + failure        | Load-ramp story on `EditorModel3d`; four-way failure taxonomy + cascade + why-panel + honesty badges against spatial results. Capacity-to-weight panel in 3D Test.                                                                                                         |
| 3W  | 3D story parity — earthquake + pushover | Port 2C base excitation (−M·ι·ü_g with 3D ι) and 2F plastic pushover to space-frame meshes.                                                                                                                                                                                |
| 3X  | 3D cables + suspension preset           | `cableOnly` slack iteration on space-frame members; spatial guyed-mast + suspension teaching presets; honesty: straight chords.                                                                                                                                            |
| 3Y  | 3D moving-mass traffic                  | Toggle on 3D traffic: lump vehicle mass at axle contacts, Newmark with M rebuilt per station; amp badge vs quasi-static (2H cousin).                                                                                                                                       |
| 3Z  | README screenshots                      | Capture Build + Test (2D and 3D) stills into `docs/`; update README What-you-can-do bullets for Phase 3.                                                                                                                                                                   |

**Discipline:** every spatial change keeps the 2D gates green. Never cut solver gates or honesty badges.

### Spatial pedagogy and parity requirements (4A–4J)

Pedagogy and parity items on top of the spatial closeout. Same honesty contract; no new physics the product cannot truthfully claim.

| #   | Item                             | Spec                                                                                                                                                |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4A  | 3D traffic moment envelope       | Port 2D moment-envelope overlay onto the 3D deck.                                                                                                   |
| 4B  | 3D influence lines               | Unit-load sweep along `EditorModel3d.deck` for reaction / member N / section M; envelope-from-η cousin.                                             |
| 4C  | 3D wind DAF + resonance UI       | Measured DAF meter, per-mode energy bars, f₁…f₄ marks, resonance classify/banner.                                                                   |
| 4D  | 3D spectrum + pushover SVG       | `SpectrumPanel3d` + `PushoverPanel3d` inside `TestConsole3d` (3W chrome).                                                                           |
| 4E  | 3D Timoshenko + P-Δ              | Shear-flexible space-frame option + iterative K+K_g.                                                                                                |
| 4F  | 3D A/S/M diagram toggles         | Per-member N/V/M coloring + width overlay in `StructureCanvas3d` (via `memberDiagramMagnitudes`); Results / Axial / Shear / Moment buttons in Test. |
| 4G  | 3D editor depth                  | Undo/redo snapshot stack (`past`/`future` + `undo`/`redo`), `MEMBER_HARD_LIMIT_3D` on add/extrude/replicate, rail lint badge, `⌘Z / ⇧⌘Z` bindings.  |
| 4H  | Live cable slack on Build        | `analyzeStaticModel3d` delegates to `solveTensionOnly3d` when any member is `cableOnly`.                                                            |
| 4I  | Capacity / failure chrome polish | Resonance-excluded tooltip on capacity/weight (2D + 3D).                                                                                            |
| 4J  | Gallery + share polish           | `gallerySources3d` + `encodeModelUncompressed3d`; `public/gallery.json` now carries 11 v1 + 12 v2 entries with 3D badge in gallery-page.            |

**Honesty / product ceilings** — do not fake these; label them forever: true aeroelastic flutter; warping torsion / member-level LTB; accounts; backends. Dark mode remains a taste cut, not a build item.

---
