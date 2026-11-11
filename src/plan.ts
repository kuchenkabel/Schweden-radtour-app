import type { LonLat } from "./geo";
import type { RouteProfile } from "./route";
import { DEFAULT_SETTINGS, type StageSettings } from "./stages";
import { load, save } from "./store";

export interface Person {
  name: string;
  birth?: string;
  allergies?: string;
  meds?: string;
  blood?: string;
  notes?: string;
}

export interface TourPlan {
  version: 1;
  name: string;
  startDate?: string;
  waypoints: LonLat[];
  line: LonLat[];
  /** Index jedes Wegpunkts in `line` (Abschnittsgrenzen) */
  cuts?: number[];
  /** Je Abschnitt: fest (z.B. aus GPX) statt neu berechenbar */
  legFixed?: boolean[];
  /** Routing-Profil */
  profile?: RouteProfile;
  settings: StageSettings;
  pinned: number[];
  /** Erledigte Etappen (Tag-Nr.) */
  done: number[];
  updated: string;
}

export function emptyPlan(): TourPlan {
  return {
    version: 1,
    name: "Schweden 2027",
    startDate: "2027-07-10",
    waypoints: [],
    line: [],
    settings: { ...DEFAULT_SETTINGS },
    pinned: [],
    done: [],
    updated: new Date().toISOString(),
  };
}

/** Ergänzt fehlende Felder (alte Versionen, Import, Sync), damit die App nie an einem halben Plan scheitert. */
export function normalizePlan(p: Partial<TourPlan> | null | undefined): TourPlan {
  const base = emptyPlan();
  if (!p || typeof p !== "object") return base;
  const arr = <T>(v: unknown, fb: T[]): T[] => (Array.isArray(v) ? (v as T[]) : fb);
  return {
    ...base,
    ...p,
    version: 1,
    waypoints: arr(p.waypoints, []),
    line: arr(p.line, []),
    cuts: Array.isArray(p.cuts) ? p.cuts : undefined,
    legFixed: Array.isArray(p.legFixed) ? p.legFixed : undefined,
    profile: p.profile === "trekking" || p.profile === "familie-flach" ? p.profile : "familie",
    pinned: arr(p.pinned, []),
    done: arr(p.done, []),
    settings: { ...DEFAULT_SETTINGS, ...(p.settings && typeof p.settings === "object" ? p.settings : {}) },
  };
}

export const loadPlan = async () => normalizePlan(await load<TourPlan | null>("plan", null));
export const savePlan = (p: TourPlan) => save("plan", { ...p, updated: new Date().toISOString() });

export const loadPeople = () =>
  load<Person[]>("people", [{ name: "Erwachsene/r 1" }, { name: "Erwachsene/r 2" }, { name: "Kind 13 J." }, { name: "Kind 8 J." }, { name: "Kleinkind" }]);
export const savePeople = (p: Person[]) => save("people", p);

export const loadChecks = () => load<Record<string, boolean>>("checks", {});
export const saveChecks = (c: Record<string, boolean>) => save("checks", c);
export const loadCustomItems = () => load<{ id: string; group: string; title: string }[]>("customItems", []);
export const saveCustomItems = (c: { id: string; group: string; title: string }[]) => save("customItems", c);

/** Datei-Format zum Teilen zwischen den Handys. */
export function exportPlanFile(plan: TourPlan, extras: { checks?: Record<string, boolean> } = {}): string {
  return JSON.stringify({ kind: "schweden-radtour-plan", plan, ...extras });
}

export function importPlanFile(text: string): { plan: TourPlan; checks?: Record<string, boolean> } {
  const j = JSON.parse(text);
  if (j.kind !== "schweden-radtour-plan" || !j.plan?.line) throw new Error("Keine Plan-Datei dieser App");
  return { plan: normalizePlan(j.plan), checks: j.checks };
}
