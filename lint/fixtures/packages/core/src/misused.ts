async function ready(): Promise<boolean> {
  return true;
}

export function start(): number {
  if (ready()) return 1;
  return 0;
}
