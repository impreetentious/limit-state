# Limit State

**A structural sandbox that tells the truth.**

*Limit state design* is the foundational framework of modern structural engineering: identify the states at which a structure ceases to satisfy its criteria, and design against them. This is the interactive version.

Sketch a bridge or a tower. Watch stress flow through every member, live. Drive a truck across it. Dial wind up to a natural frequency and feel it fight back. And when it fails, Limit State doesn't play an explosion sound — it names the mechanism: *yield*, *buckling (with the eigenmode)*, *resonance (with the mode it excited)*, or *mechanism* — with the numbers that prove it.

Construction games fake physics with springs. Real finite-element analysis lives in five-figure desktop suites. Limit State is the unclaimed middle: a **true FEM core** — direct stiffness method, eigenvalue buckling, modal analysis, Newmark time integration — under a surface you can play with in a browser tab.

## What you can do

- **Build** — nodes, members, pins, rollers, hinges; steel, aluminum, timber, or spaghetti; real sections (box, I-beam, tube).
- **Test** — three load stories: drive **traffic** across your deck (with a live bending-moment envelope), dial up **wind** (steady, sinusoidal, or gusts — with a damping slider and a dynamic-amplification meter), or **ramp** the load until something gives.
- **Break** — and get a straight answer. A collapse timeline shows load redistributing after the first member goes: *member 7 buckled → member 8 overstressed → hinge → mechanism.*
- **Share** — the whole model lives in the URL. No accounts, no server, no data leaves your machine.

## Honesty, stated plainly

Every number is computed by the real method; every flourish is labeled. Deformed shapes carry their exaggeration factor ("×120 — true max 3.2 mm"). The collapse animation is labeled quasi-static. And the slender-deck preset tells you that the real Tacoma Narrows failed in *torsional* aeroelastic flutter — a 3D phenomenon this 2D model deliberately does not fake; it shows you the bending-resonance cousin instead.

The solver is verified against closed-form solutions in CI — cantilever deflection to 1e−10, Euler buckling to 0.8%, beam frequencies to 0.5%.

## Run it

```bash
npm install
npm run dev        # local dev server
npm test           # solver verification gates
npm run build      # static export in out/
```

Requires Node 22+.

## Deploy

Static, client-side, no backend. Both pipelines are committed:

- **GitHub Pages** — push to `main`; `.github/workflows/ci.yml` builds and deploys (enable Pages → Source: GitHub Actions in repo settings, once).
- **GitLab Pages** — push to `main`; `.gitlab-ci.yml` builds and publishes automatically.

Both set `BASE_PATH` for project-site subpaths; for a custom domain or root site, set it to `''` in the pipeline. Or `npm run build` and drop `out/` on any static host.

## Stack

Next.js (static export) · React 19 · TypeScript (strict) · Zustand · Canvas2D. The FEM kernel (`src/fem/`) is hand-rolled on `Float64Array` with **zero numerics dependencies** — Euler–Bernoulli frame elements, LDLᵀ solves, subspace-iteration eigenanalysis, Newmark-β dynamics. Eigen solves run in a Web Worker; traffic re-solves are single back-substitutions, which is why it holds 60 fps.

## Status & plan

This repo is the build plan plus a compiling scaffold. It's a three-phase program (~6 months): **Phase 1** ships the 2D core above; **Phase 2** adds Timoshenko beams, second-order (P-Δ) analysis, an earthquake story with response spectra, influence lines, tension-only cables, and plastic pushover; **Phase 3** goes 3D — space frames, torsion, WebGL — under the same honesty contract.

## License

MIT — see [LICENSE](./LICENSE).

## AI Agent Instructions

Before every commit, update the **Product Version** string below with the exact IST author/committer timestamp (`Asia/Kolkata`). Keep the same numeric release version in `package.json` and the root package entries of `package-lock.json` (once `package.json` exists — from P0 on).

This IST timestamp rule is permanent for all future workflows, commits, and AI agents working in this repository.

Follow this format for version control:

* **Base Format Version:** 0.0.0 — the version of the version-block schema itself (the shape of these lines).
* **Product Version:** `v0.3.14_2026-01-24_03:26:11` (IST)
