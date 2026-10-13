// A Zod enum tied to the TypeScript type it parses (spec #40, story 42): written apart, the two drift, and a
// value added to one and not the other passes until a payload meets it. `enumOf<T>()(values)` lists `values`
// once, and the typecheck refuses a list that leaves out a value of `T` or holds one that isn't.
import { z } from "zod";

/** `unknown` when `values` holds every value of `T`; else names the ones left out, so the error says which. */
type Every<T extends string, V extends readonly string[]> = [Exclude<T, V[number]>] extends [never]
  ? unknown
  : { missing: Exclude<T, V[number]> };

/** The Zod enum of exactly `T`'s values. Curried so that `T` is named and the values are inferred. */
export function enumOf<T extends string>() {
  return <const V extends readonly [T, ...T[]]>(values: V & Every<T, V>) => z.enum(values);
}
