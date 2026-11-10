import { beforeEach, describe, expect, it, vi } from "vitest";

// Zwei "Geräte" mit eigenem Speicher; der Test schaltet zwischen ihnen um.
const devices: Record<string, Map<string, string>> = { laptop: new Map(), handy: new Map() };
let current = "laptop";
vi.mock("./store", () => ({
  load: async (k: string, fb: unknown) => {
    const v = devices[current].get(k);
    return v ? JSON.parse(v) : fb;
  },
  save: async (k: string, v: unknown) => void devices[current].set(k, JSON.stringify(v)),
  saveQuiet: async (k: string, v: unknown) => void devices[current].set(k, JSON.stringify(v)),
  setChangeListener: () => {},
}));

import * as sync from "./sync";

// Minimaler Nachbau der GitHub-Contents-API
let file: { sha: string; content: string } | null = null;
let shaN = 0;
let readOnly = false;
function fakeGitHub() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/repos/fam/radtour-daten")) return json(200, { private: true, permissions: { push: true } });
    if (!url.includes("/contents/radtour-sync.json")) return json(404, { message: "Not Found" });
    if (!init.method || init.method === "GET") return file ? json(200, { sha: file.sha, encoding: "base64", content: file.content }) : json(404, { message: "Not Found" });
    if (readOnly) return json(403, { message: "Resource not accessible by personal access token" });
    const body = JSON.parse(init.body as string);
    if ((file?.sha ?? undefined) !== body.sha) return json(409, { message: "sha mismatch" });
    file = { sha: `s${++shaN}`, content: body.content };
    return json(200, { content: { sha: file.sha } });
  });
}

const cfg = { repo: "fam/radtour-daten", token: "t", path: "radtour-sync.json" };
const plan = (name: string) => ({ version: 1, name, waypoints: [[18.0712345678, 59.3]], line: [[18.0712345678, 59.3], [18.1, 59.4]], updated: new Date().toISOString() });
const get = (dev: string, k: string) => JSON.parse(devices[dev].get(k) ?? "null");
const remoteDoc = () => JSON.parse(sync.base64ToUtf8(file!.content));

describe("Sync-Hilfen", () => {
  it("Base64 mit Umlauten", () => {
    const s = "Åre – Göteborg 🚲 Smörgås";
    expect(sync.base64ToUtf8(sync.utf8ToBase64(s))).toBe(s);
  });
  it("Sync-Code hin und zurück", () => {
    expect(sync.parseSyncCode(sync.makeSyncCode(cfg))).toEqual(cfg);
    expect(() => sync.parseSyncCode("quatsch")).toThrow();
  });
  it("Repo-Angabe normalisieren", () => {
    expect(sync.normalizeRepo("https://github.com/fam/radtour-daten.git")).toBe("fam/radtour-daten");
    expect(() => sync.normalizeRepo("nur-name")).toThrow();
  });
});

describe("Sync-Ablauf", () => {
  const applied: string[] = [];
  let answer = true;
  beforeEach(() => {
    devices.laptop.clear();
    devices.handy.clear();
    file = null;
    readOnly = false;
    applied.length = 0;
    fakeGitHub();
    sync.setHooks({
      apply: async () => void applied.push(current),
      resolve: async () => answer,
    });
  });

  it("Laptop plant, Handy übernimmt, Handy ändert, Laptop übernimmt", async () => {
    current = "laptop";
    devices.laptop.set("plan", JSON.stringify(plan("Laptop-Plan")));
    await sync.connect(cfg);
    expect(remoteDoc().data.plan.name).toBe("Laptop-Plan");
    expect(remoteDoc().data.plan.line[0][0]).toBe(18.07123); // gekürzt

    current = "handy";
    await sync.connect(sync.parseSyncCode(sync.makeSyncCode(cfg)));
    expect(get("handy", "plan").name).toBe("Laptop-Plan");
    expect(applied).toEqual(["handy"]);

    devices.handy.set("plan", JSON.stringify(plan("Unterwegs geändert")));
    await sync.markDirty();
    await sync.syncNow();
    expect(remoteDoc().data.plan.name).toBe("Unterwegs geändert");

    current = "laptop";
    await sync.syncNow();
    expect(get("laptop", "plan").name).toBe("Unterwegs geändert");
  });

  it("Beide geändert: Rückfrage entscheidet", async () => {
    current = "laptop";
    devices.laptop.set("plan", JSON.stringify(plan("A")));
    await sync.connect(cfg);
    current = "handy";
    await sync.connect(cfg);

    devices.handy.set("plan", JSON.stringify(plan("Handy")));
    await sync.markDirty();
    await sync.syncNow();

    current = "laptop";
    devices.laptop.set("plan", JSON.stringify(plan("Laptop")));
    await sync.markDirty();
    answer = false; // eigenen Stand behalten
    await sync.syncNow();
    expect(remoteDoc().data.plan.name).toBe("Laptop");

    current = "handy";
    devices.handy.set("plan", JSON.stringify(plan("Handy 2")));
    await sync.markDirty();
    answer = true; // anderen übernehmen
    await sync.syncNow();
    expect(get("handy", "plan").name).toBe("Laptop");
    expect(remoteDoc().data.plan.name).toBe("Laptop");
  });

  it("Neues Gerät mit eigenem Plan wird nicht still überschrieben", async () => {
    current = "laptop";
    devices.laptop.set("plan", JSON.stringify(plan("A")));
    await sync.connect(cfg);
    current = "handy";
    devices.handy.set("plan", JSON.stringify(plan("B")));
    answer = false;
    await sync.connect(cfg);
    expect(get("handy", "plan").name).toBe("B");
    expect(remoteDoc().data.plan.name).toBe("B");
  });

  it("Token nur mit Leserecht: klare Meldung, nichts gespeichert", async () => {
    current = "laptop";
    readOnly = true;
    await expect(sync.connect(cfg)).rejects.toThrow(/Read and write/);
    expect(await sync.loadConfig()).toBeNull();
  });
});
