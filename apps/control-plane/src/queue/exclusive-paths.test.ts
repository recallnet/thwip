import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { changedPathsBetweenTrees, matchingExclusivePaths, type GitTreeEntry } from "./exclusive-paths.js";

const execFileP = promisify(execFile);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(repository: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", args, { cwd: repository, encoding: "utf8" })).stdout;
}

async function treeAt(repository: string, revision: string): Promise<GitTreeEntry[]> {
  const output = await execFileP("git", ["ls-tree", "-rz", "--full-tree", revision], {
    cwd: repository,
    encoding: "buffer",
  });
  return output.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
      if (match === null) throw new Error(`unreadable ls-tree entry: ${line}`);
      return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
    });
}

/**
 * Differential coverage against Git itself. `--no-renames` asks Git for the
 * tree-level form the policy gate uses: both old and new names of a rename.
 */
describe("combined candidate path changes", () => {
  it("agrees with a real Git tree for adds, deletes, renames and mode changes", async () => {
    const repository = await mkdtemp(join(tmpdir(), "thwip-exclusive-paths-"));
    temporary.push(repository);
    await git(repository, "init", "-q");
    await git(repository, "config", "user.email", "test@example.com");
    await git(repository, "config", "user.name", "Thwip Test");
    await mkdir(join(repository, "migrations"), { recursive: true });
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, "migrations", "0032_old.sql"), "select 1;\n");
    await writeFile(join(repository, "src", "delete.ts"), "delete me\n");
    await writeFile(join(repository, "src", "mode.sh"), "#!/bin/sh\ntrue\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-qm", "base");
    const base = (await git(repository, "rev-parse", "HEAD")).trim();

    await rename(
      join(repository, "migrations", "0032_old.sql"),
      join(repository, "migrations", "0033_new.sql"),
    );
    await unlink(join(repository, "src", "delete.ts"));
    await chmod(join(repository, "src", "mode.sh"), 0o755);
    await writeFile(join(repository, "src", "added.ts"), "added\n");
    await git(repository, "add", "-A");
    await git(repository, "commit", "-qm", "candidate");
    const candidate = (await git(repository, "rev-parse", "HEAD")).trim();

    const expected = (await execFileP(
      "git",
      ["diff", "--no-renames", "--name-only", "-z", base, candidate],
      { cwd: repository, encoding: "buffer" },
    )).stdout.toString("utf8").split("\0").filter(Boolean).sort();
    const actual = changedPathsBetweenTrees(
      await treeAt(repository, `${base}^{tree}`),
      await treeAt(repository, `${candidate}^{tree}`),
    );

    expect(actual).toEqual({ status: "exact", paths: expected });
    expect(actual.status === "exact" && matchingExclusivePaths(actual.paths, ["migrations/**"])).toEqual([
      "migrations/0032_old.sql",
      "migrations/0033_new.sql",
    ]);
    expect((await readFile(join(repository, "src", "mode.sh"), "utf8"))).toContain("true");
  });

  it("handles a production-shaped large tree without dropping late changes", () => {
    const base = Array.from({ length: 5_000 }, (_, index) => ({
      path: `packages/p${String(index).padStart(4, "0")}/index.ts`,
      mode: "100644",
      type: "blob",
      sha: String(index).padStart(40, "0"),
    }));
    const candidate = base.map((entry) => ({ ...entry }));
    candidate[4_999] = { ...candidate[4_999]!, sha: "f".repeat(40) };
    expect(changedPathsBetweenTrees(base, candidate)).toEqual({
      status: "exact",
      paths: ["packages/p4999/index.ts"],
    });
  });

  it("fails closed on malformed or duplicate tree entries", () => {
    const valid = { path: "migrations/0033.sql", mode: "100644", type: "blob", sha: "a".repeat(40) };
    expect(changedPathsBetweenTrees([valid, valid], [valid])).toMatchObject({ status: "unreadable" });
    expect(changedPathsBetweenTrees([{ ...valid, path: "../outside" }], [valid])).toMatchObject({
      status: "unreadable",
    });
    expect(changedPathsBetweenTrees([null as unknown as GitTreeEntry], [valid])).toMatchObject({
      status: "unreadable",
    });
    expect(
      changedPathsBetweenTrees(
        [{ path: "migrations", mode: "not-a-mode", type: "tree", sha: "b".repeat(40) }],
        [],
      ),
    ).toMatchObject({ status: "unreadable" });
    expect(
      changedPathsBetweenTrees(
        [
          { path: "migrations", mode: "040000", type: "tree", sha: "b".repeat(40) },
          { ...valid, path: "migrations" },
        ],
        [],
      ),
    ).toMatchObject({ status: "unreadable" });
  });
});
