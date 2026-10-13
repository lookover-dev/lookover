export function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("Could not parse", error);
  }
  return null;
}
