// v0 scaffold shell. Replaced by the Build/Test layout at M2.
// The editor/canvas surfaces become client components ('use client'); the fem/
// kernel stays framework-free.
export default function Home() {
  return (
    <main className="scaffold">
      <svg viewBox="0 0 32 32" width="56" height="56" aria-hidden>
        <path
          d="M2 26h28M4 26L16 8l12 18M10 26L16 17l6 9"
          stroke="var(--accent)"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <h1>Limit State</h1>
      <p>A structural sandbox that tells the truth.</p>
      <p className="mono">v0 scaffold — solver gates in src/fem/__tests__/</p>
    </main>
  );
}
