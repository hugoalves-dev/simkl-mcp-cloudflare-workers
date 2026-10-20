import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SimklClient } from '../src/api/client';
import { registerTools } from '../generated/tools';

type Episode = { title: string; type: string; finale_type?: 1 | 2 | 3 | null; ids: { simkl_id: number } };
type ToolResult = { isError?: boolean; content: Array<{ type: 'text'; text: string }> };
const tvEpisodes = JSON.parse(readFileSync(new URL('./fixtures/tv-finale-episodes.json', import.meta.url), 'utf8')) as Episode[];
const animeEpisodes = JSON.parse(readFileSync(new URL('./fixtures/anime-episodes-without-finale.json', import.meta.url), 'utf8')) as Episode[];
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function callEpisodesTool(name: 'simkl_get_show_episodes' | 'simkl_get_anime_episodes', id: string, payload: Episode[]) {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    return Response.json(payload);
  }) as typeof fetch;

  const registered = new Map<string, (args: { id: string }) => Promise<ToolResult>>();
  const client = new SimklClient({ baseUrl: 'https://api.simkl.com', clientId: 'test-app' });
  registerTools({
    registerTool(toolName: string, _definition: unknown, handler: (args: { id: string }) => Promise<ToolResult>) {
      registered.set(toolName, handler);
    },
  } as any, client, () => undefined);

  const result = await registered.get(name)!({ id });
  expect(result.isError).not.toBe(true);
  expect(paths).toEqual([name === 'simkl_get_show_episodes' ? `/tv/episodes/${id}` : `/anime/episodes/${id}`]);
  // Compare the exact JSON data and its serialized representation: no coercion, filtering, or injected fields.
  expect(result.content[0].text).toBe(JSON.stringify(payload, null, 2));
  return JSON.parse(result.content[0].text) as Episode[];
}

describe('issue #51: finale_type on TV episodes', () => {
  for (const value of [1, 2, 3, null] as const) {
    test(`preserves TV finale_type=${String(value)} exactly`, async () => {
      const episode = tvEpisodes.find(item => item.type === 'episode' && item.finale_type === value);
      expect(episode).toBeDefined();
      const [actual] = await callEpisodesTool('simkl_get_show_episodes', '17465', [episode!]);
      expect(Object.hasOwn(actual, 'finale_type')).toBe(true);
      expect(actual.finale_type).toBe(value);
    });
  }

  test('preserves finale_type on a TV special without inventing numbered season/episode', async () => {
    const special = tvEpisodes.find(item => item.type === 'special')!;
    const [actual] = await callEpisodesTool('simkl_get_show_episodes', '17465', [special]);
    expect(actual.finale_type).toBe(2);
    expect(Object.hasOwn(actual, 'season')).toBe(false);
    expect(Object.hasOwn(actual, 'episode')).toBe(false);
  });

  test('anime episodes without finale_type remain unchanged, including specials', async () => {
    const actual = await callEpisodesTool('simkl_get_anime_episodes', '6100', animeEpisodes);
    expect(actual).toEqual(animeEpisodes);
    expect(actual.every(item => !Object.hasOwn(item, 'finale_type'))).toBe(true);
  });

  test('OpenAPI field is nullable TV-only and does not become required', () => {
    const spec = JSON.parse(readFileSync(new URL('../api/simkl-openapi.json', import.meta.url), 'utf8'));
    const tv = spec.components.schemas.EpisodeDetail;
    const anime = spec.components.schemas.AnimeEpisodeDetail;
    expect(tv.properties.finale_type.type).toEqual(['integer', 'null']);
    expect(tv.properties.finale_type.enum).toEqual([1, 2, 3, null]);
    expect(tv.required).not.toContain('finale_type');
    expect(Object.hasOwn(anime.properties, 'finale_type')).toBe(false);
    const examples = spec.paths['/tv/episodes/{id}'].get.responses['200'].content['application/json'].examples;
    expect(examples.series_finale.value[0].finale_type).toBe(3);
    expect(examples.first_two_episodes.value.every((item: Episode) => item.finale_type === null)).toBe(true);
    expect(examples.special_episode.value[0].finale_type).toBeNull();
  });
});
