// The check's `external_id` (ADR 0066, 0077): `<job>#<number>@<person's id>`, so two people's checks on one pull
// request never mix (each finds its own again, ADR 0044), and two pull requests' checks on one head neither: the agent
// can tell whose is whose and for which pull request. The person is the one Lookover posts for, the person signed in
// to the shared App; the number is the pull request's the job reviews, in the repository the check is read in. The
// person stays last, so a reader that asks only whose a check is still reads it.

/** A numeric id as GitHub writes one: digits, no leading zero. */
const ID = /^[1-9][0-9]*$/;

/** What an external id names: the job, the pull request's number (null in one from before ADR 0077), the person. */
export interface CheckExternalId {
  job: string;
  number: number | null;
  person: number;
}

const isId = (n: number): boolean => Number.isSafeInteger(n) && n > 0;

/**
 * The external id of the check of the job `job`, reviewing the pull request numbered `number`, posted for the person
 * whose numeric id is `person`. Throws for a person that is no GitHub id (0 while no App is held, say), a number that
 * is no pull request's, or no job: its reader would refuse what it wrote, and the next post would make a second check.
 */
export function checkExternalId(job: string, number: number, person: number): string {
  if (!isId(person)) throw new Error(`${person} is no person's id`);
  if (!isId(number)) throw new Error(`${number} is no pull request's number`);
  if (job === "") throw new Error("A check's external id names a job, and there is no job");
  return `${job}#${number}@${person}`;
}

/**
 * The job, the pull request and the person an external id names; `number` null for one naming no pull request (one
 * from before ADR 0077). Null for anything else: an older check's job id alone, a person or a number that is no id.
 */
export function readCheckExternalId(externalId: string): CheckExternalId | null {
  const at = externalId.lastIndexOf("@");
  if (at <= 0) return null;
  const person = externalId.slice(at + 1);
  if (!ID.test(person)) return null;
  const head = externalId.slice(0, at);
  const hash = head.lastIndexOf("#");
  if (hash < 0) return { job: head, number: null, person: Number(person) };
  const number = head.slice(hash + 1);
  if (hash === 0 || !ID.test(number)) return null;
  return { job: head.slice(0, hash), number: Number(number), person: Number(person) };
}

/** Whether a check is for the person and the pull request: its external id names both (ADR 0077). */
export function checkIsFor(externalId: string, person: number, number: number): boolean {
  const named = readCheckExternalId(externalId);
  return named !== null && named.person === person && named.number === number;
}
