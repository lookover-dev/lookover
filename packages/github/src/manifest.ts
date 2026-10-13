// The App manifest Lookover posts to GitHub to create the owner's App (ADR 0022, ADR 0053): GitHub's page shows it
// pre-filled, the owner confirms. A pure function: the service renders it in its form and posts it.
import { APP_PERMISSIONS } from "@lookover/contracts";

/** Where GitHub sends the browser back: after the App is created (`redirectUrl`), after it is installed (`setupUrl`). */
export interface ManifestLinks {
  redirectUrl: string;
  setupUrl: string;
}

/** A manifest as GitHub reads it: no `hook_attributes`, so no webhook (a loopback hook address is refused). */
export interface AppManifest {
  name: string;
  url: string;
  description: string;
  public: false;
  redirect_url: string;
  setup_url: string;
  default_permissions: typeof APP_PERMISSIONS;
  default_events: readonly [];
}

/** The App's home page on GitHub's page: Lookover's public repository (ADR 0060), so a person shown the App finds it. */
const HOME_PAGE = "https://github.com/lookover-dev/lookover";
const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const NAME_SUFFIX = 6;

/**
 * The manifest of a new App: a name `lookover-` and six random characters (GitHub's App names are unique across
 * GitHub; the owner can edit it on GitHub's page), private, no webhook and no events, exactly ADR 0022's permissions.
 */
export function appManifest(links: ManifestLinks): AppManifest {
  return {
    name: `lookover-${randomSuffix()}`,
    url: HOME_PAGE,
    description: "Lookover: a second look at your pull requests before they are merged.",
    public: false,
    redirect_url: links.redirectUrl,
    setup_url: links.setupUrl,
    default_permissions: APP_PERMISSIONS,
    default_events: [],
  };
}

/** Six characters of `NAME_ALPHABET`, each as likely as the others (a byte past the last whole round is drawn again). */
function randomSuffix(): string {
  const fair = 256 - (256 % NAME_ALPHABET.length);
  let suffix = "";
  while (suffix.length < NAME_SUFFIX) {
    for (const byte of crypto.getRandomValues(new Uint8Array(NAME_SUFFIX))) {
      if (byte < fair && suffix.length < NAME_SUFFIX) suffix += NAME_ALPHABET[byte % NAME_ALPHABET.length];
    }
  }
  return suffix;
}
