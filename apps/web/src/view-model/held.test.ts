// A held value tells its readers each time it is set, and no longer once they unsubscribe.
import { expect, test } from "bun:test";
import { HeldValue } from "./held.ts";

class Counter extends HeldValue<number> {
  constructor() {
    super(0);
  }

  add = (): void => this.set(this.get() + 1);
}

test("a held value is read as set, and each reader is told until it unsubscribes", () => {
  const counter = new Counter();
  let told = 0;
  const unsubscribe = counter.subscribe(() => {
    told += 1;
  });
  expect(counter.get()).toBe(0);
  counter.add();
  expect([counter.get(), told]).toEqual([1, 1]);
  unsubscribe();
  counter.add();
  expect([counter.get(), told]).toEqual([2, 1]);
});
