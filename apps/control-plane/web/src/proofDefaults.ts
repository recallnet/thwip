/**
 * The two fields an organization actually sets, and the document they live in.
 *
 * The panel used to be a textarea holding the whole document as JSON. Every
 * owner who wanted to change the profile from `fast` to `fresh` had to retype a
 * mapping around it, and a misplaced comma was answered with "defaults must be
 * valid JSON" and no indication of where. The document has seven possible keys,
 * two of which anybody sets.
 *
 * The rest of the document is not the form's to lose. `pipeline`, `suites`,
 * `policy` and `remote` are edited rarely and by people who mean it, so the form
 * writes its two fields back into whatever was already there rather than
 * replacing it.
 */

/** What a proof profile can be, in the order the control plane documents them. */
export const PROFILES = ["fast", "fresh", "audited", "remote"] as const;

export type Profile = (typeof PROFILES)[number];

/** The same rule the policy parser holds suite ids to. */
const SUITE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface FormState {
  readonly profile: Profile;
  /** As typed: a comma or space separated list of suite ids. */
  readonly required: string;
}

/**
 * Read the form back out of a stored document.
 *
 * An organization that has never set defaults gets the same starting point the
 * control plane assumes, so the form opens on something true rather than empty.
 */
export function formOf(defaults: Record<string, unknown> | null): FormState {
  const profile = defaults?.["profile"];
  const required = defaults?.["required"];
  return {
    profile: PROFILES.includes(profile as Profile) ? (profile as Profile) : "fast",
    required: Array.isArray(required) ? required.join(", ") : "lint, typecheck, test",
  };
}

/** Suite ids as typed, split on commas or spaces, with the empties dropped. */
export function suiteList(typed: string): string[] {
  return typed
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * What is wrong with the form, said before anything is sent.
 *
 * The control plane refuses both of these already, and its refusals are written
 * for whoever committed a `thwip.yaml`. A person who has just typed the field is
 * better told which word is the problem.
 */
export function formRefusal(form: FormState): string | null {
  const ids = suiteList(form.required);
  if (ids.length === 0) return "Name at least one suite. A proof with nothing required proves nothing.";
  const bad = ids.filter((id) => !SUITE_ID.test(id));
  if (bad.length === 1) return `${bad[0]} is not a suite id. Use lower case letters, digits, dashes and underscores.`;
  if (bad.length > 1) {
    return `${bad.join(", ")} are not suite ids. Use lower case letters, digits, dashes and underscores.`;
  }
  const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicated.length > 0) return `${duplicated[0]} is listed twice.`;
  return null;
}

/**
 * The document to save: the form's two fields written into whatever was there.
 *
 * Replacing the document instead would quietly drop a `pipeline` or a `policy`
 * block the moment anybody changed the profile.
 */
export function documentOf(form: FormState, existing: Record<string, unknown> | null): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    version: typeof existing?.["version"] === "number" ? existing["version"] : 1,
    profile: form.profile,
    required: suiteList(form.required),
  };
}

/** Whether the document holds anything the form does not show. */
export function hasFieldsBeyondTheForm(defaults: Record<string, unknown> | null): boolean {
  if (defaults === null) return false;
  return Object.keys(defaults).some((key) => !["version", "profile", "required"].includes(key));
}
