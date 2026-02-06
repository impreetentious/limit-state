'use client';

import { MATERIALS, sectionProps } from '../fem/materials';
import type { SectionSpec } from '../fem/types';
import type { MemberSpec3d, SupportKind3d } from '../fem/space';
import { defaultSection } from '../state/editor-store';
import { useEditorStore3d } from '../state/editor-store-3d';

const SUPPORTS: Array<{ value: SupportKind3d | 'none'; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'pin', label: 'Pin' },
  { value: 'rollerX', label: 'Roller X' },
  { value: 'rollerY', label: 'Roller Y' },
  { value: 'rollerZ', label: 'Roller Z' },
  { value: 'fixed', label: 'Fixed' },
];

/** Context inspector for the space-frame editor. */
export function Inspector3d(): React.JSX.Element {
  const model = useEditorStore3d((state) => state.model);
  const selection = useEditorStore3d((state) => state.selection);
  const updateNode = useEditorStore3d((state) => state.updateNode);
  const setSupport = useEditorStore3d((state) => state.setSupport);

  if (selection.kind === 'node') {
    const node = model.nodes.find((candidate) => candidate.id === selection.id);
    if (node) {
      const support =
        model.supports.find((candidate) => candidate.node === node.id)?.kind ?? 'none';
      return (
        <aside className="inspector" aria-label="3D node inspector">
          <h2>Node {node.id}</h2>
          <p>Position & support</p>
          <NumberField
            label="X"
            value={node.x}
            unit="m"
            onChange={(x) => updateNode(node.id, x, node.y, node.z)}
          />
          <NumberField
            label="Y"
            value={node.y}
            unit="m"
            onChange={(y) => updateNode(node.id, node.x, y, node.z)}
          />
          <NumberField
            label="Z"
            value={node.z}
            unit="m"
            onChange={(z) => updateNode(node.id, node.x, node.y, z)}
          />
          <label className="field">
            <span>Support</span>
            <select
              value={support}
              onChange={(event) =>
                setSupport(
                  node.id,
                  event.target.value === 'none' ? undefined : (event.target.value as SupportKind3d),
                )
              }
            >
              {SUPPORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </aside>
      );
    }
  }

  if (selection.kind === 'member') {
    const member = model.members.find((candidate) => candidate.id === selection.id);
    if (member) return <MemberInspector member={member} />;
  }

  if (selection.kind === 'members') {
    const members = model.members.filter((member) => selection.ids.includes(member.id));
    if (members.length > 1) return <BulkMemberInspector members={members} />;
  }

  return (
    <aside className="inspector inspector-empty" aria-label="3D model inspector">
      <h2>Space frame</h2>
      <p>
        Select a node or member to edit its geometry, support, material, section, roll, or releases.
      </p>
    </aside>
  );
}

function BulkMemberInspector({ members }: { members: MemberSpec3d[] }): React.JSX.Element {
  const updateMembers = useEditorStore3d((state) => state.updateMembers);
  const first = members[0]!;
  return (
    <aside className="inspector" aria-label="3D bulk member inspector">
      <h2>{members.length} members</h2>
      <p>Bulk material & section assignment</p>
      <label className="field">
        <span>Material</span>
        <select
          value={
            members.every((member) => member.material === first.material) ? first.material : ''
          }
          onChange={(event) => {
            if (event.target.value)
              updateMembers(
                members.map((member) => member.id),
                {
                  material: event.target.value as MemberSpec3d['material'],
                },
              );
          }}
        >
          <option value="">Mixed</option>
          {Object.values(MATERIALS).map((material) => (
            <option key={material.id} value={material.id}>
              {material.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Section</span>
        <select
          value={
            members.every((member) => member.section.kind === first.section.kind)
              ? first.section.kind
              : ''
          }
          onChange={(event) => {
            if (event.target.value)
              updateMembers(
                members.map((member) => member.id),
                {
                  section: defaultSection(event.target.value as SectionSpec['kind']),
                },
              );
          }}
        >
          <option value="">Mixed</option>
          <option value="rect">Solid rectangle</option>
          <option value="box">Box</option>
          <option value="ibeam">I-beam</option>
          <option value="tube">Tube</option>
        </select>
      </label>
      <p>Shift-click members on the canvas to add or remove them from this selection.</p>
    </aside>
  );
}

function MemberInspector({ member }: { member: MemberSpec3d }): React.JSX.Element {
  const model = useEditorStore3d((state) => state.model);
  const updateMember = useEditorStore3d((state) => state.updateMember);
  const a = model.nodes.find((node) => node.id === member.a);
  const b = model.nodes.find((node) => node.id === member.b);
  const material = MATERIALS[member.material];
  const length = a && b ? Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) : 0;
  const tonnes = (material.rho * sectionProps(member.section).A * length) / 1000;
  const updateRelease = (end: 'releaseA' | 'releaseB', axis: 'tx' | 'ty' | 'tz', value: boolean) =>
    updateMember(member.id, { [end]: { ...member[end], [axis]: value } });

  return (
    <aside className="inspector" aria-label="3D member inspector">
      <h2>Member {member.id}</h2>
      <p>Material, section & releases</p>
      <label className="field">
        <span>Material</span>
        <select
          value={member.material}
          onChange={(event) =>
            updateMember(member.id, { material: event.target.value as MemberSpec3d['material'] })
          }
        >
          {Object.values(MATERIALS).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Section</span>
        <select
          value={member.section.kind}
          onChange={(event) =>
            updateMember(member.id, {
              section: defaultSection(event.target.value as SectionSpec['kind']),
            })
          }
        >
          <option value="rect">Solid rectangle</option>
          <option value="box">Box</option>
          <option value="ibeam">I-beam</option>
          <option value="tube">Tube</option>
        </select>
      </label>
      <SectionFields
        section={member.section}
        onChange={(section) => updateMember(member.id, { section })}
      />
      <NumberField
        label="Roll"
        value={(member.roll * 180) / Math.PI}
        unit="°"
        onChange={(roll) => updateMember(member.id, { roll: (roll * Math.PI) / 180 })}
      />
      <div className="member-stats">
        <span>
          Length <b>{length.toFixed(2)} m</b>
        </span>
        <span>
          Mass <b>{tonnes.toFixed(3)} t</b>
        </span>
      </div>
      <div className="release-fields">
        {(['tx', 'ty', 'tz'] as const).map((axis) => (
          <label key={`a-${axis}`}>
            <input
              type="checkbox"
              checked={member.releaseA[axis]}
              onChange={(event) => updateRelease('releaseA', axis, event.target.checked)}
            />{' '}
            Release A {axis}
          </label>
        ))}
        {(['tx', 'ty', 'tz'] as const).map((axis) => (
          <label key={`b-${axis}`}>
            <input
              type="checkbox"
              checked={member.releaseB[axis]}
              onChange={(event) => updateRelease('releaseB', axis, event.target.checked)}
            />{' '}
            Release B {axis}
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={member.cableOnly === true}
            onChange={(event) => updateMember(member.id, { cableOnly: event.target.checked })}
          />{' '}
          Tension-only cable
        </label>
      </div>
    </aside>
  );
}

function SectionFields({
  section,
  onChange,
}: {
  section: SectionSpec;
  onChange: (section: SectionSpec) => void;
}): React.JSX.Element {
  const field = (label: string, value: number, apply: (next: number) => SectionSpec) => (
    <NumberField
      label={label}
      value={value * 1000}
      unit="mm"
      onChange={(next) => onChange(apply(next / 1000))}
    />
  );
  switch (section.kind) {
    case 'rect':
      return (
        <div className="field-grid">
          {field('b', section.b, (b) => ({ ...section, b }))}
          {field('h', section.h, (h) => ({ ...section, h }))}
        </div>
      );
    case 'box':
      return (
        <div className="field-grid">
          {field('b', section.b, (b) => ({ ...section, b }))}
          {field('h', section.h, (h) => ({ ...section, h }))}
          {field('t', section.t, (t) => ({ ...section, t }))}
        </div>
      );
    case 'ibeam':
      return (
        <div className="field-grid">
          {field('b', section.b, (b) => ({ ...section, b }))}
          {field('h', section.h, (h) => ({ ...section, h }))}
          {field('flange', section.tf, (tf) => ({ ...section, tf }))}
          {field('web', section.tw, (tw) => ({ ...section, tw }))}
        </div>
      );
    case 'tube':
      return (
        <div className="field-grid">
          {field('diameter', section.d, (d) => ({ ...section, d }))}
          {field('wall', section.t, (t) => ({ ...section, t }))}
        </div>
      );
  }
}

function NumberField({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="number-with-unit">
        <input
          type="number"
          value={Number.isFinite(value) ? value : ''}
          step="any"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
        />
        <em>{unit}</em>
      </div>
    </label>
  );
}
