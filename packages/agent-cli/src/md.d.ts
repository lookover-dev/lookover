// A `.md` file imported `with { type: "text" }` is its text (skill.ts). Bun's types declare `*.txt` and the like,
// not `*.md`.
declare module "*.md" {
  const contents: string;
  export default contents;
}
