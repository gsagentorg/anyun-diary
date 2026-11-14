import { createHash } from 'node:crypto';
import { validateCatalog, validatePointer } from '../catalog-schema.js';
import type { DiaryData } from '../types';
/** No process cache: every request resolves current, including on warm serverless instances. */
export async function readCatalog(read: (key: string) => Promise<Response>): Promise<DiaryData> {
  const pointerResponse = await read('catalog/current.json');
  if (!pointerResponse.ok) throw new Error('Catalog pointer unavailable');
  const pointer = validatePointer(await pointerResponse.json());
  const response = await read(pointer.key);
  if (!response.ok) throw new Error('Catalog snapshot unavailable');
  const body = await response.text();
  const hash = createHash('sha256').update(body).digest('hex');
  if (pointer.key !== 'catalogs/'+hash+'.json') throw new Error('Catalog snapshot integrity mismatch');
  return validateCatalog(JSON.parse(body)) as DiaryData;
}
