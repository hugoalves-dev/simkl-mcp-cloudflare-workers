/** Decorate public TV episode responses for MCP consumers without altering cached Simkl JSON. */
export function withTvFinaleDescriptions(response: unknown): unknown {
  if (!Array.isArray(response)) return response;

  return response.map((episode: unknown) => {
    if (!episode || typeof episode !== 'object' || Array.isArray(episode)) return episode;
    const item = episode as Record<string, unknown>;
    if (!Object.hasOwn(item, 'finale_type')) return episode;

    const description = item.finale_type === null ? null
      : item.finale_type === 1 ? 'Mid-season Finale'
      : item.finale_type === 2 ? 'Season Finale'
      : item.finale_type === 3 ? 'Series Finale'
      : undefined;

    // Simkl's numeric enum is internal; never expose it to MCP consumers.
    // Unknown future codes are omitted rather than leaking undocumented numbers.
    const result = { ...item };
    delete result.finale_type;
    if (description !== undefined) result.finale_type_description = description;
    return result;
  });
}
