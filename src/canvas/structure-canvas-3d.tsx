/**
 * Phase 3 WebGL structure viewer. Orbit/pan, member LOD (lines ↔ cylinders with
 * hysteresis), stress color/width, deformed shape, mode ghosts.
 */
'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  deformationDisplay3d,
  type AnalysisMesh3d,
  type EditorModel3d,
  type StaticAnalysis3d,
  type SupportKind3d,
} from '../fem/space';
import type { EigenResult } from '../fem/types';
import { projectPointToFrame, resolveWorkplaneFrame, type WorkplaneSpec } from '../state/workplane';

const PAPER = 0xf4f1ea;
const INK = 0x1a1d21;
const BLUE = 0x2456a4;
/** LOD hysteresis. Far → lines; near → extruded cylinders. */
const LOD_ENTER_LINES = 42;
const LOD_EXIT_LINES = 28;
/** Force line LOD above this member count (rebuild cost + fill rate). */
const FORCE_LINES_AT_MEMBERS = 64;
/** Shared unit cylinder (scale radius/length per member). */
const UNIT_CYLINDER = new THREE.CylinderGeometry(1, 1, 1, 6, 1);

export interface StructureCanvas3dProps {
  model: EditorModel3d;
  analysis: StaticAnalysis3d;
  showDeformed: boolean;
  modeGhost?: { result: EigenResult; mode: number; phase: number };
  /** Live Newmark / traffic displacement (6 DOF/node). */
  dynamicDisplacement?: Float64Array;
  /** Traffic axle markers along the deck polyline. */
  trafficAxles?: Array<{ x: number; y: number; z: number }>;
  /** When set, left-click raycasts to the workplane and reports the hit. */
  workplane?: import('../state/workplane').WorkplaneSpec | 'ground' | 'xz' | 'yz';
  onWorkplaneClick?: (
    point: { x: number; y: number; z: number },
    hitNodeId: number | null,
    hitMemberId: number | null,
  ) => void;
  selectedNodeId?: number | null;
  selectedMemberId?: number | null;
}

export function StructureCanvas3d({
  model,
  analysis,
  showDeformed,
  modeGhost,
  dynamicDisplacement,
  trafficAxles,
  workplane = 'ground',
  onWorkplaneClick,
  selectedNodeId,
  selectedMemberId,
}: StructureCanvas3dProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef({
    model,
    analysis,
    showDeformed,
    modeGhost,
    dynamicDisplacement,
    trafficAxles,
    workplane,
    onWorkplaneClick,
    selectedNodeId,
    selectedMemberId,
  });
  propsRef.current = {
    model,
    analysis,
    showDeformed,
    modeGhost,
    dynamicDisplacement,
    trafficAxles,
    workplane,
    onWorkplaneClick,
    selectedNodeId,
    selectedMemberId,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(PAPER);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 500);
    camera.position.set(14, -18, 12);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(renderer.domElement);
    renderer.domElement.className = 'structure-canvas structure-canvas-3d';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.display = 'block';

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(4, 2, 3);

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const key = new THREE.DirectionalLight(0xffffff, 0.55);
    key.position.set(8, -12, 20);
    scene.add(key);

    const ground = new THREE.GridHelper(40, 40, 0xd5d0c6, 0xe8e4db);
    ground.rotation.x = Math.PI / 2;
    scene.add(ground);

    const structure = new THREE.Group();
    const ghostGroup = new THREE.Group();
    scene.add(structure, ghostGroup);

    let lastSignature = '';
    let lastLodLines = camera.position.distanceTo(controls.target) > LOD_ENTER_LINES;
    let lastGhostKey = '';
    let frame = 0;
    const emptyGhost = buildEmptyGhost();
    scene.add(emptyGhost);

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const workplaneMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    );
    // Ground = XY (z=0) in Z-up → plane facing +Z is default PlaneGeometry in XY.
    scene.add(workplaneMesh);

    const onPointerDown = (event: PointerEvent) => {
      const handler = propsRef.current.onWorkplaneClick;
      if (!handler || event.button !== 0) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      // Prefer node picks within a small screen radius via world distance.
      const props = propsRef.current;
      let hitNode: number | null = null;
      let best = 0.45;
      for (const node of props.model.nodes) {
        const dist = raycaster.ray.distanceToPoint(new THREE.Vector3(node.x, node.y, node.z));
        if (dist < best) {
          best = dist;
          hitNode = node.id;
        }
      }

      let hitMember: number | null = null;
      let bestMember = 0.55;
      const nodePos = new Map(props.model.nodes.map((n) => [n.id, new THREE.Vector3(n.x, n.y, n.z)]));
      for (const member of props.model.members) {
        const a = nodePos.get(member.a);
        const b = nodePos.get(member.b);
        if (!a || !b) continue;
        const dist = distanceRayToSegment(raycaster.ray, a, b);
        if (dist < bestMember) {
          bestMember = dist;
          hitMember = member.id;
        }
      }

      const planeSpec: WorkplaneSpec =
        typeof props.workplane === 'string' || !props.workplane
          ? { kind: (props.workplane as 'ground' | 'xz' | 'yz' | undefined) ?? 'ground' }
          : props.workplane;
      const frame = resolveWorkplaneFrame(planeSpec);
      workplaneMesh.position.set(frame.origin.x, frame.origin.y, frame.origin.z);
      const xAxis = new THREE.Vector3(frame.u.x, frame.u.y, frame.u.z);
      const yAxis = new THREE.Vector3(frame.v.x, frame.v.y, frame.v.z);
      const zAxis = new THREE.Vector3(frame.n.x, frame.n.y, frame.n.z);
      workplaneMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
      workplaneMesh.updateMatrixWorld(true);
      const hits = raycaster.intersectObject(workplaneMesh);
      const hit = hits[0];
      if (!hit && hitNode === null && hitMember === null) return;
      const point = hit
        ? { x: hit.point.x, y: hit.point.y, z: hit.point.z }
        : hitNode !== null
          ? props.model.nodes.find((n) => n.id === hitNode)!
          : (() => {
              const m = props.model.members.find((member) => member.id === hitMember)!;
              const a = props.model.nodes.find((n) => n.id === m.a)!;
              const b = props.model.nodes.find((n) => n.id === m.b)!;
              return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
            })();
      handler(projectPointToFrame(point, frame), hitNode, hitMember);
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const props = propsRef.current;
      const dist = camera.position.distanceTo(controls.target);
      const forceLines = props.model.members.length >= FORCE_LINES_AT_MEMBERS;
      // Hysteresis: once in line mode, stay until closer than EXIT; once extruded, stay until farther than ENTER.
      let lodLines = lastLodLines;
      if (forceLines) lodLines = true;
      else if (lastLodLines && dist < LOD_EXIT_LINES) lodLines = false;
      else if (!lastLodLines && dist > LOD_ENTER_LINES) lodLines = true;
      const signature = sceneSignature(props);
      if (signature !== lastSignature || lodLines !== lastLodLines) {
        lastSignature = signature;
        lastLodLines = lodLines;
        rebuildStructure(structure, props, lodLines);
      }
      emptyGhost.visible = props.model.members.length === 0;
      const ghostKey = ghostTopologyKey(props);
      if (ghostKey !== lastGhostKey) {
        lastGhostKey = ghostKey;
        rebuildGhost(ghostGroup, props);
      } else {
        updateGhostPhase(ghostGroup, props);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      controls.dispose();
      disposeObject(structure);
      disposeObject(ghostGroup);
      scene.remove(emptyGhost);
      disposeObject(emptyGhost);
      workplaneMesh.geometry.dispose();
      (workplaneMesh.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={hostRef} className="structure-canvas-3d-host" aria-label="3D structure viewport" />;
}

/** Faint space-portal sketch for empty 3D canvas. */
function buildEmptyGhost(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.LineDashedMaterial({ color: INK, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.28 });
  const pts: Array<[number, number, number]> = [
    [0, 0, 0], [8, 0, 0], [0, 0, 6], [8, 0, 6],
  ];
  const segs: Array<[number, number]> = [[0, 2], [1, 3], [2, 3]];
  for (const [i, j] of segs) {
    const a = new THREE.Vector3(...pts[i]!);
    const b = new THREE.Vector3(...pts[j]!);
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(geo, mat.clone());
    line.computeLineDistances();
    g.add(line);
  }
  return g;
}

function ghostTopologyKey(props: StructureCanvas3dProps): string {
  const { analysis, modeGhost } = props;
  if (!modeGhost || analysis.kind !== 'stable') return 'none';
  return `${analysis.mesh.elements.length}|${modeGhost.mode}|${modeGhost.result.values.length}|${modeGhost.result.iterations}`;
}

function sceneSignature(props: StructureCanvas3dProps): string {
  const { model, analysis, showDeformed, selectedNodeId, selectedMemberId, dynamicDisplacement, trafficAxles } = props;
  const uMax = analysis.kind === 'stable' ? analysis.result.utilization.size : -1;
  const kind = analysis.kind;
  const dyn = dynamicDisplacement
    ? `${dynamicDisplacement.length}:${dynamicDisplacement[0]?.toFixed(6)}:${dynamicDisplacement[Math.floor(dynamicDisplacement.length / 2)]?.toFixed(6)}`
    : 'none';
  const story = model.story?.kind ?? 'nostory';
  const deck = (model.deck ?? []).join(',');
  const axles = trafficAxles?.map((a) => `${a.x.toFixed(2)},${a.z.toFixed(2)}`).join(';') ?? '';
  return `${model.name}|${model.members.length}|${model.nodes.length}|${model.supports.length}|${model.loads.points.length}|${kind}|${uMax}|${showDeformed}|${selectedNodeId}|${selectedMemberId}|${dyn}|${story}|${deck}|${axles}`;
}

function rebuildStructure(root: THREE.Group, props: StructureCanvas3dProps, useLines: boolean): void {
  disposeObject(root);
  while (root.children.length) root.remove(root.children[0]!);

  const { model, analysis, showDeformed, selectedNodeId } = props;
  const nodePos = new Map(model.nodes.map((n) => [n.id, new THREE.Vector3(n.x, n.y, n.z)]));

  for (const support of model.supports) {
    const p = nodePos.get(support.node);
    if (p) root.add(supportGlyph(p, support.kind));
  }

  for (const node of model.nodes) {
    const selected = selectedNodeId === node.id;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(selected ? 0.16 : 0.12, 8, 6),
      new THREE.MeshStandardMaterial({ color: selected ? BLUE : INK, roughness: 0.7 }),
    );
    mesh.position.set(node.x, node.y, node.z);
    root.add(mesh);
  }

  for (const load of model.loads.points) {
    const p = nodePos.get(load.node);
    if (!p) continue;
    const dir = new THREE.Vector3(load.fx, load.fy, load.fz);
    if (dir.lengthSq() < 1e-12) continue;
    root.add(loadArrow(p, dir.normalize()));
  }

  const utilization = analysis.kind === 'stable' ? analysis.result.utilization : undefined;
  const elementForces = analysis.kind === 'stable' ? analysis.result.elementForces : undefined;
  const mesh3 = analysis.kind === 'stable' ? analysis.mesh : undefined;

  let maxAxial = 1e-9;
  if (mesh3 && elementForces) {
    for (let i = 0; i < mesh3.elements.length; i++) maxAxial = Math.max(maxAxial, Math.abs(elementForces[i * 12]!));
  }

  for (const member of model.members) {
    const a = nodePos.get(member.a);
    const b = nodePos.get(member.b);
    if (!a || !b) continue;
    const onDeck = (model.deck ?? []).includes(member.id);
    const color = onDeck ? BLUE : stressColorHex(utilization?.get(member.id) ?? 0);
    const axial = memberAxial(member.id, mesh3, elementForces);
    const width = (onDeck ? 0.07 : 0.04) + 0.1 * Math.min(1, Math.abs(axial) / maxAxial);
    root.add(memberVisual(a, b, color, width, useLines));
  }

  for (const axle of props.trafficAxles ?? []) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.28, 14, 12),
      new THREE.MeshStandardMaterial({ color: BLUE, roughness: 0.45, metalness: 0.1 }),
    );
    mesh.position.set(axle.x, axle.y, axle.z + 0.35);
    root.add(mesh);
  }

  if (showDeformed && analysis.kind === 'stable') {
    const u = props.dynamicDisplacement && props.dynamicDisplacement.length === analysis.mesh.ndof
      ? props.dynamicDisplacement
      : analysis.result.u;
    const display = deformationDisplay3d(analysis.mesh, u, 44);
    if (display.maxMeters > 0) {
      for (const element of analysis.mesh.elements) {
        const pa = deformedPoint(analysis.mesh.coords, u, element.na, display.scale);
        const pb = deformedPoint(analysis.mesh.coords, u, element.nb, display.scale);
        root.add(memberVisual(pa, pb, BLUE, 0.035, true, 0.75, true));
      }
    }
  }
}

function rebuildGhost(root: THREE.Group, props: StructureCanvas3dProps): void {
  disposeObject(root);
  while (root.children.length) root.remove(root.children[0]!);
  const { analysis, modeGhost } = props;
  if (!modeGhost || analysis.kind !== 'stable') return;
  const { result, mode, phase } = modeGhost;
  const nModes = result.values.length;
  if (!(mode >= 0 && mode < nModes)) return;
  const amp = 1.2;
  const ndof = analysis.mesh.ndof;
  const maxComp = modeMaxComponent(result.vectors, ndof, nModes, mode);
  const inv = maxComp > 0 ? amp / maxComp : 0;
  for (let ei = 0; ei < analysis.mesh.elements.length; ei++) {
    const element = analysis.mesh.elements[ei]!;
    const pa = modePoint(analysis.mesh.coords, result.vectors, nModes, element.na, mode, phase * inv);
    const pb = modePoint(analysis.mesh.coords, result.vectors, nModes, element.nb, mode, phase * inv);
    const line = memberVisual(pa, pb, 0x7c3f9c, 0.03, true, 0.65, true);
    line.userData = { na: element.na, nb: element.nb, inv };
    root.add(line);
  }
}

/** Update ghost line endpoints for the current phase without reallocating. */
function updateGhostPhase(root: THREE.Group, props: StructureCanvas3dProps): void {
  const { analysis, modeGhost } = props;
  if (!modeGhost || analysis.kind !== 'stable' || root.children.length === 0) return;
  const { result, mode, phase } = modeGhost;
  const nModes = result.values.length;
  for (const child of root.children) {
    const { na, nb, inv } = child.userData as { na: number; nb: number; inv: number };
    const pa = modePoint(analysis.mesh.coords, result.vectors, nModes, na, mode, phase * inv);
    const pb = modePoint(analysis.mesh.coords, result.vectors, nModes, nb, mode, phase * inv);
    const line = child as THREE.Line;
    const pos = line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, pa.x, pa.y, pa.z);
    pos.setXYZ(1, pb.x, pb.y, pb.z);
    pos.needsUpdate = true;
    if (line.computeLineDistances) line.computeLineDistances();
  }
}

function memberAxial(memberId: number, mesh: AnalysisMesh3d | undefined, forces: Float64Array | undefined): number {
  if (!mesh || !forces) return 0;
  let max = 0;
  for (let i = 0; i < mesh.elements.length; i++) {
    if (mesh.elements[i]!.memberId !== memberId) continue;
    max = Math.max(max, Math.abs(forces[i * 12]!));
  }
  return max;
}

function deformedPoint(coords: Float64Array, u: Float64Array, node: number, scale: number): THREE.Vector3 {
  return new THREE.Vector3(
    coords[3 * node]! + scale * u[6 * node]!,
    coords[3 * node + 1]! + scale * u[6 * node + 1]!,
    coords[3 * node + 2]! + scale * u[6 * node + 2]!,
  );
}

function modeMaxComponent(vectors: Float64Array, ndof: number, nModes: number, mode: number): number {
  let maxComp = 0;
  for (let i = 0; i < ndof; i++) maxComp = Math.max(maxComp, Math.abs(vectors[i * nModes + mode]!));
  return maxComp;
}

function modePoint(
  coords: Float64Array,
  vectors: Float64Array,
  nModes: number,
  node: number,
  mode: number,
  scale: number,
): THREE.Vector3 {
  return new THREE.Vector3(
    coords[3 * node]! + scale * vectors[6 * node * nModes + mode]!,
    coords[3 * node + 1]! + scale * vectors[(6 * node + 1) * nModes + mode]!,
    coords[3 * node + 2]! + scale * vectors[(6 * node + 2) * nModes + mode]!,
  );
}

function memberVisual(
  a: THREE.Vector3,
  b: THREE.Vector3,
  color: number,
  radius: number,
  asLine: boolean,
  opacity = 1,
  dashed = false,
): THREE.Object3D {
  if (asLine || dashed) {
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 0.25, gapSize: 0.15, transparent: opacity < 1, opacity })
      : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    return line;
  }
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (!(len > 0)) return new THREE.Group();
  const cyl = new THREE.Mesh(
    UNIT_CYLINDER,
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, transparent: opacity < 1, opacity }),
  );
  cyl.scale.set(radius, len, radius);
  cyl.position.copy(a).add(b).multiplyScalar(0.5);
  cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  // Shared geometry — do not dispose on rebuild.
  cyl.userData.sharedGeometry = true;
  return cyl;
}

function supportGlyph(at: THREE.Vector3, kind: SupportKind3d): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: INK, roughness: 0.8 });
  if (kind === 'fixed') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.18), mat);
    box.position.copy(at).add(new THREE.Vector3(0, 0, -0.12));
    g.add(box);
  } else {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.4, 3), mat);
    cone.rotation.x = Math.PI;
    cone.position.copy(at).add(new THREE.Vector3(0, 0, -0.22));
    g.add(cone);
  }
  return g;
}

function loadArrow(at: THREE.Vector3, dir: THREE.Vector3): THREE.Object3D {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.6 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6), mat);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 8), mat);
  shaft.position.set(0, 0.45, 0);
  tip.position.set(0, 1.05, 0);
  g.add(shaft, tip);
  g.position.copy(at);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return g;
}

function stressColorHex(utilization: number): number {
  const t = Math.max(0, Math.min(1, utilization));
  const mix = (a: number, b: number, u: number) => {
    const ar = (a >> 16) & 0xff;
    const ag = (a >> 8) & 0xff;
    const ab = a & 0xff;
    const br = (b >> 16) & 0xff;
    const bg = (b >> 8) & 0xff;
    const bb = b & 0xff;
    const r = Math.round(ar * (1 - u) + br * u);
    const g = Math.round(ag * (1 - u) + bg * u);
    const bl = Math.round(ab * (1 - u) + bb * u);
    return (r << 16) | (g << 8) | bl;
  };
  if (t <= 0.5) return mix(0x2456a4, 0xf4f1ea, t * 2);
  return mix(0xf4f1ea, 0xc0392b, (t - 0.5) * 2);
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry && !mesh.userData.sharedGeometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
}

/** Closest distance from a ray to a finite segment AB. */
function distanceRayToSegment(ray: THREE.Ray, a: THREE.Vector3, b: THREE.Vector3): number {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (!(len > 1e-12)) return ray.distanceToPoint(a);
  dir.multiplyScalar(1 / len);
  // Closest points between skew lines (ray infinite, then clamp to segment).
  const cross = new THREE.Vector3().crossVectors(ray.direction, dir);
  const denom = cross.lengthSq();
  if (denom < 1e-14) {
    // Nearly parallel — sample segment endpoints + projection of origin.
    return Math.min(ray.distanceToPoint(a), ray.distanceToPoint(b));
  }
  const diff = new THREE.Vector3().subVectors(a, ray.origin);
  const t = new THREE.Vector3().crossVectors(diff, dir).dot(cross) / denom;
  const s = new THREE.Vector3().crossVectors(diff, ray.direction).dot(cross) / denom;
  const clampedS = Math.max(0, Math.min(len, s));
  const pointOnRay = ray.origin.clone().addScaledVector(ray.direction, Math.max(0, t));
  const pointOnSeg = a.clone().addScaledVector(dir, clampedS);
  return pointOnRay.distanceTo(pointOnSeg);
}
