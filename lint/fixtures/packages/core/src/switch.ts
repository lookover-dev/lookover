import type { Kind } from "./kinds.ts";

export function label(kind: Kind): string {
  switch (kind) {
    case "draft":
      return "Draft";
  }
  return "";
}
