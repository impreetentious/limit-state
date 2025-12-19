# Limit State — agent guardrails

- The test gates are acceptance criteria. A milestone is done when its gates are real (not `it.todo`) and green.
- `src/fem/` stays pure: no DOM, no React imports. Vitest runs it under node on purpose.
- No new runtime dependencies without adding a row to the decision log.
- Honesty badges (deformation scale, quasi-static labels) are spec, not polish. Never ship an unlabeled exaggeration.
- Run `npm run typecheck && npm test` before considering any change complete.
- Every commit updates README's Product Version with the exact IST commit timestamp and keeps the same numeric version in `package.json` and both root package entries in `package-lock.json`.
