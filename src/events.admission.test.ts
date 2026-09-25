import type { IncomingMessage, ServerResponse } from "http";

// Session creation is held open by the test, so several opens can be in flight at once --
// the window in which admission has to count streams that are not yet sessions.
const pending: (() => void)[] = [];
jest.mock("better-sse", () => ({
  createSession: jest.fn(
    () =>
      new Promise((resolve) => {
        pending.push(() => resolve({ once: jest.fn(), isConnected: true, push: jest.fn() }));
      }),
  ),
}));

import { createSession } from "better-sse";
import { EventStreams, MaximumOpenStreams, TooManyStreamsError } from "./events";
import { VaultOperations } from "./vaultOperations";
import { App } from "../mocks/obsidian";

function streams(): EventStreams {
  const app = new App();
  // @ts-ignore: the mock App does not match Obsidian's App exactly
  const operations = new VaultOperations(app, {});
  // @ts-ignore: the mock App does not match Obsidian's App exactly
  return new EventStreams(app, operations);
}

const req = {} as IncomingMessage;
const res = {} as ServerResponse;

describe("EventStreams admission", () => {
  beforeEach(() => {
    pending.splice(0);
    (createSession as jest.Mock).mockClear();
  });

  test(`opens in flight together still admit at most ${MaximumOpenStreams}`, async () => {
    const events = streams();
    const subscription = events.subscribe("vault", "modify", null, 60);

    const opens = Array.from({ length: MaximumOpenStreams + 1 }, () =>
      events.open(subscription, req, res),
    );
    const results = Promise.allSettled(opens);
    for (const release of pending) release();

    const settled = await results;
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(
      MaximumOpenStreams,
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(TooManyStreamsError);
    expect(createSession).toHaveBeenCalledTimes(MaximumOpenStreams);
    expect(events.openStreamCount).toBe(MaximumOpenStreams);
  });

  test("a failed session creation gives its slot back", async () => {
    const events = streams();
    const subscription = events.subscribe("vault", "modify", null, 60);
    (createSession as jest.Mock).mockImplementationOnce(() =>
      Promise.reject(new Error("socket closed")),
    );

    await expect(events.open(subscription, req, res)).rejects.toThrow("socket closed");

    const opens = Array.from({ length: MaximumOpenStreams }, () =>
      events.open(subscription, req, res),
    );
    for (const release of pending) release();
    await expect(Promise.all(opens)).resolves.toHaveLength(MaximumOpenStreams);
  });
});
