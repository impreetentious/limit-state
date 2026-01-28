# Limit State

**A structural sandbox that tells the truth.**

*Limit state design* is the foundational framework of modern structural engineering: identify the states at which a structure ceases to satisfy its criteria, and design against them. This is the interactive version.

Sketch a bridge or a tower. Watch stress flow through every member, live. Drive a truck across it. Dial wind up to a natural frequency and feel it fight back. And when it fails, Limit State doesn't play an explosion sound — it names the mechanism: *yield*, *buckling (with the eigenmode)*, *resonance (with the mode it excited)*, or *mechanism* — with the numbers that prove it.

Construction games fake physics with springs. Real finite-element analysis lives in five-figure desktop suites. Limit State is the unclaimed middle: a **true FEM core** — direct stiffness method, eigenvalue buckling, modal analysis, Newmark time integration — under a surface you can play with in a browser tab.

## What you can do

- **Build (2D + 3D)** — nodes, members, pins, rollers, hinges; steel, aluminum, timber, or spaghetti; real sections (box, I-beam, tube). In 3D: workplanes (ground / elevation / custom), extrude & replicate, deck polylines, and spatial presets from Pratt to twin-girder slender deck.
- **Test** — load stories in both dimensions: **traffic** across a deck (2D moment envelope + influence lines; 3D quasi-static or moving-mass Newmark), **wind** (steady / sine / gusts — 3D gains a direction dial), **earthquake** base excitation, **ramp** to first limit, and **pushover** with plastic hinges.
- **Break** — and get a straight answer. A collapse timeline shows load redistributing after the first member goes: *member 7 buckled → member 8 overstressed → hinge → mechanism.* Capacity-to-weight stays on the panel.
- **Share** — the whole model lives in the URL (schema v1 → 2D, v2 → 3D). No accounts, no server, no data leaves your machine.

![2D Build — Pratt truss](docs/build-2d.png)

![2D Test — traffic story](docs/test-2d.png)

![3D Build — slender deck](docs/build-3d.png)

![3D Test — Newmark wind](docs/test-3d.png)

## Honesty, stated plainly

Every number is computed by the real method; every flourish is labeled. Deformed shapes carry their exaggeration factor ("×120 — true max 3.2 mm"). The collapse animation is labeled quasi-static. The 2D slender-deck preset shows bending resonance only; its 3D twin-girder cousin exposes a real St. Venant torsional mode — and still says plainly that Tacoma Narrows was aeroelastic flutter with warping, which this sandbox does not fake.

The solver is verified against closed-form solutions in CI — cantilever deflection to 1e−10, Euler buckling to 0.8%, beam frequencies to 0.5%.

## Run it

```bash
npm install
npm run dev        # local dev server
npm test           # solver verification gates
npm run build      # static export in out/
```

Requires Node 22+.

To refresh README stills after a UI change: `npm run build && npx serve out -l 4173` then `npm run screenshots`.

## Deploy

Static, client-side, no backend. Both pipelines are committed:

- **GitHub Pages** — push to `main`; `.github/workflows/ci.yml` builds and deploys (enable Pages → Source: GitHub Actions in repo settings, once).
- **GitLab Pages** — push to `main`; `.gitlab-ci.yml` builds and publishes automatically.

Both set `BASE_PATH` for project-site subpaths; for a custom domain or root site, set it to `''` in the pipeline. Or `npm run build` and drop `out/` on any static host.

## Stack

Next.js (static export) · React 19 · TypeScript (strict) · Zustand · Canvas2D + three.js (3D). The FEM kernel (`src/fem/`) is hand-rolled on `Float64Array` with **zero numerics dependencies** — Euler–Bernoulli frame elements (2D + 12-DOF space frame), LDLᵀ / skyline+RCM free solves, subspace-iteration eigenanalysis, Newmark-β dynamics. Eigen solves run in a Web Worker; traffic re-solves are single back-substitutions, which is why it holds 60 fps.

## Status & plan

Phase 1–2 and Phase 3 through closeout **3P–3Z** are shipped (spatial FEM, Stories parity, cables, share URLs, README stills). Physics ceilings (flutter, warping/LTB) stay labeled honesty — not fakeable.

## License

MIT — see [LICENSE](./LICENSE).

## AI Agent Instructions

Before every commit, update the **Product Version** string below with the exact IST author/committer timestamp (`Asia/Kolkata`). Keep the same numeric release version in `package.json` and the root package entries of `package-lock.json` (once `package.json` exists — from P0 on).

This IST timestamp rule is permanent for all future workflows, commits, and AI agents working in this repository.

Follow this format for version control:

* **Base Format Version:** 0.0.0 — the version of the version-block schema itself (the shape of these lines).
* **Product Version:** `v0.6.0_2026-01-29_00:23:20` (IST)
