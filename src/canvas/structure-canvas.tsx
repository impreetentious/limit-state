'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { deformationDisplay, type StaticAnalysis } from '../fem/statics';
import type { AnalysisMesh, MemberSpec, NodeSpec, SupportKind } from '../fem/types';
import type { EditorTool, ResultDiagram, Selection } from '../state/editor-store';
import { sampleDiagram } from './diagram-samples';
import { useEditorStore } from '../state/editor-store';

interface Point {
  x: number;
  y: number;
}
interface CanvasSize {
  width: number;
  height: number;
}
interface ModeGhost {
  vectors: Float64Array;
  mode: number;
  phase: number;
}
interface TrafficAxle {
  x: number;
  y: number;
}
interface FailureCinematic {
  u: Float64Array;
  phase: number;
  reducedMotion: boolean;
}

const SCALE = 44;
const NODE_RADIUS = 5;
const HIT_RADIUS = 11;

/** Canvas2D structure editor and hit-testing surface. */
export function StructureCanvas({
  analysis,
  diagram,
  showDeformed,
  modeGhost,
  trafficAxles,
  momentEnvelope,
  dynamicDisplacement,
  failureCinematic,
}: {
  analysis: StaticAnalysis;
  diagram: ResultDiagram;
  showDeformed: boolean;
  modeGhost?: ModeGhost;
  trafficAxles?: readonly TrafficAxle[];
  momentEnvelope?: ReadonlyMap<number, number>;
  dynamicDisplacement?: Float64Array;
  failureCinematic?: FailureCinematic;
}): React.JSX.Element {
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
  const splitMember = useEditorStore((state) => state.splitMember);
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
    drawScene(
      context,
      size,
      model.nodes,
      model.members,
      model.supports,
      model.loads.points,
      model.deck,
      selection,
      pointer,
      draftStart.current,
      stability,
      analysis,
      diagram,
      showDeformed,
      modeGhost,
      trafficAxles,
      momentEnvelope,
      dynamicDisplacement,
      failureCinematic,
    );
  }, [
    analysis,
    diagram,
    dynamicDisplacement,
    failureCinematic,
    modeGhost,
    model,
    momentEnvelope,
    pointer,
    resizeVersion,
    selection,
    showDeformed,
    stability,
    trafficAxles,
  ]);

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
      const start = nodeAtPointer(hit, point);
      if (start === undefined) return;
      draftStart.current = start;
      select({ kind: 'node', id: start });
      return;
    }
    applyTool(tool, hit, point, event.shiftKey);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (tool !== 'member' || draftStart.current === null) return;
    const point = worldPoint(event);
    const hit = hitTest(point, model.nodes, model.members);
    const end = nodeAtPointer(hit, point);
    if (end === undefined) {
      draftStart.current = null;
      setPointer(null);
      return;
    }
    const member = addMember(draftStart.current, end);
    if (member !== undefined) select({ kind: 'member', id: member });
    draftStart.current = null;
    setPointer(null);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) =>
    setPointer(worldPoint(event));

  const nodeAtPointer = (hit: Hit, point: Point): number | undefined => {
    if (hit.kind === 'node') return hit.id;
    if (hit.kind === 'member') {
      const member = model.members.find((candidate) => candidate.id === hit.id);
      const a = member && model.nodes.find((candidate) => candidate.id === member.a);
      const b = member && model.nodes.find((candidate) => candidate.id === member.b);
      return a && b
        ? splitMember(member.id, projectToSegment(point, a, b).x, projectToSegment(point, a, b).y)
        : undefined;
    }
    return addNode(point.x, point.y);
  };

  const applyTool = (activeTool: EditorTool, hit: Hit, point: Point, additive: boolean) => {
    switch (activeTool) {
      case 'select':
        if (additive && hit.kind === 'member') {
          const selected =
            selection.kind === 'members'
              ? [...selection.ids]
              : selection.kind === 'member'
                ? [selection.id]
                : [];
          const index = selected.indexOf(hit.id);
          if (index >= 0) selected.splice(index, 1);
          else selected.push(hit.id);
          select(
            selected.length === 0
              ? { kind: 'none' }
              : selected.length === 1
                ? { kind: 'member', id: selected[0]! }
                : { kind: 'members', ids: selected },
          );
        } else select(hit.kind === 'none' ? { kind: 'none' } : hit);
        break;
      case 'node':
        if (hit.kind === 'node') select(hit);
        else {
          const node = nodeAtPointer(hit, point);
          if (node !== undefined) select({ kind: 'node', id: node });
        }
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

  return (
    <canvas
      ref={canvasRef}
      className={`structure-canvas tool-${tool}`}
      aria-label="Structural editor canvas"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerMove={handlePointerMove}
      onPointerLeave={() => {
        if (draftStart.current === null) setPointer(null);
      }}
    />
  );
}

type Hit = Exclude<Selection, { kind: 'members' }>;

function hitTest(point: Point, nodes: NodeSpec[], members: MemberSpec[]): Hit {
  const node = nodes.find(
    (candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) * SCALE <= HIT_RADIUS,
  );
  if (node) return { kind: 'node', id: node.id };
  let best: { id: number; distance: number } | undefined;
  for (const member of members) {
    const a = nodes.find((candidate) => candidate.id === member.a);
    const b = nodes.find((candidate) => candidate.id === member.b);
    if (!a || !b) continue;
    const distance = distanceToSegment(point, a, b) * SCALE;
    if (distance <= HIT_RADIUS && (!best || distance < best.distance))
      best = { id: member.id, distance };
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
  analysis: StaticAnalysis,
  diagram: ResultDiagram,
  showDeformed: boolean,
  modeGhost: ModeGhost | undefined,
  trafficAxles: readonly TrafficAxle[] | undefined,
  momentEnvelope: ReadonlyMap<number, number> | undefined,
  dynamicDisplacement: Float64Array | undefined,
  failureCinematic: FailureCinematic | undefined,
): void {
  context.clearRect(0, 0, size.width, size.height);
  drawGrid(context, size);
  const toScreen = (point: Point): Point => ({
    x: size.width / 2 + point.x * SCALE,
    y: size.height - 68 - point.y * SCALE,
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const deckSet = new Set(deck);
  const utilization = analysis.kind === 'stable' ? analysis.result.utilization : undefined;
  const axialByMember = new Map<number, number>();
  if (analysis.kind === 'stable') {
    for (let index = 0; index < analysis.mesh.elements.length; index++) {
      const memberId = analysis.mesh.elements[index]!.memberId;
      axialByMember.set(
        memberId,
        Math.max(
          axialByMember.get(memberId) ?? 0,
          Math.abs(analysis.result.elementForces[index * 5]!),
        ),
      );
    }
  }
  const axialMaximum = Math.max(...axialByMember.values(), 1);
  const envelopeMaximum = momentEnvelope ? Math.max(...momentEnvelope.values(), 1) : 1;

  for (const member of members) {
    const a = nodeById.get(member.a);
    const b = nodeById.get(member.b);
    if (!a || !b) continue;
    const aScreen = toScreen(a);
    const bScreen = toScreen(b);
    context.beginPath();
    context.moveTo(aScreen.x, aScreen.y);
    context.lineTo(bScreen.x, bScreen.y);
    const selected = memberIsSelected(selection, member.id);
    context.strokeStyle = selected
      ? '#2456a4'
      : utilization
        ? stressColor(utilization.get(member.id) ?? 0)
        : deckSet.has(member.id)
          ? '#4d78bb'
          : '#1a1d21';
    const axialWidth = 2 + (2 * (axialByMember.get(member.id) ?? 0)) / axialMaximum;
    context.setLineDash(member.cableOnly ? [5, 4] : []);
    context.lineWidth = selected
      ? axialWidth + 1.5
      : deckSet.has(member.id)
        ? Math.max(3, axialWidth)
        : member.cableOnly
          ? 1.5
          : axialWidth;
    context.stroke();
    context.setLineDash([]);
    const envelope = momentEnvelope?.get(member.id) ?? 0;
    if (envelope > 0) {
      context.beginPath();
      context.moveTo(aScreen.x, aScreen.y);
      context.lineTo(bScreen.x, bScreen.y);
      context.strokeStyle = 'rgba(124, 63, 156, 0.32)';
      context.lineWidth = 2 + (4 * envelope) / envelopeMaximum;
      context.stroke();
    }
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

  if (analysis.kind === 'stable' && showDeformed) drawDeformedShape(context, size, analysis);
  if (analysis.kind === 'stable' && dynamicDisplacement)
    drawDynamicShape(context, size, analysis.mesh, dynamicDisplacement);
  if (analysis.kind === 'stable' && failureCinematic)
    drawFailureCinematic(context, size, analysis.mesh, failureCinematic);
  if (analysis.kind === 'stable' && modeGhost)
    drawModeShape(context, size, analysis.mesh, modeGhost);
  if (analysis.kind === 'stable' && diagram !== 'none')
    drawDiagram(context, nodes, members, toScreen, analysis, diagram);

  for (const load of loads) {
    const node = nodeById.get(load.node);
    if (node) drawLoad(context, toScreen(node), load);
  }
  for (const axle of trafficAxles ?? []) drawTrafficAxle(context, toScreen(axle));
  for (const support of supports) {
    const node = nodeById.get(support.node);
    if (node) drawSupport(context, toScreen(node), support.kind);
  }
  for (const node of nodes) {
    const screen = toScreen(node);
    context.beginPath();
    context.arc(screen.x, screen.y, NODE_RADIUS, 0, Math.PI * 2);
    context.fillStyle =
      stability.kind === 'mechanism' && stability.nodeId === node.id
        ? '#d99018'
        : selection.kind === 'node' && selection.id === node.id
          ? '#2456a4'
          : '#f4f1ea';
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
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, size.height);
    context.stroke();
  }
  for (let y = groundY % spacing; y < size.height; y += spacing) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(size.width, y);
    context.stroke();
  }
  context.beginPath();
  context.moveTo(0, groundY);
  context.lineTo(size.width, groundY);
  context.strokeStyle = '#2456a4';
  context.lineWidth = 1.5;
  context.stroke();
  context.restore();
}

function drawSupport(context: CanvasRenderingContext2D, point: Point, kind: SupportKind): void {
  context.save();
  context.strokeStyle = '#2456a4';
  context.fillStyle = '#f4f1ea';
  context.lineWidth = 1.5;
  if (kind === 'fixed') {
    context.beginPath();
    context.moveTo(point.x - 7, point.y - 13);
    context.lineTo(point.x - 7, point.y + 13);
    context.stroke();
    for (let y = point.y - 11; y < point.y + 12; y += 5) {
      context.beginPath();
      context.moveTo(point.x - 11, y);
      context.lineTo(point.x - 7, y + 4);
      context.stroke();
    }
  } else {
    context.beginPath();
    context.moveTo(point.x - 9, point.y + 13);
    context.lineTo(point.x + 9, point.y + 13);
    context.lineTo(point.x, point.y + 2);
    context.closePath();
    context.fill();
    context.stroke();
    if (kind === 'roller') {
      for (const x of [point.x - 5, point.x + 5]) {
        context.beginPath();
        context.arc(x, point.y + 18, 2.5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
    }
  }
  context.restore();
}

function drawLoad(
  context: CanvasRenderingContext2D,
  point: Point,
  load: { fx: number; fy: number },
): void {
  const magnitude = Math.hypot(load.fx, load.fy) / 1000;
  if (magnitude === 0) return;
  context.save();
  context.strokeStyle = '#c0392b';
  context.fillStyle = '#c0392b';
  context.lineWidth = 1.5;
  const direction =
    Math.abs(load.fy) >= Math.abs(load.fx)
      ? { x: 0, y: load.fy < 0 ? 1 : -1 }
      : { x: load.fx > 0 ? 1 : -1, y: 0 };
  const end = { x: point.x + direction.x * 28, y: point.y + direction.y * 28 };
  context.beginPath();
  context.moveTo(point.x, point.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.beginPath();
  context.moveTo(end.x, end.y);
  context.lineTo(
    end.x - direction.y * 4 - direction.x * 4,
    end.y + direction.x * 4 - direction.y * 4,
  );
  context.lineTo(
    end.x + direction.y * 4 - direction.x * 4,
    end.y - direction.x * 4 - direction.y * 4,
  );
  context.closePath();
  context.fill();
  context.font = '11px IBM Plex Mono, monospace';
  context.fillText(`${magnitude.toFixed(0)} kN`, end.x + 5, end.y + 14);
  context.restore();
}

function drawEmptyState(context: CanvasRenderingContext2D, size: CanvasSize): void {
  context.save();
  context.strokeStyle = 'rgba(26, 29, 33, 0.22)';
  context.lineWidth = 1.5;
  context.setLineDash([4, 5]);
  const cx = size.width / 2;
  const cy = size.height / 2;
  context.beginPath();
  context.moveTo(cx - 100, cy + 45);
  context.lineTo(cx, cy - 40);
  context.lineTo(cx + 100, cy + 45);
  context.moveTo(cx - 55, cy + 45);
  context.lineTo(cx, cy);
  context.lineTo(cx + 55, cy + 45);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = 'rgba(26, 29, 33, 0.55)';
  context.font = '600 15px IBM Plex Sans, sans-serif';
  context.textAlign = 'center';
  context.fillText('Limit State', cx, cy + 72);
  context.fillStyle = 'rgba(26, 29, 33, 0.48)';
  context.font = '13px IBM Plex Sans, sans-serif';
  context.fillText('Draw a member — or open a preset.', cx, cy + 94);
  context.restore();
}

function drawDeformedShape(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  analysis: Extract<StaticAnalysis, { kind: 'stable' }>,
): void {
  const { mesh, result } = analysis;
  const display = deformationDisplay(mesh, result.u, SCALE);
  if (display.maxMeters === 0) return;
  const toScreen = (x: number, y: number): Point => ({
    x: size.width / 2 + x * SCALE,
    y: size.height - 68 - y * SCALE,
  });
  context.save();
  context.strokeStyle = 'rgba(36, 86, 164, 0.76)';
  context.lineWidth = 1.3;
  context.setLineDash([5, 4]);
  for (const element of mesh.elements) {
    const a = toScreen(
      mesh.coords[2 * element.na]! + result.u[3 * element.na]! * display.scale,
      mesh.coords[2 * element.na + 1]! + result.u[3 * element.na + 1]! * display.scale,
    );
    const b = toScreen(
      mesh.coords[2 * element.nb]! + result.u[3 * element.nb]! * display.scale,
      mesh.coords[2 * element.nb + 1]! + result.u[3 * element.nb + 1]! * display.scale,
    );
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  context.restore();
}

/** True Newmark displacement with only the presentation scale amplified. */
function drawDynamicShape(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  mesh: AnalysisMesh,
  u: Float64Array,
): void {
  if (u.length !== mesh.ndof) return;
  const display = deformationDisplay(mesh, u, SCALE);
  if (display.maxMeters === 0) return;
  const toScreen = (x: number, y: number): Point => ({
    x: size.width / 2 + x * SCALE,
    y: size.height - 68 - y * SCALE,
  });
  context.save();
  context.strokeStyle = 'rgba(28, 132, 122, 0.82)';
  context.lineWidth = 1.8;
  context.setLineDash([7, 3]);
  for (const element of mesh.elements) {
    const a = toScreen(
      mesh.coords[2 * element.na]! + u[3 * element.na]! * display.scale,
      mesh.coords[2 * element.na + 1]! + u[3 * element.na + 1]! * display.scale,
    );
    const b = toScreen(
      mesh.coords[2 * element.nb]! + u[3 * element.nb]! * display.scale,
      mesh.coords[2 * element.nb + 1]! + u[3 * element.nb + 1]! * display.scale,
    );
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  context.restore();
}

/** Illustrative failure playback derived from the computed first-limit displacement. */
function drawFailureCinematic(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  mesh: AnalysisMesh,
  cinematic: FailureCinematic,
): void {
  if (cinematic.u.length !== mesh.ndof) return;
  const display = deformationDisplay(mesh, cinematic.u, SCALE);
  if (display.maxMeters === 0) return;
  const amplitude = cinematic.reducedMotion ? 1 : 0.25 + cinematic.phase * 0.75;
  const toScreen = (x: number, y: number): Point => ({
    x: size.width / 2 + x * SCALE,
    y: size.height - 68 - y * SCALE,
  });
  context.save();
  context.strokeStyle = 'rgba(192, 57, 43, 0.88)';
  context.lineWidth = 2.4;
  context.setLineDash(cinematic.reducedMotion ? [] : [8, 3]);
  for (const element of mesh.elements) {
    const a = toScreen(
      mesh.coords[2 * element.na]! + cinematic.u[3 * element.na]! * display.scale * amplitude,
      mesh.coords[2 * element.na + 1]! +
        cinematic.u[3 * element.na + 1]! * display.scale * amplitude,
    );
    const b = toScreen(
      mesh.coords[2 * element.nb]! + cinematic.u[3 * element.nb]! * display.scale * amplitude,
      mesh.coords[2 * element.nb + 1]! +
        cinematic.u[3 * element.nb + 1]! * display.scale * amplitude,
    );
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  if (cinematic.reducedMotion) drawFailureArrow(context, size, mesh, cinematic.u, display.scale);
  context.restore();
}

function drawFailureArrow(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  mesh: AnalysisMesh,
  u: Float64Array,
  scale: number,
): void {
  let node = -1;
  let maximum = 0;
  for (let index = 0; index < mesh.coords.length / 2; index++) {
    const magnitude = Math.hypot(u[3 * index]!, u[3 * index + 1]!);
    if (magnitude > maximum) {
      maximum = magnitude;
      node = index;
    }
  }
  if (node < 0 || maximum === 0) return;
  const start = {
    x: size.width / 2 + mesh.coords[2 * node]! * SCALE,
    y: size.height - 68 - mesh.coords[2 * node + 1]! * SCALE,
  };
  const end = {
    x: start.x + u[3 * node]! * scale * SCALE,
    y: start.y - u[3 * node + 1]! * scale * SCALE,
  };
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.beginPath();
  context.moveTo(end.x, end.y);
  context.lineTo(
    end.x - 7 * Math.cos(angle - Math.PI / 6),
    end.y - 7 * Math.sin(angle - Math.PI / 6),
  );
  context.lineTo(
    end.x - 7 * Math.cos(angle + Math.PI / 6),
    end.y - 7 * Math.sin(angle + Math.PI / 6),
  );
  context.closePath();
  context.fillStyle = 'rgba(192, 57, 43, 0.88)';
  context.fill();
}

function drawTrafficAxle(context: CanvasRenderingContext2D, point: Point): void {
  context.save();
  context.fillStyle = '#c0392b';
  context.strokeStyle = '#7d251d';
  context.lineWidth = 1;
  context.fillRect(point.x - 8, point.y - 15, 16, 8);
  context.beginPath();
  context.arc(point.x - 5, point.y - 5, 2.5, 0, Math.PI * 2);
  context.arc(point.x + 5, point.y - 5, 2.5, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

/** Normalized modal/buckling ghost; it is never presented as a true displacement. */
function drawModeShape(
  context: CanvasRenderingContext2D,
  size: CanvasSize,
  mesh: AnalysisMesh,
  ghost: ModeGhost,
): void {
  const modeCount = ghost.vectors.length / mesh.ndof;
  if (!Number.isInteger(modeCount) || ghost.mode < 0 || ghost.mode >= modeCount) return;
  let maximum = 0;
  for (let node = 0; node < mesh.coords.length / 2; node++) {
    const offset = 3 * node * modeCount + ghost.mode;
    maximum = Math.max(
      maximum,
      Math.hypot(ghost.vectors[offset]!, ghost.vectors[offset + modeCount]!),
    );
  }
  if (maximum === 0) return;
  const scale = 28 / SCALE / maximum;
  const toScreen = (x: number, y: number): Point => ({
    x: size.width / 2 + x * SCALE,
    y: size.height - 68 - y * SCALE,
  });
  context.save();
  context.strokeStyle = 'rgba(124, 63, 156, 0.78)';
  context.lineWidth = 1.4;
  context.setLineDash([2, 3]);
  for (const element of mesh.elements) {
    const aOffset = 3 * element.na * modeCount + ghost.mode;
    const bOffset = 3 * element.nb * modeCount + ghost.mode;
    const a = toScreen(
      mesh.coords[2 * element.na]! + ghost.vectors[aOffset]! * scale * ghost.phase,
      mesh.coords[2 * element.na + 1]! + ghost.vectors[aOffset + modeCount]! * scale * ghost.phase,
    );
    const b = toScreen(
      mesh.coords[2 * element.nb]! + ghost.vectors[bOffset]! * scale * ghost.phase,
      mesh.coords[2 * element.nb + 1]! + ghost.vectors[bOffset + modeCount]! * scale * ghost.phase,
    );
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  context.restore();
}

function drawDiagram(
  context: CanvasRenderingContext2D,
  nodes: NodeSpec[],
  members: MemberSpec[],
  toScreen: (point: Point) => Point,
  analysis: Extract<StaticAnalysis, { kind: 'stable' }>,
  diagram: Exclude<ResultDiagram, 'none'>,
): void {
  // Sampling lives in diagram-samples.ts so it stays pure and unit-testable;
  // here the model-space ordinates are only mapped to screen.
  const sampling = sampleDiagram(members, analysis, diagram);
  const maximum = sampling.maximum;
  const samplesByMember = new Map<number, { point: Point; value: number }[]>();
  for (const [memberId, modelSamples] of sampling.byMember) {
    samplesByMember.set(
      memberId,
      modelSamples.map((sample) => ({ point: toScreen(sample.point), value: sample.value })),
    );
  }
  const label = diagram === 'axial' ? 'N' : diagram === 'shear' ? 'V' : 'M';
  context.save();
  context.strokeStyle = 'rgba(36, 86, 164, 0.82)';
  context.fillStyle = 'rgba(36, 86, 164, 0.11)';
  context.lineWidth = 1;
  context.font = '10px IBM Plex Mono, monospace';
  for (const member of members) {
    const a = nodes.find((node) => node.id === member.a);
    const b = nodes.find((node) => node.id === member.b);
    if (!a || !b) continue;
    const from = toScreen(a);
    const to = toScreen(b);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const normal = { x: -dy / length, y: dx / length };
    const samples = samplesByMember.get(member.id) ?? [];
    if (samples.length < 2) continue;
    const peak = samples.reduce(
      (best, sample) => (Math.abs(sample.value) > Math.abs(best) ? sample.value : best),
      0,
    );
    context.beginPath();
    context.moveTo(from.x, from.y);
    for (const sample of samples) {
      const height = (34 * sample.value) / maximum;
      context.lineTo(sample.point.x + normal.x * height, sample.point.y + normal.y * height);
    }
    context.lineTo(to.x, to.y);
    context.closePath();
    context.fill();
    context.stroke();
    context.save();
    context.clip();
    context.strokeStyle = 'rgba(36, 86, 164, 0.42)';
    context.lineWidth = 0.7;
    const minX = Math.min(...samples.map((sample) => sample.point.x), from.x, to.x) - 36;
    const maxX = Math.max(...samples.map((sample) => sample.point.x), from.x, to.x) + 36;
    const minY = Math.min(...samples.map((sample) => sample.point.y), from.y, to.y) - 36;
    const maxY = Math.max(...samples.map((sample) => sample.point.y), from.y, to.y) + 36;
    for (let x = minX - (maxY - minY); x < maxX + (maxY - minY); x += 6) {
      context.beginPath();
      context.moveTo(x, maxY);
      context.lineTo(x + (maxY - minY), minY);
      context.stroke();
    }
    context.restore();
    const midSample = samples[Math.floor(samples.length / 2)]!;
    const midHeight = (34 * midSample.value) / maximum;
    const mid = {
      x: midSample.point.x + normal.x * midHeight,
      y: midSample.point.y + normal.y * midHeight,
    };
    context.fillStyle = '#2456a4';
    context.fillText(`${label} ${(peak / 1000).toFixed(1)} k`, mid.x + 3, mid.y - 3);
    context.fillStyle = 'rgba(36, 86, 164, 0.11)';
  }
  context.restore();
}

function stressColor(utilization: number): string {
  const t = Math.max(0, Math.min(1, utilization));
  if (t <= 0.5) return blend('#2456a4', '#f4f1ea', t * 2);
  return blend('#f4f1ea', '#c0392b', (t - 0.5) * 2);
}

function blend(from: string, to: string, amount: number): string {
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const channel = (shift: number) =>
    Math.round(((a >> shift) & 0xff) * (1 - amount) + ((b >> shift) & 0xff) * amount);
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function projectToSegment(point: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { ...a };
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function memberIsSelected(selection: Selection, id: number): boolean {
  return selection.kind === 'member'
    ? selection.id === id
    : selection.kind === 'members' && selection.ids.includes(id);
}

function snap(value: number): number {
  return Math.round(value * 2) / 2;
}
