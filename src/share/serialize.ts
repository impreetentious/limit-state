/**
 * URL-hash sharing: '#m=' + base64url(deflate-raw(JSON)) via CompressionStream,
 * '#mu=' + base64url(JSON) fallback. Schema v1 = EditorModel. M7.
 * Property gate G11: decode(encode(m)) deep-equals m.
 */
import type { EditorModel } from '../fem/types';

export async function encodeModel(_m: EditorModel): Promise<string> {
  throw new Error('TODO(M7)');
}

export async function decodeModel(_hash: string): Promise<EditorModel> {
  throw new Error('TODO(M7): validate v, ids, deck contiguity');
}
