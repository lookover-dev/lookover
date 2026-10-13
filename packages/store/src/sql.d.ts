// A `.sql` file imported `with { type: "text" }` is its text (embedded-migrations.ts). Bun's types declare
// `*.txt` and the like, not `*.sql`.
declare module "*.sql" {
  const contents: string;
  export default contents;
}
