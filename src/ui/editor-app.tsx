'use client';

import { useEffect, useMemo } from 'react';
import { StructureCanvas } from '../canvas/structure-canvas';
import { analyzeStaticModel, deformationDisplay } from '../fem/statics';
import { inspectStability } from '../state/stability';
import { type EditorTool, useEditorStore } from '../state/editor-store';
import { Inspector } from './inspector';

const TOOLS: Array<{ id: EditorTool; label: string; key: string; description: string }> = [
  { id: 'select', label: 'Select', key: 'V', description: 'Inspect a node or member' },
  { id: 'node', label: 'Node', key: 'N', description: 'Place a grid-snapped node' },
  { id: 'member', label: 'Member', key: 'M', description: 'Connect two nodes' },
  { id: 'support', label: 'Support', key: 'S', description: 'Cycle pin, roller, fixed' },
  { id: 'load', label: 'Load', key: 'L', description: 'Add a 10 kN point load' },
  { id: 'deck', label: 'Deck', key: 'D', description: 'Paint a traffic path' },
  { id: 'delete', label: 'Delete', key: '⌫', description: 'Remove a node or member' },
];

export function EditorApp(): React.JSX.Element {
  const model = useEditorStore((state) => state.model);
  const mode = useEditorStore((state) => state.mode);
  const tool = useEditorStore((state) => state.tool);
  const gridSnap = useEditorStore((state) => state.gridSnap);
  const stability = useEditorStore((state) => state.stability);
  const notice = useEditorStore((state) => state.notice);
  const resultDiagram = useEditorStore((state) => state.resultDiagram);
  const showDeformed = useEditorStore((state) => state.showDeformed);
  const setMode = useEditorStore((state) => state.setMode);
  const setTool = useEditorStore((state) => state.setTool);
  const setGridSnap = useEditorStore((state) => state.setGridSnap);
  const setModelName = useEditorStore((state) => state.setModelName);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const reset = useEditorStore((state) => state.reset);
  const setStability = useEditorStore((state) => state.setStability);
  const setResultDiagram = useEditorStore((state) => state.setResultDiagram);
  const setShowDeformed = useEditorStore((state) => state.setShowDeformed);
  const analysis = useMemo(() => analyzeStaticModel(model), [model]);
  const deformation = analysis.kind === 'stable' ? deformationDisplay(analysis.mesh, analysis.result.u, 44) : null;

  useEffect(() => {
    setStability({ kind: 'checking', message: 'Checking stability…' });
    const timer = window.setTimeout(() => setStability(inspectStability(model)), 300);
    return () => window.clearTimeout(timer);
  }, [model, setStability]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if (event.key === ' ') { if (mode === 'test') event.preventDefault(); return; }
      if (event.key === 'Backspace' || event.key === 'Delete') { setTool('delete'); return; }
      const matching = TOOLS.find((candidate) => candidate.key.toLowerCase() === event.key.toLowerCase());
      if (matching) setTool(matching.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, redo, setTool, undo]);

  return (
    <main className="editor-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden>△</span><span>Limit State</span></div>
        <input className="model-name" aria-label="Model name" value={model.name} onChange={(event) => setModelName(event.target.value)} />
        <div className="topbar-actions">
          <div className="mode-switch" aria-label="Mode">
            <button type="button" className={mode === 'build' ? 'active' : ''} onClick={() => setMode('build')}>Build</button>
            <button type="button" className={mode === 'test' ? 'active' : ''} onClick={() => setMode('test')}>Test</button>
          </div>
          <button type="button" className="quiet-button" onClick={reset}>Blank grid</button>
        </div>
      </header>
      <section className="editor-workspace">
        <nav className="tool-rail" aria-label="Build tools">
          <span className="rail-label">Tools</span>
          {TOOLS.map((candidate) => <button key={candidate.id} type="button" className={tool === candidate.id ? 'tool active' : 'tool'} title={`${candidate.description} (${candidate.key})`} onClick={() => setTool(candidate.id)}><span>{candidate.label}</span><kbd>{candidate.key}</kbd></button>)}
          <div className="rail-bottom">
            <label className="snap-toggle"><input type="checkbox" checked={gridSnap} onChange={(event) => setGridSnap(event.target.checked)} /> Snap 0.5 m</label>
            <button type="button" className="history-button" onClick={undo}>Undo <kbd>⌘Z</kbd></button>
            <button type="button" className="history-button" onClick={redo}>Redo <kbd>⇧⌘Z</kbd></button>
          </div>
        </nav>
        <section className="canvas-panel" aria-label="Structure workspace">
          <StructureCanvas analysis={analysis} diagram={resultDiagram} showDeformed={showDeformed} />
          <div className={`lint-badge lint-${stability.kind}`}>{stability.message}</div>
          {notice && <div className="canvas-notice" role="status">{notice}</div>}
          {analysis.kind === 'stable' && <div className="result-controls" aria-label="Static result display">
            {(['none', 'axial', 'shear', 'moment'] as const).map((diagram) => <button key={diagram} type="button" className={resultDiagram === diagram ? 'active' : ''} onClick={() => setResultDiagram(diagram)}>{diagram === 'none' ? 'Results' : diagram[0]!.toUpperCase() + diagram.slice(1)}</button>)}
            <label><input type="checkbox" checked={showDeformed} onChange={(event) => setShowDeformed(event.target.checked)} /> Deformed</label>
          </div>}
          {deformation && showDeformed && deformation.maxMeters > 0 && <div className="deformation-badge">deformation ×{formatScale(deformation.scale)} — true max {formatLength(deformation.maxMeters)}</div>}
          {mode === 'test' && <div className="test-placeholder"><span>Test mode is wired for the next analysis stories.</span><button type="button" onClick={() => setMode('build')}>Return to Build</button></div>}
        </section>
        <Inspector />
      </section>
    </main>
  );
}

function formatScale(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
}

function formatLength(value: number): string {
  return value < 0.01 ? `${(value * 1000).toFixed(2)} mm` : `${value.toFixed(3)} m`;
}
