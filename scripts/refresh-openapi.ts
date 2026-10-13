import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertOpenApiDocument } from './openapi-source.js';

const sourceUrl = 'https://api.simkl.org/openapi.json';
const destination = 'api/simkl-openapi.json';

const response = await fetch(sourceUrl, {
  headers: { accept: 'application/json' },
});

if (!response.ok) {
  throw new Error(`Failed to download ${sourceUrl}: ${response.status} ${response.statusText}`);
}

const document: unknown = await response.json();
if (!document || typeof document !== 'object' || Array.isArray(document)) {
  throw new Error(`The response from ${sourceUrl} was not a JSON object`);
}
assertOpenApiDocument(document);

await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Updated ${destination} from ${sourceUrl}`);
