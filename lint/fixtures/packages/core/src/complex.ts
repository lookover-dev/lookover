export function grade(scores: number[], strict: boolean, bonus: number): string {
  let total = 0;
  for (const s of scores) {
    if (s > 0) {
      if (strict && s < 10) {
        total -= 1;
      } else if (s > 90 || (bonus > 0 && s > 80)) {
        for (let i = 0; i < bonus; i++) {
          if (i % 2 === 0 && strict) total += 2;
          else if (i % 3 === 0 || !strict) total += 1;
        }
      } else {
        total += s > 50 ? 1 : 0;
      }
    } else if (s < -10 && !strict) {
      total -= s < -50 ? 2 : 1;
    }
  }
  return total > 10 ? "high" : "low";
}
