import { describe, expect, test } from 'bun:test';
import { registerTools } from '../generated/tools';

describe('generated history request schemas', () => {
  test('exposes typed rewatch fields on history and distinct removal items', () => {
    const tools = new Map<string, any>();
    registerTools({ registerTool(name: string, definition: any) { tools.set(name, definition); } } as any, {}, () => undefined);

    const history = tools.get('simkl_mark_watched').inputSchema;
    const movie = history.movies.unwrap().element;
    expect(movie.safeParse({ rewatch_id: 2 }).success).toBe(false);
    expect(movie.shape.is_rewatch.parse(true)).toBe(true);
    expect(movie.shape.rewatch_id.safeParse(2).success).toBe(true);
    expect(movie.shape.rewatch_id.safeParse(0).success).toBe(false);
    expect(movie.shape.rewatch_status.safeParse('closed').success).toBe(true);
    expect(movie.shape.rewatch_status.safeParse('ignored').success).toBe(false);
    for (const key of ['shows', 'anime']) {
      const item = history[key].unwrap().element;
      expect(item.shape.is_rewatch.safeParse(false).success).toBe(true);
      expect(item.shape.rewatch_id.safeParse(2).success).toBe(true);
      expect(item.shape.rewatch_status.safeParse('active').success).toBe(true);
    }
    expect(history.movies).toBeDefined();
    expect(history.shows).toBeDefined();
    expect(history.anime).toBeDefined();
    expect(history.episodes).toBeDefined();
    expect(history.episode).toBeDefined();

    const removal = tools.get('simkl_remove_from_history').inputSchema;
    const removalMovie = removal.movies.unwrap().element;
    expect(removalMovie.shape.rewatch_id.parse(42)).toBe(42);
    expect(removalMovie.safeParse({ rewatch_id: 42 }).success).toBe(false);
    expect(removalMovie.safeParse({ ids: { simkl: 1 }, rewatch_id: 0 }).success).toBe(false);
  });

  test('does not expose rewatch opt-in on start or pause scrobble tools', () => {
    const tools = new Map<string, any>();
    registerTools({ registerTool(name: string, definition: any) { tools.set(name, definition); } } as any, {}, () => undefined);
    expect(tools.get('simkl_start_watching').inputSchema.allow_rewatch).toBeUndefined();
    expect(tools.get('simkl_pause_watching').inputSchema.allow_rewatch).toBeUndefined();
  });

  test('start and pause requests never forward rewatch opt-in', async () => {
    const tools = new Map<string, { definition: any; handler: (args: any) => Promise<any> }>();
    const writes: Array<{ path: string; options: any }> = [];
    registerTools({ registerTool(name: string, definition: any, handler: (args: any) => Promise<any>) { tools.set(name, { definition, handler }); } } as any, {}, () => 'token', {
      write: async (path, options) => { writes.push({ path, options }); return { movie: { title: 'Example' } }; },
    });
    const body = { progress: 20, movie: { title: 'Example' } };
    await tools.get('simkl_start_watching')!.handler({ body });
    await tools.get('simkl_pause_watching')!.handler({ body });
    expect(writes.map(write => write.path)).toEqual(['/scrobble/start', '/scrobble/pause']);
    expect(writes.some(write => write.options.query?.allow_rewatch !== undefined)).toBe(false);
  });
});
