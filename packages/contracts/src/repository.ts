// A repository Lookover can review.
import type { RepositoryId } from "./ids.ts";
import type { ResolvedSettings } from "./settings.ts";

/**
 * What "Too noisy?" counts in a repository's last 30 reviews: its 30 most recently reviewed changes, each by its
 * last round (ADR 0049). `postedBelowBlocking`: the findings below blocking that were posted, which "Only post
 * blocking findings" would have kept off the pull request. `raisedByRule`: by rule id, the findings citing that rule
 * or any rule nested in it, which "Turn off the rule" would have removed (it turns those off too); a rule whose
 * subtree raised none is absent (0). Over the same 30 reviews,
 * unlike `Rule.raised`, which counts every change. `reviews`: how many changes were counted, 30 at most, so the
 * words say "your last 12 reviews" when there are fewer.
 */
export interface NoiseCounts {
  reviews: number;
  postedBelowBlocking: number;
  raisedByRule: Record<string, number>;
}

export interface Repository {
  id: RepositoryId;
  owner: string;
  name: string;
  enabled: boolean;
  /** What applies here: the owner's own value for this repository, or else the owner's defaults. */
  settings: ResolvedSettings;
  /** "Too noisy?"'s counts; absent while the service can't give them, so no line shows a made-up 0. */
  noise?: NoiseCounts;
}

/**
 * A repository the App's installation no longer lists (ADR 0059): moved to another account or out of the
 * organisation, deleted, or taken off the App's access. Said in Repositories from `at`, when it left, until it is
 * listed again or the person dismisses it. Its jobs went as it left; its history stays.
 */
export interface DepartedRepository {
  id: RepositoryId;
  owner: string;
  name: string;
  at: number;
}
