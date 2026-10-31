// The check's `external_id` (ADR 0066): `<job>@<person's id>`, on both ways in, so two people's checks on one pull
// request never mix (each finds its own again, ADR 0044) and the agent can tell whose is whose. The person is the
// one Lookover posts for: the App's person on `own`, the signed-in person on `shared`.

/** A numeric id as GitHub writes one: digits, no leading zero. */
const ID = /^[1-9][0-9]*$/;

/**
 * The external id of the check of the job `job`, posted for the person whose numeric id is `person`. Throws for a
 * person that is no GitHub id (0 while no App is held, say), or no job: its reader would refuse what it wrote, and
 * the next post would make a second check.
 */
export function checkExternalId(job: string, person: number): string {
  if (!Number.isSafeInteger(person) || person <= 0) throw new Error(`${person} is no person's id`);
  if (job === "") throw new Error("A check's external id names a job, and there is no job");
  return `${job}@${person}`;
}

/** The job and the person an external id names; null for anything else (an older check's job id alone, say). */
export function readCheckExternalId(externalId: string): { job: string; person: number } | null {
  const at = externalId.lastIndexOf("@");
  if (at <= 0) return null;
  const person = externalId.slice(at + 1);
  if (!ID.test(person)) return null;
  return { job: externalId.slice(0, at), person: Number(person) };
}
