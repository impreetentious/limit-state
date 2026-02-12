/**
 * Curated share-URL gallery sources. docs/FEM-SPEC.md §14 2G / §14 4J.
 * `public/gallery.json` stores the frozen `#mu=` hashes derived from these models.
 */
import { CHALLENGE_SOLUTIONS, CHALLENGES } from '../challenges/catalog';
import type { EditorModel } from '../fem/types';
import type { EditorModel3d } from '../fem/space';
import { PRESETS } from '../presets/scenes';
import { PRESETS_3D } from '../presets/scenes3d';

export interface GallerySource {
  id: string;
  title: string;
  blurb: string;
  model: EditorModel;
}

export interface GallerySource3d {
  id: string;
  title: string;
  blurb: string;
  model: EditorModel3d;
}

/** Authored gallery scenes — presets plus challenge reference solutions. docs/FEM-SPEC.md §14 2G. */
export function gallerySources(): GallerySource[] {
  const presets: GallerySource[] = PRESETS.filter((preset) => preset.id !== 'blank').map(
    (preset) => ({
      id: `preset-${preset.id}`,
      title: preset.label.replace(/^\d+\s·\s/, ''),
      blurb: `Teaching preset — open in the editor and run its default story.`,
      model: preset.model,
    }),
  );

  const solutions: GallerySource[] = CHALLENGES.map((challenge) => ({
    id: `solution-${challenge.id}`,
    title: `${challenge.label.replace(/^\d+\s·\s/, '')} (reference)`,
    blurb: `One steel-budget solution for challenge “${challenge.brief}”.`,
    model: CHALLENGE_SOLUTIONS[challenge.id]!,
  }));

  return [...presets, ...solutions];
}

/** 3D gallery sources — the spatial teaching presets. */
export function gallerySources3d(): GallerySource3d[] {
  return PRESETS_3D.filter((preset) => preset.id !== 'blank').map((preset) => ({
    id: `preset3d-${preset.id}`,
    title: `${preset.label.replace(/^\d+\s·\s/, '')} (3D)`,
    blurb: 'Spatial teaching preset — open in the 3D editor and run its default story.',
    model: preset.build(),
  }));
}
