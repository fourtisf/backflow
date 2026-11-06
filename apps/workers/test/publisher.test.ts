import { describe, expect, it } from "vitest";
import { redisPublisher } from "../src/ctx";

describe("live publisher (D-056)", () => {
  it("never throws when Redis refuses us, and reports the error at most once a minute", async () => {
    const errors: unknown[] = [];
    const p = redisPublisher({ publish: async () => Promise.reject(new Error("NOAUTH Authentication required.")) }, (e) => errors.push(e));
    await expect(p.publish({ type: "hello", t: 1 } as never)).resolves.toBeUndefined();
    await expect(p.publish({ type: "hello", t: 2 } as never)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("publishes to the live channel when Redis works", async () => {
    const sent: [string, string][] = [];
    const p = redisPublisher({ publish: async (ch, msg) => (sent.push([ch, msg]), 1) });
    await p.publish({ type: "hello", t: 1 } as never);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]![1]).type).toBe("hello");
  });
});
