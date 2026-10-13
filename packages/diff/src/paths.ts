// Paths as git prints them and as findings name them.

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * Git C-quotes a path with a double quote, a control character or a byte over 127 (`core.quotePath`):
 * `"caf\303\251.txt"`. Decodes the escapes back to the path; a plain name is returned as it is.
 */
export function unquotePath(name: string): string {
  if (!(name.startsWith('"') && name.endsWith('"') && name.length >= 2)) return name;
  const bytes: number[] = [];
  const inner = name.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charAt(i);
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      continue;
    }
    const next = inner.charAt(++i);
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += octal[0].length - 1;
    } else bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** A finding's path, written the way the diff writes it: forward slashes, no leading `./`. */
export function normalizePath(path: string): string {
  const slashed = path.replaceAll("\\", "/");
  return slashed.startsWith("./") ? slashed.slice(2) : slashed;
}
