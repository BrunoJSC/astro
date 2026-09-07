import type { KvClient } from "../../src/client";

export interface Call {
  args: unknown[];
  name: string;
}

/**
 * Records what would have been sent, and answers with whatever the test set up.
 *
 * The Lua scripts are not simulated -- they run on the server, and pretending
 * to reimplement them here would test the fake rather than the code. What these
 * tests cover is the layer around them: which keys are built, which arguments
 * are passed in which order, and how replies are turned back into types.
 * `scripts/validate.sh` covers the scripts themselves, against a real server.
 */
export function fakeClient(replies: Record<string, unknown> = {}): {
  calls: Call[];
  client: KvClient;
} {
  const calls: Call[] = [];

  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ args, name });
      return Promise.resolve(replies[name] ?? null);
    };

  const client = {
    del: record("del"),
    hdel: record("hdel"),
    hget: record("hget"),
    hgetall: record("hgetall"),
    hset: record("hset"),
    pipeline() {
      const queued: Call[] = [];
      const chain = {
        exec: () => {
          calls.push({ args: queued, name: "pipeline.exec" });
          return Promise.resolve(
            (replies["pipeline.exec"] as [Error | null, unknown][]) ?? []
          );
        },
        exists(...args: unknown[]) {
          queued.push({ args, name: "exists" });
          return chain;
        },
        hgetall(...args: unknown[]) {
          queued.push({ args, name: "hgetall" });
          return chain;
        },
      };
      return chain;
    },
    presenceDrop: record("presenceDrop"),
    presenceReap: record("presenceReap"),
    presenceTouch: record("presenceTouch"),
    publish: record("publish"),
    ratelimitTake: record("ratelimitTake"),
    smembers: record("smembers"),
    typingList: record("typingList"),
    typingStart: record("typingStart"),
    typingStop: record("typingStop"),
    voiceJoin: record("voiceJoin"),
    voiceLeave: record("voiceLeave"),
    zcount: record("zcount"),
  } as unknown as KvClient;

  return { calls, client };
}

export const only = (calls: Call[], name: string): Call[] =>
  calls.filter((call) => call.name === name);

/**
 * Waits until `condition` holds, rather than for a length of time.
 *
 * The three timer tests in this suite used to sleep for a fixed number of
 * milliseconds and then assert how many beats had happened -- 35ms for two
 * beats of a 10ms heartbeat, say. That is a bet on the machine, and it is one
 * the machine loses under load: measured, `beats on the interval` failed with
 * one beat where it wanted two, and because turbo SIGINTs the sibling tasks
 * when one fails, it took three other packages down with it and reported them
 * as the failures.
 *
 * Polling for the condition costs the same when things are fast, cannot fail
 * when they are slow, and still fails -- on the timeout -- when the behaviour
 * is actually missing.
 */
export async function waitFor(
  condition: () => boolean,
  { timeoutMs = 5000, what = "condition" } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`${what} did not hold within ${timeoutMs}ms`);
}
