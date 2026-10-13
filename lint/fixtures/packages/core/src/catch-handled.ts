export function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Not JSON: ${text.slice(0, 20)}`, { cause: error });
  }
}
