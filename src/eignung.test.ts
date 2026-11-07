import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { cellAt, compass, decodeCell, decodeGrid, MEADOW, MEADOW_HINT, regionFor, scan, type Grid } from "./eignung";

let header = { v: 1, w: 14, n: 56, dlon: 0.0008, dlat: 0.00045, nx: 40, ny: 40, cell: 50 };

/** bits: Untergrund g, Haus h, Hang s, Weg w, Wasser a, Flags */
const cell = (g: number, h: number, s: number, w: number, a: number, flags = 0) =>
  g | (h << 3) | (s << 6) | (w << 8) | (a << 10) | flags;
const GOOD = cell(1, 7, 0, 1, 1, 0x8000); // Score 100
const OK = cell(3, 5, 1, 2, 2, 0x8000);

function build(values: (i: number, j: number) => number): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const raw = Buffer.alloc(header.nx * header.ny * 2);
  for (let i = 0; i < header.ny; i++) for (let j = 0; j < header.nx; j++) raw.writeUInt16LE(values(i, j), (i * header.nx + j) * 2);
  const z = deflateSync(raw);
  const out = Buffer.alloc(8 + json.length + z.length);
  out.write("EIG1", 0, "ascii");
  out.writeUInt32LE(json.length, 4);
  Buffer.from(json).copy(out, 8);
  z.copy(out, 8 + json.length);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

const lonOf = (j: number) => header.w + (j + 0.5) * header.dlon;
const latOf = (i: number) => header.n - (i + 0.5) * header.dlat;

async function grid(): Promise<Grid> {
  return decodeGrid(
    build((i, j) => {
      if (i === 20 && j === 25) return GOOD;
      if (i === 21 && j === 25) return GOOD; // direkter Nachbar, wird durch Mindestabstand verdrängt
      if (i === 10 && j === 10) return OK;
      if (i === 20 && j === 20) return cell(1, 1, 0, 1, 1); // Haus 50-100 m, nicht geeignet
      return cell(5, 7, 0, 3, 3); // Moor
    }),
  );
}

describe("eignung", () => {
  it("decodes header and cells", async () => {
    const g = await grid();
    expect(g.header.nx).toBe(40);
    expect(g.data.length).toBe(1600);
    expect(g.data[20 * 40 + 25]).toBe(GOOD);
    expect(cellAt(g, lonOf(25), latOf(20))).toBe(GOOD);
    expect(cellAt(g, 0, 0)).toBeNull();
    const c = decodeCell(GOOD);
    expect(c).toMatchObject({ ground: 1, house: 7, slope: 0, way: 1, water: 1, suitable: true, reserve: false });
  });

  it("rejects bad magic", async () => {
    await expect(decodeGrid(new Uint8Array(16).buffer)).rejects.toThrow();
  });

  it("scans spots with spacing, score and reasons", async () => {
    const g = await grid();
    const center: [number, number] = [lonOf(20), latOf(20)];
    const r = scan(g, center, 1000);
    expect(r.suitableCount).toBe(3);
    expect(r.landCount).toBeGreaterThan(r.suitableCount);
    expect(r.spots.length).toBe(2); // GOOD (einmal), OK; Nachbar verdrängt
    expect(r.spots[0].score).toBe(100);
    expect(r.spots[1].score).toBe(Math.round(35 * 0.6 + 20 * 0.5 + 15 * 0.5 + 15 * 0.6 + 15 * 0.75));
    expect(r.spots[0].distM).toBeGreaterThan(200);
    expect(r.spots[0].reasons.join(" ")).toContain("Kiefernwald");
    expect(r.here.suitable).toBe(false);
    expect(r.here.reasons[0]).toContain("Haus nur 50–100 m");
  });

  it("limits to radius", async () => {
    const g = await grid();
    const r = scan(g, [lonOf(20), latOf(20)], 100);
    expect(r.spots.length).toBe(0);
    expect(r.suitableCount).toBe(0);
  });

  it("reports failure reasons for moor", async () => {
    const g = await grid();
    const r = scan(g, [lonOf(1), latOf(1)], 100);
    expect(r.here.reasons).toContain("Moor, Sumpf oder Acker – nicht zelten");
    expect(r.here.reasons).toContain("kein Weg innerhalb 300 m");
  });

  it("region and compass", () => {
    expect(regionFor(13, 55.7)?.id).toBe("skane");
    expect(regionFor(0, 0)).toBeNull();
    expect(compass(45)).toBe("NO");
    expect(compass(359)).toBe("N");
  });

  it("maps v1 Acker to 'Moor oder Acker' and keeps v2 Wiese", async () => {
    const v1 = await decodeGrid(build(() => cell(6, 7, 0, 1, 1)));
    expect(decodeCell(v1.data[0]).ground).toBe(5);
    header = { ...header, v: 2 };
    try {
      const v2 = await decodeGrid(build((i, j) => (i === 20 && j === 20 ? cell(MEADOW, 7, 0, 1, 1, 0x8000) : cell(5, 7, 0, 3, 3))));
      expect(decodeCell(v2.data[20 * 40 + 20]).ground).toBe(MEADOW);
      const r = scan(v2, [lonOf(20), latOf(20)], 300);
      expect(r.here.suitable).toBe(true);
      expect(r.spots[0].reasons).toContain(MEADOW_HINT);
    } finally {
      header = { ...header, v: 1 };
    }
  });
});
