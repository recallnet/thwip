/** Read a `--name value` pair out of an argv array. Shared by every command that parses flags. */
export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
