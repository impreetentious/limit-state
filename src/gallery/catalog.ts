/**
 * Curated share-URL gallery sources.
 * `public/gallery.json` stores the frozen `#mu=` hashes derived from these models.
 */
import { CHALLENGE_SOLUTIONS, CHALLENGES } from '../challenges/catalog';
import type { EditorModel } from '../fem/types';
import { PRESETS } from '../presets/scenes';

export interface GallerySource {
  id: string;
  title: string;
  blurb: string;
  model: EditorModel;
}

/** Authored gallery scenes — presets plus challenge reference solutions. */
export function gallerySources(): GallerySource[] {
  const presets: GallerySource[] = PRESETS
    .filter((preset) => preset.id !== 'blank')
    .map((preset) => ({
      id: `preset-${preset.id}`,
      title: preset.label.replace(/^\d+\s·\s/, ''),
      blurb: `Teaching preset — open in the editor and run its default story.`,
      model: preset.model,
    }));

  const solutions: GallerySource[] = CHALLENGES.map((challenge) => ({
    id: `solution-${challenge.id}`,
    title: `${challenge.label.replace(/^\d+\s·\s/, '')} (reference)`,
    blurb: `One steel-budget solution for challenge “${challenge.brief}”.`,
    model: CHALLENGE_SOLUTIONS[challenge.id]!,
  }));

  return [...presets, ...solutions];
}
