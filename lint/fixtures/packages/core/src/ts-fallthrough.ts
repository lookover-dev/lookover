export function size(n: number): string {
  let s = "";
  switch (n) {
    case 1:
      s += "small";
    case 2:
      s += "medium";
      break;
  }
  return s;
}
