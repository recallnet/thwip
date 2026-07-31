import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BranchQueue } from "./BranchQueue.js";

/**
 * The retired Durable Object, on the real runtime.
 *
 * It used to be the queue. The queue is a D1 document now, and what matters about
 * this class is no longer what it can do but what it cannot. Every command it
 * used to accept was a way to write to a copy of the state that nothing reads,
 * and that is not hypothetical: the webhook handler went on calling it after the
 * move, so a closed pull request stayed in a queue nobody was looking at and held
 * the lane until somebody noticed by hand.
 *
 * That the commands are gone is a fact about the class, so TypeScript already
 * refuses any caller that still expects one — a stronger guarantee than a test,
 * and one that cannot drift. What only workerd can answer is whether the object
 * still routes, still reads what it stored, and stops asking to be woken.
 */

function stub(name: string) {
  return env.BRANCH_QUEUE.get(env.BRANCH_QUEUE.idFromName(name)) as unknown as BranchQueue;
}

describe("the retired branch queue object", () => {
  it("still answers for what it holds, so the old state can be read", async () => {
    expect(await stub("retired-2").snapshot()).toBeNull();
  });

  it("stops rather than rescheduling when an alarm reaches it", async () => {
    const id = env.BRANCH_QUEUE.idFromName("retired-3");
    await runInDurableObject(env.BRANCH_QUEUE.get(id), async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 50);
    });

    expect(await runDurableObjectAlarm(env.BRANCH_QUEUE.get(id))).toBe(true);
    const scheduled = await runInDurableObject(env.BRANCH_QUEUE.get(id), async (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(scheduled).toBeNull();
  });
});
