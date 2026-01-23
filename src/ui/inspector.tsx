'use client';

import { MATERIALS, sectionProps } from '../fem/materials';
import type { MemberSpec, SectionSpec, SupportKind } from '../fem/types';
import { defaultSection, useEditorStore } from '../state/editor-store';

const SUPPORT_OPTIONS: Array<{ value: SupportKind | 'none'; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'pin', label: 'Pin' },
  { value: 'roller', label: 'Roller' },
  { value: 'fixed', label: 'Fixed' },
];

export function Inspector(): React.JSX.Element {
  const model = useEditorStore((state) => state.model);
  const selection = useEditorStore((state) => state.selection);
  const stability = useEditorStore((state) => state.stability);
  const updateNode = useEditorStore((state) => state.updateNode);
  const setSupport = useEditorStore((state) => state.setSupport);
  const setPointLoad = useEditorStore((state) => state.setPointLoad);
  const deleteNode = useEditorStore((state) => state.deleteNode);

  if (selection.kind === 'node') {
    const node = model.nodes.find((candidate) => candidate.id === selection.id);
    if (node) {
      const support = model.supports.find((candidate) => candidate.node === node.id)?.kind ?? 'none';
      const point = model.loads.points.find((candidate) => candidate.node === node.id) ?? { node: node.id, fx: 0, fy: 0 };
      return (
        <aside className="inspector" aria-label="Node inspector">
          <PanelHeading eyebrow={`Node ${node.id}`} title="Position & support" />
          <NumberField label="X" value={node.x} unit="m" onChange={(x) => updateNode(node.id, x, node.y)} />
          <NumberField label="Y" value={node.y} unit="m" onChange={(y) => updateNode(node.id, node.x, y)} />
          <label className="field">
            <span>Support</span>
            <select value={support} onChange={(event) => setSupport(node.id, event.target.value === 'none' ? undefined : event.target.value as SupportKind)}>
              {SUPPORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <div className="inspector-rule" />
          <PanelHeading eyebrow="Nodal load" title="Applied force" />
          <NumberField label="Horizontal" value={point.fx / 1000} unit="kN" onChange={(fx) => setPointLoad(node.id, fx * 1000, point.fy)} />
          <NumberField label="Vertical" value={point.fy / 1000} unit="kN" onChange={(fy) => setPointLoad(node.id, point.fx, fy * 1000)} />
          <button className="danger-button" type="button" onClick={() => deleteNode(node.id)}>Delete node</button>
        </aside>
      );
    }
  }

  if (selection.kind === 'member') {
    const member = model.members.find((candidate) => candidate.id === selection.id);
    if (member) {
      return <MemberInspector member={member} />;
    }
  }

  if (selection.kind === 'members') {
    const members = model.members.filter((candidate) => selection.ids.includes(candidate.id));
    if (members.length > 1) return <BulkMemberInspector members={members} />;
  }

  return (
    <aside className="inspector inspector-empty" aria-label="Model inspector">
      <PanelHeading eyebrow="Model" title="Build deliberately" />
      <p>Select a node or member to inspect it. Start by placing nodes, then draw members between them.</p>
      <StabilityStatus kind={stability.kind} message={stability.message} />
      <div className="key-hints">
        <span><kbd>N</kbd> node</span>
        <span><kbd>M</kbd> member</span>
        <span><kbd>S</kbd> support</span>
        <span><kbd>L</kbd> load</span>
      </div>
    </aside>
  );
}

function MemberInspector({ member }: { member: MemberSpec }): React.JSX.Element {
  const model = useEditorStore((state) => state.model);
  const updateMember = useEditorStore((state) => state.updateMember);
  const deleteMember = useEditorStore((state) => state.deleteMember);
  const a = model.nodes.find((node) => node.id === member.a);
  const b = model.nodes.find((node) => node.id === member.b);
  const material = MATERIALS[member.material];
  const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  const props = sectionProps(member.section);
  const tonnes = (material.rho * props.A * length) / 1000;

  return (
    <aside className="inspector" aria-label="Member inspector">
      <PanelHeading eyebrow={`Member ${member.id}`} title="Material & section" />
      <label className="field">
        <span>Material</span>
        <select value={member.material} onChange={(event) => updateMember(member.id, { material: event.target.value as MemberSpec['material'] })}>
          {Object.values(MATERIALS).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Section</span>
        <select value={member.section.kind} onChange={(event) => updateMember(member.id, { section: defaultSection(event.target.value as SectionSpec['kind']) })}>
          <option value="rect">Solid rectangle</option>
          <option value="box">Box</option>
          <option value="ibeam">I-beam</option>
          <option value="tube">Tube</option>
        </select>
      </label>
      <SectionFields section={member.section} onChange={(section) => updateMember(member.id, { section })} />
      <div className="member-stats">
        <span>Length <b>{length.toFixed(2)} m</b></span>
        <span>Mass <b>{tonnes.toFixed(3)} t</b></span>
      </div>
      <div className="release-fields">
        <label><input type="checkbox" checked={member.releaseA} disabled={member.cableOnly} onChange={(event) => updateMember(member.id, { releaseA: event.target.checked })} /> Release A</label>
        <label><input type="checkbox" checked={member.releaseB} disabled={member.cableOnly} onChange={(event) => updateMember(member.id, { releaseB: event.target.checked })} /> Release B</label>
        <label><input type="checkbox" checked={member.cableOnly} onChange={(event) => updateMember(member.id, { cableOnly: event.target.checked })} /> Tension-only cable</label>
      </div>
      <button className="danger-button" type="button" onClick={() => deleteMember(member.id)}>Delete member</button>
    </aside>
  );
}

function BulkMemberInspector({ members }: { members: MemberSpec[] }): React.JSX.Element {
  const updateMembers = useEditorStore((state) => state.updateMembers);
  const ids = members.map((member) => member.id);
  const sharedMaterial = members.every((member) => member.material === members[0]!.material) ? members[0]!.material : '';
  const sharedSection = members.every((member) => member.section.kind === members[0]!.section.kind) ? members[0]!.section.kind : '';
  return <aside className="inspector" aria-label="Bulk member inspector">
    <PanelHeading eyebrow={`${members.length} members`} title="Bulk section assignment" />
    <p>Shift-click members in Select mode to add or remove them from this assignment.</p>
    <label className="field">
      <span>Material</span>
      <select value={sharedMaterial} onChange={(event) => updateMembers(ids, { material: event.target.value as MemberSpec['material'] })}>
        {!sharedMaterial && <option value="" disabled>Mixed — choose material</option>}
        {Object.values(MATERIALS).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
      </select>
    </label>
    <label className="field">
      <span>Section</span>
      <select value={sharedSection} onChange={(event) => updateMembers(ids, { section: defaultSection(event.target.value as SectionSpec['kind']) })}>
        {!sharedSection && <option value="" disabled>Mixed — choose section</option>}
        <option value="rect">Solid rectangle</option>
        <option value="box">Box</option>
        <option value="ibeam">I-beam</option>
        <option value="tube">Tube</option>
      </select>
    </label>
  </aside>;
}

function SectionFields({ section, onChange }: { section: SectionSpec; onChange: (section: SectionSpec) => void }): React.JSX.Element {
  switch (section.kind) {
    case 'rect':
      return <div className="field-grid"><NumberField label="b" value={section.b * 1000} unit="mm" onChange={(b) => onChange({ ...section, b: b / 1000 })} /><NumberField label="h" value={section.h * 1000} unit="mm" onChange={(h) => onChange({ ...section, h: h / 1000 })} /></div>;
    case 'box':
      return <div className="field-grid"><NumberField label="b" value={section.b * 1000} unit="mm" onChange={(b) => onChange({ ...section, b: b / 1000 })} /><NumberField label="h" value={section.h * 1000} unit="mm" onChange={(h) => onChange({ ...section, h: h / 1000 })} /><NumberField label="t" value={section.t * 1000} unit="mm" onChange={(t) => onChange({ ...section, t: t / 1000 })} /></div>;
    case 'ibeam':
      return <div className="field-grid"><NumberField label="b" value={section.b * 1000} unit="mm" onChange={(b) => onChange({ ...section, b: b / 1000 })} /><NumberField label="h" value={section.h * 1000} unit="mm" onChange={(h) => onChange({ ...section, h: h / 1000 })} /><NumberField label="flange" value={section.tf * 1000} unit="mm" onChange={(tf) => onChange({ ...section, tf: tf / 1000 })} /><NumberField label="web" value={section.tw * 1000} unit="mm" onChange={(tw) => onChange({ ...section, tw: tw / 1000 })} /></div>;
    case 'tube':
      return <div className="field-grid"><NumberField label="diameter" value={section.d * 1000} unit="mm" onChange={(d) => onChange({ ...section, d: d / 1000 })} /><NumberField label="wall" value={section.t * 1000} unit="mm" onChange={(t) => onChange({ ...section, t: t / 1000 })} /></div>;
  }
}

function NumberField({ label, value, unit, onChange }: { label: string; value: number; unit: string; onChange: (value: number) => void }): React.JSX.Element {
  return (
    <label className="field number-field">
      <span>{label}</span>
      <span className="number-input"><input type="number" value={Number.isFinite(value) ? value : 0} step="any" onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }} /><em>{unit}</em></span>
    </label>
  );
}

function PanelHeading({ eyebrow, title }: { eyebrow: string; title: string }): React.JSX.Element {
  return <div className="panel-heading"><span>{eyebrow}</span><h2>{title}</h2></div>;
}

function StabilityStatus({ kind, message }: { kind: string; message: string }): React.JSX.Element {
  return <p className={`stability stability-${kind}`}>{message}</p>;
}
