// Taken from the OpenClaw upstream base (extensions/test-support/runtime-spies.ts).
import { vi } from "vitest";

export function createRuntimeSpies() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}
