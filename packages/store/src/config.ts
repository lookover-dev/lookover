// What the store reads from the environment: only the one `released-migrations` starts git in when its caller
// names none (its HOME, USERPROFILE and PATH, so git finds its global config, `safe.directory` included). Never
// reached from the store's index: the service gives git nothing from here.

/** This process's environment, as the caller's when it gives git none. */
export const CALLER_ENV: Readonly<Record<string, string | undefined>> = process.env;
