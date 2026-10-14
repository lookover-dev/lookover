// The sections' reveals: each `.rise` fades in and rises 6 px once, as it scrolls into view. The
// CSS hides them only while `data-motion` is on the root, so without it they simply show.

/** Reveals every `.rise` on the page as it comes into view. */
export function reveals() {
  const rising = document.querySelectorAll(".rise");
  if (!("IntersectionObserver" in window)) {
    for (const el of rising) el.classList.add("in");
    return;
  }
  const seen = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of rising) seen.observe(el);
}
