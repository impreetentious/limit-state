'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MemberSpec, NodeSpec, SupportKind } from '../fem/types';
import type { EditorTool, Selection } from '../state/editor-store';
import { useEditorStore } from '../state/editor-store';

interface Point { x: number; y: number }
interface CanvasSize { width: number; height: number }

const SCALE = 44;
const NODE_RADIUS = 5;
const HIT_RADIUS = 11;

/** Canvas2D structure editor and hit-testing surface. */
export function StructureCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [resizeVersion, setResizeVersion] = useState(0);
  const [pointer, setPointer] = useState<Point | null>(null);
  const draftStart = useRef<number | null>(null);
  const model = useEditorStore((state) => state.model);
  const selection = useEditorStore((state) => state.selection);
  const tool = useEditorStore((state) => state.tool);
  const gridSnap = useEditorStore((state) => state.gridSnap);
  const stability = useEditorStore((state) => state.stability);
  const select = useEditorStore((state) => state.select);
  const addNode = useEditorStore((state) => state.addNode);
  const addMember = useEditorStore((state) => state.addMember);
  const cycleSupport = useEditorStore((state) => state.cycleSupport);
  const setPointLoad = useEditorStore((state) => state.setPointLoad);
  const toggleDeckMember = useEditorStore((state) => state.toggleDeckMember);
  const deleteNode = useEditorStore((state) => state.deleteNode);
  const deleteMember = useEditorStore((state) => state.deleteMember);
  const setNotice = useEditorStore((state) => state.setNotice);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => setResizeVersion((version) => version + 1);
    resize();
    const frame = window.requestAnimationFrame(resize);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener('resize', resize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const size = { width: rect.width, height: rect.height };
    if (size.width === 0 || size.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(context, size, model.nodes, model.members, model.supports, model.loads.points, model.deck, selection, pointer, draftStart.current, stability);
  }, [model, pointer, resizeVersion, selection, stability]);

  const worldPoint = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left - rect.width / 2) / SCALE,
      y: (rect.height - 68 - (event.clientY - rect.top)) / SCALE,
    };
    if (!gridSnap) return point;
    return { x: snap(point.x), y: snap(point.y) };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = worldPoint(event);
    const hit = hitTest(point, model.nodes, model.members);
    setPointer(point);
    if (tool === 'member') {
      event.currentTarget.setPointerCapture(event.pointerId);
      draftStart.current = hit.kind === 'node' ? hit.id : addNode(point.x, point.y);
      select({ kind: 'node', id: draftStart.current });
      return;
    }
    applyTool(tool, hit, point);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool !== 'member' || draftStart.current === null) return;
    const point = worldPoint(event);
    const hit = hitTest(point, model.nodes, model.members);
    const end = hit.kind === 'node' ? hit.id : addNode(point.x, point.y);
    const member = addMember(draftStart.current, end);
    if (member !== undefined) select({ kind: 'member', id: member });
    draftStart.current = null;
    setPointer(null);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => setPointer(worldPoint(event));

  const applyTool = (activeTool: EditorTool, hit: Hit, point: Point) => {
    switch (activeTool) {
      case 'select':
        select(hit.kind === 'none' ? { kind: 'none' } : hit);
        break;
      case 'node':
        select(hit.kind === 'node' ? hit : { kind: 'node', id: addNode(point.x, point.y) });
        break;
      case 'support':
        if (hit.kind === 'node') cycleSupport(hit.id);
        else setNotice('Click a node to cycle its support: pin, roller, fixed.');
        break;
      case 'load':
        if (hit.kind === 'node') setPointLoad(hit.id, 0, -10_000);
        else setNotice('Click a node to add a 10 kN downward load.');
        break;
      case 'deck':
        if (hit.kind === 'member') toggleDeckMember(hit.id);
        else setNotice('Click members in order to paint a contiguous deck path.');
        break;
      case 'delete':
        if (hit.kind === 'node') deleteNode(hit.id);
        if (hit.kind === 'member') deleteMember(hit.id);
        break;
      case 'member':
        break;
    }
  };

  return <canvas
    ref={canvasRef}
    className={`structure-canvas tool-${tool}`}
    aria-label="Structural editor canvas"
    onPointerDown={handlePointerDown}
    onPointerUp={handlePointerUp}
    onPointerMove={handlePointerMove}
    onPointerLeave={() => { if (draftStart.current === null) setPointer(null); }}
  />;
}

type Hit = Selection;

function hitTest(point: Point, nodes: NodeSpec[], members: MemberSpec[]): Hit {
  const node = nodes.find((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) * SCALE <= HIT_RADIUS);
  if (node) return { kind: 'node', id: node.id };
  let best: { id: number; distance: number } | undefined;
  for (const member of members) {
    const a = nodes.find((candidate) => candidate.id === member.a);
    const b = nodes.find((candidate) => candidate.id === member.b);
    if (!a || !b) continue;
    const distance = distanceToSegment(point, a, b) * SCALE;
    if (distance <= HIT_RADIUS && (!best || distance < best.distance)) best = { id: member.id, distance };
  }
  return best ? { kind: 'member', id: best.id } : { kind: 'none' };
}

function drawScene(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  nodes: NodeSpec[],
  members: MemberSpec[],
  supports: { node: number; kind: SupportKind }[],
  loads: { node: number; fx: number; fy: number }[],
  deck: number[],
  selection: Selection,
  pointer: Point | null,
  draftStartId: number | null,
  stability: { kind: string; nodeId?: number },
): void {
  context.clearRect(0, 0, size.width, size.height);
  drawGrid(context, size);
  const toScreen = (point: Point): Point => ({ x: size.width / 2 + point.x * SCALE, y: size.height - 68 - point.y * SCALE });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const deckSet = new Set(deck);

  for (const member of members) {
    const a = nodeById.get(member.a);
    const b = nodeById.get(member.b);
    if (!a || !b) continue;
    const aScreen = toScreen(a);
    const bScreen = toScreen(b);
    context.beginPath();
    context.moveTo(aScreen.x, aScreen.y);
    context.lineTo(bScreen.x, bScreen.y);
    context.strokeStyle = selection.kind === 'member' && selection.id === member.id ? '#2456a4' : deckSet.has(member.id) ? '#4d78bb' : '#1a1d21';
    context.lineWidth = selection.kind === 'member' && selection.id === member.id ? 4 : deckSet.has(member.id) ? 3 : 2;
    context.stroke();
    if (deckSet.has(member.id)) {
      context.setLineDash([4, 4]);
      context.strokeStyle = '#f4f1ea';
      context.lineWidth = 1;
      context.stroke();
      context.setLineDash([]);
    }
  }

  if (draftStartId !== null && pointer) {
    const start = nodeById.get(draftStartId);
    if (start) {
      const a = toScreen(start);
      const b = toScreen(pointer);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.setLineDash([6, 5]);
      context.strokeStyle = '#2456a4';
      context.lineWidth = 2;
      context.stroke();
      context.setLineDash([]);
    }
  }

  for (const load of loads) {
    const node = nodeById.get(load.node);
    if (node) drawLoad(context, toScreen(node), load);
  }
  for (const support of supports) {
    const node = nodeById.get(support.node);
    if (node) drawSupport(context, toScreen(node), support.kind);
  }
  for (const node of nodes) {
    const screen = toScreen(node);
    context.beginPath();
    context.arc(screen.x, screen.y, NODE_RADIUS, 0, Math.PI * 2);
    context.fillStyle = stability.kind === 'mechanism' && stability.nodeId === node.id ? '#d99018' : selection.kind === 'node' && selection.id === node.id ? '#2456a4' : '#f4f1ea';
    context.fill();
    context.lineWidth = 1.5;
    context.strokeStyle = '#1a1d21';
    context.stroke();
  }

  if (nodes.length === 0) drawEmptyState(context, size);
}

function drawGrid(context: CanvasRenderingContext2D, size: CanvasSize): void {
  context.save();
  context.strokeStyle = 'rgba(36, 86, 164, 0.1)';
  context.lineWidth = 1;
  const originX = size.width / 2;
  const groundY = size.height - 68;
  const spacing = SCALE / 2;
  for (let x = originX % spacing; x < size.width; x += spacing) {
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, size.height); context.stroke();
  }
  for (let y = groundY % spacing; y < size.height; y += spacing) {
    context.beginPath(); context.moveTo(0, y); context.lineTo(size.width, y); context.stroke();
  }
  context.beginPath(); context.moveTo(0, groundY); context.lineTo(size.width, groundY); context.strokeStyle = '#2456a4'; context.lineWidth = 1.5; context.stroke();
  context.restore();
}

function drawSupport(context: CanvasRenderingContext2D, point: Point, kind: SupportKind): void {
  context.save();
  context.strokeStyle = '#2456a4';
  context.fillStyle = '#f4f1ea';
  context.lineWidth = 1.5;
  if (kind === 'fixed') {
    context.beginPath(); context.moveTo(point.x - 7, point.y - 13); context.lineTo(point.x - 7, point.y + 13); context.stroke();
    for (let y = point.y - 11; y < point.y + 12; y += 5) { context.beginPath(); context.moveTo(point.x - 11, y); context.lineTo(point.x - 7, y + 4); context.stroke(); }
  } else {
    context.beginPath(); context.moveTo(point.x - 9, point.y + 13); context.lineTo(point.x + 9, point.y + 13); context.lineTo(point.x, point.y + 2); context.closePath(); context.fill(); context.stroke();
    if (kind === 'roller') {
      for (const x of [point.x - 5, point.x + 5]) { context.beginPath(); context.arc(x, point.y + 18, 2.5, 0, Math.PI * 2); context.fill(); context.stroke(); }
    }
  }
  context.restore();
}

function drawLoad(context: CanvasRenderingContext2D, point: Point, load: { fx: number; fy: number }): void {
  const magnitude = Math.hypot(load.fx, load.fy) / 1000;
  if (magnitude === 0) return;
  context.save();
  context.strokeStyle = '#c0392b'; context.fillStyle = '#c0392b'; context.lineWidth = 1.5;
  const direction = Math.abs(load.fy) >= Math.abs(load.fx) ? { x: 0, y: load.fy < 0 ? 1 : -1 } : { x: load.fx > 0 ? 1 : -1, y: 0 };
  const end = { x: point.x + direction.x * 28, y: point.y + direction.y * 28 };
  context.beginPath(); context.moveTo(point.x, point.y); context.lineTo(end.x, end.y); context.stroke();
  context.beginPath(); context.moveTo(end.x, end.y); context.lineTo(end.x - direction.y * 4 - direction.x * 4, end.y + direction.x * 4 - direction.y * 4); context.lineTo(end.x + direction.y * 4 - direction.x * 4, end.y - direction.x * 4 - direction.y * 4); context.closePath(); context.fill();
  context.font = '11px IBM Plex Mono, monospace'; context.fillText(`${magnitude.toFixed(0)} kN`, end.x + 5, end.y + 14);
  context.restore();
}

function drawEmptyState(context: CanvasRenderingContext2D, size: CanvasSize): void {
  context.save();
  context.strokeStyle = 'rgba(26, 29, 33, 0.22)'; context.lineWidth = 1.5; context.setLineDash([4, 5]);
  const cx = size.width / 2; const cy = size.height / 2;
  context.beginPath(); context.moveTo(cx - 100, cy + 45); context.lineTo(cx, cy - 40); context.lineTo(cx + 100, cy + 45); context.moveTo(cx - 55, cy + 45); context.lineTo(cx, cy); context.lineTo(cx + 55, cy + 45); context.stroke();
  context.setLineDash([]); context.fillStyle = 'rgba(26, 29, 33, 0.48)'; context.font = '14px IBM Plex Sans, sans-serif'; context.textAlign = 'center'; context.fillText('Draw a member to begin.', cx, cy + 82); context.restore();
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function snap(value: number): number { return Math.round(value * 2) / 2; }
