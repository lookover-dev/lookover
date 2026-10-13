import { a } from "./cycle-a.ts";

export const b = (): number => (Math.random() > 2 ? a() : 0);
