import { discoverCapabilities } from './capabilities';

function hasExactLink(html: string, expectedUrl: string, base: string): boolean {
  const expected = new URL(expectedUrl);
  const hrefRegex = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1];
    try {
      const parsed = new URL(href, base);
      if (
        parsed.protocol === expected.protocol &&
        parsed.hostname === expected.hostname &&
        parsed.pathname === expected.pathname
      ) {
        return true;
      }
    } catch {
      // Ignore invalid URLs in href attributes.
    }
  }
  return false;
}

const base = process.argv[2];
if (!base) throw new Error('Usage: bun run smoke:capabilities https://YOUR-WORKER');
const expected = await discoverCapabilities();
const response = await fetch(new URL('/capabilities.json', base), { cache: 'no-store' });
if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
if (!response.headers.get('cache-control')?.includes('no-cache')) throw new Error('Catalog must revalidate');
const actual = await response.json();
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Deployed catalog differs from this build');
const page = await fetch(new URL('/', base), { cache: 'no-store' });
const html = await page.text();
if (!page.ok || !html.includes('/capabilities.json') || !hasExactLink(html, 'https://buymeacoffee.com/vitorhugo1207', base) || !html.includes('Streamable HTTP')) throw new Error('Landing page does not reflect this build');
console.log(`Capability smoke passed: ${expected.tools.length} tools, ${expected.resources.length} resources, ${expected.resourceTemplates.length} templates`);
