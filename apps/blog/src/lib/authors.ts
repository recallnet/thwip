import registry from "../data/authors.json";

export interface GithubProfile {
  htmlUrl: string;
  avatarUrl: string;
  blog: string | null;
  twitter: string | null;
}

export interface PersonAuthor {
  kind: "person";
  login: string;
  displayName: string;
  jobTitle: string;
  organization: string;
  bio: string;
  knowsAbout: string[];
  github: GithubProfile;
}

export interface AgentAuthor {
  kind: "agent";
  displayName: string;
  note: string;
}

export type Author = PersonAuthor | AgentAuthor;

const authors = registry as unknown as Record<string, Author>;

export function authorKeys(): string[] {
  return Object.keys(authors);
}

export function personKeys(): string[] {
  return authorKeys().filter((key) => authors[key].kind === "person");
}

export function authorFor(key: string): Author {
  const author = authors[key];
  if (author === undefined) {
    throw new Error(`unknown author "${key}"; add it to src/data/authors.json`);
  }
  return author;
}

export function personFor(key: string): PersonAuthor {
  const author = authorFor(key);
  if (author.kind !== "person") {
    throw new Error(`author "${key}" is an ${author.kind}, not a person`);
  }
  return author;
}

export function authorPath(key: string): string {
  return `/blog/authors/${key}/`;
}

/** Every place this person can be found, so a reader can corroborate the byline. */
function sameAs(person: PersonAuthor): string[] {
  const links = [person.github.htmlUrl];
  if (person.github.twitter) links.push(`https://x.com/${person.github.twitter}`);
  if (person.github.blog) links.push(person.github.blog);
  return links;
}

function personId(key: string, site: URL): string {
  return `${new URL(authorPath(key), site).href}#person`;
}

/** The full entity, for the author's own page. */
export function personJsonLd(key: string, site: URL): Record<string, unknown> {
  const person = personFor(key);
  return {
    "@type": "Person",
    "@id": personId(key, site),
    name: person.displayName,
    jobTitle: person.jobTitle,
    description: person.bio,
    url: new URL(authorPath(key), site).href,
    image: person.github.avatarUrl,
    sameAs: sameAs(person),
    knowsAbout: person.knowsAbout,
    worksFor: { "@type": "Organization", name: person.organization },
  };
}

/** The same entity by reference, for a post that this person wrote or reviewed. */
export function personRefJsonLd(key: string, site: URL): Record<string, unknown> {
  const person = personFor(key);
  return {
    "@type": "Person",
    "@id": personId(key, site),
    name: person.displayName,
    url: new URL(authorPath(key), site).href,
    image: person.github.avatarUrl,
    sameAs: sameAs(person),
  };
}
