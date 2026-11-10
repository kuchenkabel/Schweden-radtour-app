import { load, save, saveQuiet, setChangeListener } from "./store";

/**
 * Sync zwischen Geräten über eine Datei in einem privaten GitHub-Repo (Contents-API).
 * Jedes Gerät hat Repo + Token lokal gespeichert. Synchronisiert werden nur die Plan-Daten,
 * Geräte-Sachen (Kartenpakete, Kartenhöhe, Esri-Schlüssel …) bleiben lokal.
 */
export const SYNC_KEYS = ["plan", "people", "checks", "customItems"] as const;
export type SyncKey = (typeof SYNC_KEYS)[number];
export type SyncData = Partial<Record<SyncKey, unknown>>;

export interface SyncConfig {
  repo: string; // "besitzer/name"
  token: string;
  path: string;
}

export interface SyncDoc {
  kind: "schweden-radtour-sync";
  version: 1;
  updated: string;
  device: string;
  data: SyncData;
}

interface SyncState {
  /** sha der Datei beim letzten erfolgreichen Abgleich */
  sha?: string;
  /** Lokale Änderungen, die noch nicht hochgeladen sind */
  dirty: boolean;
  lastSync?: string;
  lastError?: string;
}

export type Conflict = { remote: SyncDoc; localUpdated?: string };
export interface SyncHooks {
  /** Daten vom anderen Gerät übernehmen (Zustand neu laden, Ansicht neu zeichnen). */
  apply(data: SyncData): Promise<void>;
  /** Beide Seiten geändert: true = Stand vom anderen Gerät nehmen, false = eigenen behalten. */
  resolve(c: Conflict): Promise<boolean>;
  /** Status hat sich geändert (für die Anzeige). */
  status?(): void;
}

const API = "https://api.github.com";
const NO_WRITE = "Token darf nur lesen. Bitte beim Token unter Repository permissions „Contents: Read and write“ einstellen.";
const DEFAULT_PATH = "radtour-sync.json";
let hooks: SyncHooks | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let again = false;
/** Während eines Abgleichs lokal geändert: Markierung darf nicht verloren gehen. */
let changedDuringRun = false;

// ---------- Hilfen ----------
export function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Koordinaten auf 5 Nachkommastellen (≈1 m) kürzen, damit die Datei klein bleibt. */
export function compactPlan(plan: any): any {
  if (!plan || !Array.isArray(plan.line)) return plan;
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  const pts = (a: any[]) => a.map((p) => (Array.isArray(p) ? p.map((v: any) => (typeof v === "number" ? r(v) : v)) : p));
  return { ...plan, line: pts(plan.line), waypoints: Array.isArray(plan.waypoints) ? pts(plan.waypoints) : plan.waypoints };
}

/** Sync-Code für das zweite Gerät: Repo und Token in einer Zeile. */
export function makeSyncCode(c: SyncConfig): string {
  return "RT1-" + utf8ToBase64(JSON.stringify({ r: c.repo, t: c.token, p: c.path }));
}

export function parseSyncCode(code: string): SyncConfig {
  const s = code.trim();
  if (!s.startsWith("RT1-")) throw new Error("Das ist kein Sync-Code dieser App");
  const j = JSON.parse(base64ToUtf8(s.slice(4)));
  if (!j.r || !j.t) throw new Error("Sync-Code unvollständig");
  return { repo: j.r, token: j.t, path: j.p || DEFAULT_PATH };
}

export function normalizeRepo(input: string): string {
  const s = input.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(s)) throw new Error("Repo bitte als „besitzer/name“ angeben");
  return s;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return (window as any).Capacitor?.isNativePlatform?.() ? "Handy-App" : "Handy-Browser";
  return "Browser";
}

// ---------- GitHub ----------
async function gh(cfg: SyncConfig, path: string, init: RequestInit = {}, accept = "application/vnd.github+json"): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    cache: "no-store",
    headers: { Accept: accept, Authorization: `Bearer ${cfg.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(init.headers ?? {}) },
  });
}

async function ghError(res: Response): Promise<Error> {
  let msg = "";
  try { msg = (await res.json()).message ?? ""; } catch { /* egal */ }
  if (res.status === 401) return new Error("Token ungültig oder abgelaufen");
  if (res.status === 403) return new Error(`Kein Zugriff (${msg || "Token-Rechte prüfen"})`);
  if (res.status === 404) return new Error("Repo nicht gefunden oder Token hat keinen Zugriff darauf");
  return new Error(`GitHub ${res.status}${msg ? `: ${msg}` : ""}`);
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unerwartete Antwort von GitHub (${res.status}${text ? "" : ", leer"})`);
  }
}

const filePath = (cfg: SyncConfig) => `/repos/${cfg.repo}/contents/${cfg.path.split("/").map(encodeURIComponent).join("/")}`;

/** Prüft Repo und Token. Wirft bei Problemen, liefert eine Warnung bei öffentlichem Repo. */
export async function checkAccess(cfg: SyncConfig): Promise<{ warning?: string }> {
  const res = await gh(cfg, `/repos/${cfg.repo}`);
  if (!res.ok) throw await ghError(res);
  const repo = await readJson(res);
  if (repo.permissions && repo.permissions.push === false) throw new Error("Token darf in dieses Repo nicht schreiben (Contents: Read and write nötig)");
  // Schreibrecht prüfen, ohne etwas zu ändern: PUT mit absichtlich ungültigem Inhalt.
  // Token ohne Schreibrecht → 403, sonst lehnt GitHub den Inhalt ab (422) und nichts passiert.
  const probe = await gh(cfg, filePath(cfg), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Schreibtest", content: "%%% kein base64 %%%" }),
  });
  if (probe.status === 401 || probe.status === 403) throw new Error(NO_WRITE);
  return repo.private ? {} : { warning: "Achtung: Das Repo ist öffentlich! Plan und Notfalldaten wären für alle sichtbar." };
}

/** doc ist null, wenn die Datei leer oder kaputt ist (wird dann beim nächsten Hochladen überschrieben). */
export async function fetchRemote(cfg: SyncConfig): Promise<{ sha: string; doc: SyncDoc | null } | null> {
  const res = await gh(cfg, filePath(cfg));
  if (res.status === 404) {
    // Datei fehlt noch, oder Repo/Token falsch: Repo prüfen, damit wir nicht ins Leere schreiben
    const r = await gh(cfg, `/repos/${cfg.repo}`);
    if (!r.ok) throw await ghError(r);
    return null;
  }
  if (!res.ok) throw await ghError(res);
  const meta = await readJson(res);
  let text: string;
  if (meta.content && meta.encoding === "base64") {
    text = base64ToUtf8(meta.content);
  } else {
    // Dateien über 1 MB liefert die API nur roh
    const raw = await gh(cfg, filePath(cfg), {}, "application/vnd.github.raw+json");
    if (!raw.ok) throw await ghError(raw);
    text = await raw.text();
  }
  let doc: SyncDoc | null = null;
  try { doc = JSON.parse(text) as SyncDoc; } catch { /* leer oder kaputt */ }
  if (doc && doc.kind !== "schweden-radtour-sync") throw new Error(`${cfg.path} im Repo ist keine Sync-Datei dieser App`);
  return { sha: meta.sha, doc };
}

/** Lädt hoch. Liefert die neue sha oder null, wenn die Datei inzwischen woanders geändert wurde. */
export async function pushRemote(cfg: SyncConfig, doc: SyncDoc, sha?: string): Promise<string | null> {
  const body = { message: `Sync von ${doc.device} (${doc.updated.slice(0, 16).replace("T", " ")})`, content: utf8ToBase64(JSON.stringify(doc)), ...(sha ? { sha } : {}) };
  const res = await gh(cfg, filePath(cfg), { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  if (res.status === 409 || res.status === 422) return null;
  if (res.status === 403) throw new Error(NO_WRITE);
  if (!res.ok) throw await ghError(res);
  const j = await res.json().catch(() => null);
  if (!j?.content?.sha) throw new Error(`GitHub hat beim Hochladen unerwartet geantwortet (${res.status})`);
  return j.content.sha;
}

// ---------- Ablauf ----------
export const loadConfig = () => load<SyncConfig | null>("syncConfig", null);
const loadState = () => load<SyncState>("syncState", { dirty: false });
const saveState = (s: SyncState) => saveQuiet("syncState", s);
export const getState = loadState;

async function localData(): Promise<SyncData> {
  const out: SyncData = {};
  for (const k of SYNC_KEYS) {
    const v = await load<unknown>(k, undefined);
    if (v !== undefined) out[k] = k === "plan" ? compactPlan(v) : v;
  }
  return out;
}

async function applyRemote(doc: SyncDoc) {
  for (const k of SYNC_KEYS) if (doc.data[k] !== undefined) await saveQuiet(k, doc.data[k]);
  await hooks?.apply(doc.data);
}

/** Ein Abgleich: holen, ggf. übernehmen oder nachfragen, ggf. hochladen. */
async function runOnce(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg) return;
  const st = await loadState();
  changedDuringRun = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await fetchRemote(cfg);
      const remoteChanged = !!remote?.doc && remote.sha !== st.sha;
      if (remote?.doc && remoteChanged) {
        let takeRemote = !st.dirty;
        if (st.dirty) {
          const local = (await load<any>("plan", null))?.updated as string | undefined;
          takeRemote = await (hooks?.resolve({ remote: remote.doc!, localUpdated: local }) ?? Promise.resolve(false));
        }
        if (takeRemote) {
          await applyRemote(remote.doc!);
          Object.assign(st, { sha: remote.sha, dirty: false });
          break;
        }
      }
      if (!st.dirty && remote?.doc) { st.sha = remote.sha; break; }
      const doc: SyncDoc = { kind: "schweden-radtour-sync", version: 1, updated: new Date().toISOString(), device: deviceName(), data: await localData() };
      const sha = await pushRemote(cfg, doc, remote?.sha);
      if (sha) { Object.assign(st, { sha, dirty: false }); break; }
      // Jemand anderes war schneller: nochmal holen
    }
    st.lastSync = new Date().toISOString();
    st.lastError = undefined;
  } catch (e) {
    st.lastError = navigator.onLine !== false ? (e as Error).message : "Offline – wird nachgeholt";
    console.log(`[sync] ${st.lastError}`);
  }
  if (changedDuringRun) st.dirty = true;
  await saveState(st);
  hooks?.status?.();
}

/** Abgleich starten (mehrere Aufrufe kurz hintereinander werden zusammengefasst). */
export async function syncNow(): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    do { again = false; await runOnce(); } while (again);
  })();
  try { await running; } finally { running = null; }
}

export async function connect(cfg: SyncConfig): Promise<{ warning?: string }> {
  const res = await checkAccess(cfg);
  await save("syncConfig", cfg);
  // Erster Abgleich: Hat dieses Gerät schon einen Plan, soll er nicht still überschrieben werden
  const plan = await load<any>("plan", null);
  const hasLocal = !!plan && ((plan.line?.length ?? 0) > 1 || (plan.waypoints?.length ?? 0) > 0);
  await saveState({ dirty: hasLocal });
  await syncNow();
  const st = await loadState();
  if (st.lastError) throw new Error(st.lastError);
  return res;
}

export async function disconnect(): Promise<void> {
  await save("syncConfig", null);
  await saveState({ dirty: false });
}

export function setHooks(h: SyncHooks) {
  hooks = h;
}

/** Lokale Änderung vormerken (wird beim nächsten Abgleich hochgeladen). */
export async function markDirty(): Promise<void> {
  if (running) changedDuringRun = true;
  const st = await loadState();
  if (!st.dirty) await saveState({ ...st, dirty: true });
}

/** Einmal beim Start aufrufen. */
export function initSync(h: SyncHooks) {
  setHooks(h);
  setChangeListener(async (key) => {
    if (!(SYNC_KEYS as readonly string[]).includes(key)) return;
    if (!(await loadConfig())) return;
    await markDirty();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; syncNow(); }, 3000);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncNow();
    else if (timer) { clearTimeout(timer); timer = null; syncNow(); } // vor dem Wegwechseln noch hochladen
  });
  window.addEventListener("online", () => syncNow());
  syncNow();
}
