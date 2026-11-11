import { describe, expect, it, vi } from "vitest";
vi.mock("./store", () => ({ load: async (_k: string, fb: unknown) => fb, save: async () => {} }));
import { importPlanFile, normalizePlan } from "./plan";
import { DEFAULT_SETTINGS } from "./stages";

describe("Plan robust laden", () => {
  it("ergänzt fehlende Einstellungen und Listen", () => {
    const p = normalizePlan({ name: "X", line: [[1, 2]] } as any);
    expect(p.settings).toEqual(DEFAULT_SETTINGS);
    expect(p.pinned).toEqual([]);
    expect(p.waypoints).toEqual([]);
    expect(p.name).toBe("X");
  });
  it("behält vorhandene Einstellungen", () => {
    const p = normalizePlan({ settings: { ...DEFAULT_SETTINGS, restAfter: 99 } } as any);
    expect(p.settings.restAfter).toBe(99);
  });
  it("übersteht Unsinn", () => {
    expect(normalizePlan(null).line).toEqual([]);
    expect(normalizePlan({ line: "kaputt" } as any).line).toEqual([]);
  });
  it("Import ohne Einstellungen", () => {
    const { plan } = importPlanFile(JSON.stringify({ kind: "schweden-radtour-plan", plan: { line: [[1, 2], [3, 4]] } }));
    expect(plan.settings).toEqual(DEFAULT_SETTINGS);
  });
});
