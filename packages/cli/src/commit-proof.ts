import { git } from "./git.js";
import { headProofState, type HeadProofState } from "./head-proof.js";

export interface CommitProofState {
  readonly message: string;
  readonly treeOid: string;
  readonly state: HeadProofState;
}

/** Read and classify the proof carried by one exact commit. */
export async function proofStateAtCommit(cwd: string, revision: string): Promise<CommitProofState> {
  const message = await git(["show", "-s", "--format=%B", revision], cwd);
  const treeOid = await git(["rev-parse", `${revision}^{tree}`], cwd);
  return { message, treeOid, state: headProofState(message, treeOid) };
}
