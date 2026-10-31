// The change ids of one repository as a range of keys (ADR 0053): what `rounds` and `jobs` read of one repository's
// changes, by the prefix `changePrefixOf` gives ("sasensi/ledger-api#"), with SQLite's `>= prefix AND < pastPrefix(prefix)`.

/**
 * The first text after every text starting with `prefix`, in SQLite's binary order: its last character moved one
 * up ("sasensi/ledger-api#" → "sasensi/ledger-api$"). The ids `changeIdOf` makes end their prefix in "#".
 */
export function pastPrefix(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}
