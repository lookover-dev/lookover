// A Zod schema tied exactly to the TypeScript type it parses (ADR 0085), in the style of `enumOf`: written apart,
// the two drift, and `z.object` strips the keys it doesn't name, so a schema that forgot a field would erase it from
// every value it reads. `tiedTo<T>()(schema)` takes a schema only when what it parses is `T`, both ways: a field it
// misses (an optional one included), one it adds, or a value wider or narrower than `T`'s fails the typecheck, and
// the error names `T`.
import type { z } from "zod";

/**
 * A type as plain objects all the way down, so an intersection (`{ at } & ({ kind: "a" } | { kind: "b" })`) and the
 * union a schema flattens it to compare equal. A branded id (`string & { [kind] }`) and every other primitive stays
 * as it is; an optional field stays optional, without `undefined`.
 */
type Flat<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends readonly (infer E)[]
    ? Flat<E>[]
    : { [K in keyof T]: Flat<T[K]> };

/** Whether `A` and `B` are the same type, not only assignable either way (an optional field counts). */
type Same<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;

/** `unknown` when `S` parses exactly `T`; else names `T` and what the schema parses, so the error says which drifted. */
type Exactly<T, S extends z.ZodType> =
  Same<Flat<z.output<S>>, Flat<T>> extends true ? unknown : { notTiedTo: T; parses: z.output<S> };

/** `schema`, typed as parsing `T`. Curried so that `T` is named and the schema is inferred. */
export function tiedTo<T>() {
  return <S extends z.ZodType>(schema: S & Exactly<T, S>): S => schema;
}
