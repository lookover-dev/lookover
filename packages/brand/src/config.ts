// What the brand package reads from the environment: only the Biome binary a person names, as Biome's own
// launcher honours it.

/** `BIOME_BINARY`: the Biome binary to format with, instead of the checkout's; unset when empty. */
export const BIOME_BINARY: string | undefined = process.env.BIOME_BINARY || undefined;
