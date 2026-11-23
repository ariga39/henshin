import { describe, expect, it } from "vitest"
import { OpenEventDeliveryScheduler } from "../src/main/OpenEventDeliveryScheduler"

const tick = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve))
}

describe("open event delivery scheduler", () => {
  it("serializes concurrent requests and runs one follow-up for an event accepted during a drain", async () => {
    let releaseFirst!: () => void
    const firstDrain = new Promise<void>((resolve) => { releaseFirst = resolve })
    let calls = 0
    const scheduler = new OpenEventDeliveryScheduler(async () => {
      calls += 1
      if (calls === 1) await firstDrain
    })

    scheduler.schedule()
    await tick()
    scheduler.schedule()
    scheduler.schedule()
    expect(calls).toBe(1)

    releaseFirst()
    await tick()
    await tick()
    expect(calls).toBe(2)
  })

  it("keeps a later request alive when one delivery attempt fails", async () => {
    let calls = 0
    const scheduler = new OpenEventDeliveryScheduler(async () => {
      calls += 1
      if (calls === 1) throw new Error("lost acknowledgment")
    })

    scheduler.schedule()
    await tick()
    scheduler.schedule()
    await tick()
    await tick()
    expect(calls).toBe(2)
  })
})
