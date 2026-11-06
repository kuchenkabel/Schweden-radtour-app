import "./style.css";
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Geolocation } from "@capacitor/geolocation";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import { bboxOf, cumulativeKm, haversineKm, projectOnLine, type LonLat } from "./geo";
import { CAT_INFO, EXTRA_LABELS, loadCamp, loadPois, poisAlongRoute, type Cat, type Poi, type PoiIndex, type RoutePoi } from "./pois";
import { alternativesNear, planStages, toDayPlan, type DayPlan, type Stage } from "./stages";
import { brouterRoute, parseGpx, toGpx } from "./route";
import { feasibleKm, headwind, smhiFireRisk, smhiForecast, windDirName, type WeatherHour } from "./weather";
import { compareRegions, REGIONS, type Region } from "./regions";
import { BLANK_STYLE, createMap, offlineStyle, ONLINE_STYLE, type MapView, type SatOptions } from "./map";
import { compass, loadGrid, regionFor, scan, type ScanResult } from "./eignung";
import { deletePack, downloadPack, isOnline, listPacks, type TilePack } from "./offline";
import {
  exportPlanFile, importPlanFile, loadChecks, loadCustomItems, loadPeople, loadPlan, saveChecks, saveCustomItems,
  savePeople, savePlan, type Person, type TourPlan,
} from "./plan";
import { load, save } from "./store";
import { PACKLISTE, VOR_DER_TOUR, type CheckGroup } from "./content/checklists";
import { ALLEMANSRAETT, NOTFALL_INFO, SCHWEDISCH_SAETZE, XIAOMI_HILFE } from "./content/texts";
import transportRules from "../data/transport-rules.json";

// ---------- Zustand ----------
type Tab = "planen" | "unterwegs" | "listen" | "notfall" | "mehr";

const S = {
  tab: "planen" as Tab,
  index: null as PoiIndex | null,
  plan: null as unknown as TourPlan,
  cum: [] as number[],
  routePois: [] as RoutePoi[],
  stages: [] as Stage[],
  days: [] as DayPlan[],
  visible: new Set<Cat>(["vindskydd", "camping", "stf", "badplats"]),
  nextCats: new Set<Cat>(["badplats", "wasser", "supermarkt", "vindskydd", "camping"]),
  pos: null as LonLat | null,
  posAccuracy: 0,
  online: navigator.onLine,
  packs: [] as TilePack[],
  addMode: false,
  showAllPois: false,
  weather: null as null | { at: string; hours: WeatherHour[]; fire?: { date: string; fwi: number; idx?: number }[] },
  checks: {} as Record<string, boolean>,
  custom: [] as { id: string; group: string; title: string }[],
  people: [] as Person[],
  mapSource: "auto" as string,
  busy: "",
  sat: false,
  esriKey: "",
  pickMode: false,
  eigRadius: 500,
  check: null as null | { center: LonLat; token: number },
};

let mv: MapView;
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const panel = () => $("#panel");

// ---------- Hilfen ----------
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const km = (v: number, digits = 0) => `${v.toLocaleString("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: digits })} km`;
const poiName = (p: Poi) => p.name || CAT_INFO[p.cat].label;

function toast(msg: string, ms = 2600) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function dateOfDay(day: number): Date | null {
  if (!S.plan.startDate) return null;
  const d = new Date(S.plan.startDate + "T12:00:00");
  d.setDate(d.getDate() + day - 1);
  return d;
}
const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric" }) : "");

function openSheet(html: string, bind?: (el: HTMLElement) => void) {
  const sh = $("#sheet");
  sh.innerHTML = `<button class="close" aria-label="Schließen">✕</button>${html}`;
  sh.hidden = false;
  sh.querySelector(".close")!.addEventListener("click", closeSheet);
  bind?.(sh);
}
function closeSheet() {
  $("#sheet").hidden = true;
  if (S.check) { S.check = null; mv?.setCheck(null); }
}

async function shareFile(name: string, content: string, mime: string, title: string) {
  if (Capacitor.isNativePlatform()) {
    const r = await Filesystem.writeFile({ path: name, data: content, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title, files: [r.uri], dialogTitle: title });
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    a.click();
  }
}

function pickFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = accept;
    inp.onchange = async () => resolve(inp.files?.[0] ? await inp.files[0].text() : null);
    inp.click();
  });
}

// ---------- Berechnung ----------
function recompute() {
  const line = S.plan.line;
  if (line.length > 1 && S.index) {
    S.cum = cumulativeKm(line);
    S.routePois = poisAlongRoute(S.index, line, 3, S.cum);
    S.stages = planStages(line, S.cum, S.routePois, S.plan.settings, S.plan.pinned);
    S.days = toDayPlan(S.stages, S.plan.settings.restAfter);
  } else {
    S.cum = [];
    S.routePois = [];
    S.stages = [];
    S.days = [];
  }
  updateMap();
}

function updateMap() {
  if (!mv) return;
  mv.setRoute(S.plan.line);
  mv.setWaypoints(S.tab === "planen" ? S.plan.waypoints : []);
  mv.setStages(S.days.filter((d) => d.stage).map((d) => d.stage!));
  const pois = S.plan.line.length > 1 && !S.showAllPois ? S.routePois.map((r) => r.poi) : S.index?.all ?? [];
  mv.setPois(pois, S.visible);
  mv.setPosition(S.pos);
}

function currentAlong(): { along: number; off: number } | null {
  if (!S.pos || S.plan.line.length < 2) return null;
  const pr = projectOnLine(S.pos, S.plan.line, S.cum);
  return { along: pr.alongKm, off: pr.offKm };
}

function todayStage(): Stage | null {
  const rides = S.days.filter((d) => d.stage).map((d) => d.stage!);
  if (!rides.length) return null;
  const cur = currentAlong();
  if (cur && cur.off < 5) return rides.find((s) => cur.along >= s.fromKm && cur.along < s.toKm) ?? rides[rides.length - 1];
  const now = new Date();
  const byDate = rides.find((s) => {
    const d = dateOfDay(s.day);
    return d && d.toDateString() === now.toDateString();
  });
  return byDate ?? rides.find((s) => !S.plan.done.includes(s.day)) ?? rides[0];
}

// ---------- Kartenquelle ----------
async function chooseMapStyle() {
  S.packs = await listPacks();
  const want = S.mapSource;
  if (want !== "auto") {
    const pack = S.packs.find((p) => p.region === want);
    if (pack) return mv.setStyle(offlineStyle(pack.uri, pack.region));
  }
  if (S.online) return mv.setStyle(ONLINE_STYLE);
  // Offline: Paket nehmen, das die Route bzw. Position abdeckt
  const ref = S.pos ?? S.plan.line[0];
  const pack =
    S.packs.find((p) => {
      const r = REGIONS.find((x) => x.id === p.region);
      return r && ref && ref[0] >= r.bbox[0] && ref[0] <= r.bbox[2] && ref[1] >= r.bbox[1] && ref[1] <= r.bbox[3];
    }) ?? S.packs[0];
  mv.setStyle(pack ? offlineStyle(pack.uri, pack.region) : BLANK_STYLE);
}

// ---------- Kartengröße: Ziehleiste + Vollbild ----------
function applyMapHeight(frac: number) {
  $("#app").style.setProperty("--map-h", `${Math.round(frac * 1000) / 10}dvh`);
}

function setMapFull(on: boolean) {
  $("#app").classList.toggle("mapfull", on);
  const b = $("#mapfull");
  b.textContent = on ? "⤡" : "⤢";
  b.setAttribute("aria-label", on ? "Karte verkleinern" : "Karte vergrößern");
  setTimeout(() => mv?.map.resize(), 50);
}

async function initSplitter() {
  const app = $("#app");
  const bar = $("#splitter");
  let frac = await load<number>("mapHeight", 0.42);
  applyMapHeight(frac);
  $("#mapfull").addEventListener("click", (e) => {
    e.stopPropagation();
    setMapFull(!app.classList.contains("mapfull"));
  });
  let dragging = false;
  let frame = 0;
  bar.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("drag");
  });
  bar.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const vh = window.innerHeight;
    const top = $("#map").getBoundingClientRect().top;
    const reserve = $("#tabs").getBoundingClientRect().height + bar.getBoundingClientRect().height + 60;
    const px = Math.min(Math.max(e.clientY - top, vh * 0.12), vh - top - reserve);
    frac = px / vh;
    if (app.classList.contains("mapfull")) setMapFull(false);
    applyMapHeight(frac);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => mv?.map.resize());
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove("drag");
    mv?.map.resize();
    save("mapHeight", frac);
  };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  window.addEventListener("resize", () => mv?.map.resize());
}

// ---------- Darstellung: Tabs ----------
function setTab(tab: Tab) {
  S.tab = tab;
  document.querySelectorAll("nav#tabs button").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.tab === tab));
  $("#app").classList.toggle("nomap", tab === "listen" || tab === "mehr");
  if (tab !== "planen") S.addMode = false;
  render();
  panel().scrollTop = 0;
  updateMap();
  setTimeout(() => mv?.map.resize(), 50);
}

function render() {
  const fn = { planen: renderPlanen, unterwegs: renderUnterwegs, listen: renderListen, notfall: renderNotfall, mehr: renderMehr }[S.tab];
  panel().innerHTML = fn();
  bindCommon();
  ({ planen: bindPlanen, unterwegs: bindUnterwegs, listen: bindListen, notfall: bindNotfall, mehr: bindMehr })[S.tab]();
  $("#net").textContent = S.online ? "online" : "offline";
}

function catChips(set: Set<Cat>, cats: Cat[], name: string) {
  return `<div class="chips">${cats
    .map((c) => `<button class="chip ${set.has(c) ? "on" : ""}" data-${name}="${c}">${CAT_INFO[c].icon} ${esc(CAT_INFO[c].label)}</button>`)
    .join("")}</div>`;
}

function bindCommon() {
  panel().querySelectorAll<HTMLElement>("[data-layer]").forEach((b) =>
    b.addEventListener("click", () => {
      const c = b.dataset.layer as Cat;
      S.visible.has(c) ? S.visible.delete(c) : S.visible.add(c);
      b.classList.toggle("on");
      mv.setVisibleCats(S.visible);
      save("visibleCats", [...S.visible]);
    }),
  );
}

// ---------- Planen ----------
function renderPlanen(): string {
  const p = S.plan;
  const hasRoute = p.line.length > 1;
  const total = hasRoute ? S.cum[S.cum.length - 1] : 0;
  const rideDays = S.stages.length;
  const allDays = S.days.length;
  let html = "";

  if (!S.index) html += `<div class="card muted">${esc(S.busy || "Lade Ortsdaten …")}</div>`;

  html += `<h2>Kartenebenen</h2>${catChips(S.visible, Object.keys(CAT_INFO) as Cat[], "layer")}`;

  if (!hasRoute) {
    html += `<h2>1. Region wählen</h2>
      <p class="muted">Dichte pro 1.000 km² aus OpenStreetMap. Punkte: gewichtet nach eurem Konzept (Badestellen und Schlafplätze zählen am meisten). Antippen zeigt die Region.</p>
      <div class="card"><table><tr><th>Region</th><th class="num">Punkte</th><th class="num">🏊</th><th class="num">⛺</th><th class="num">🏕️</th><th class="num">🚆</th></tr>
      ${
        S.index
          ? compareRegions(S.index)
              .map(
                (s) => `<tr class="click" data-region="${s.region.id}"><td><b>${esc(s.region.name)}</b><br><span class="muted">${esc(s.region.hint)}</span></td>
                <td class="num"><b>${s.score}</b></td><td class="num">${(s.density.badplats ?? 0).toFixed(1)}</td><td class="num">${(s.density.vindskydd ?? 0).toFixed(1)}</td>
                <td class="num">${(s.density.camping ?? 0).toFixed(1)}</td><td class="num">${(s.density.bahnhof ?? 0).toFixed(1)}</td></tr>`,
              )
              .join("")
          : ""
      }</table></div>`;
  }

  html += `<h2>${hasRoute ? "Route" : "2. Route erstellen"}</h2><div class="card">
    <div class="row">
      <button class="btn ${S.addMode ? "on" : "secondary"}" id="addMode">${S.addMode ? "Punkte setzen: an" : "📍 Punkte auf Karte setzen"}</button>
      <button class="btn" id="calcRoute" ${p.waypoints.length < 2 ? "disabled" : ""}>Route berechnen</button>
      <button class="btn secondary" id="importGpx">GPX importieren</button>
    </div>
    ${
      p.waypoints.length
        ? `<div style="margin-top:8px">${p.waypoints
            .map((w, i) => `<div class="row between list-item"><span>${i === 0 ? "Start" : i === p.waypoints.length - 1 ? "Ziel" : `Zwischenpunkt ${i}`} <span class="muted">${w[1].toFixed(3)}, ${w[0].toFixed(3)}</span></span><button class="btn small danger" data-delwp="${i}">✕</button></div>`)
            .join("")}</div>`
        : `<p class="muted">Tippe „Punkte auf Karte setzen“ und dann Start, Zwischenpunkte und Ziel auf die Karte. Das Fahrrad-Routing (BRouter) braucht Internet.</p>`
    }
    ${hasRoute ? `<p><b>${esc(p.name)}</b>: ${km(total)} · ${S.routePois.length} Orte im 3-km-Korridor</p>
      <div class="row"><button class="btn small secondary" id="toggleAll">${S.showAllPois ? "Nur Orte an der Route" : "Alle Orte zeigen"}</button>
      <button class="btn small danger" id="resetRoute">Route löschen</button></div>` : ""}
  </div>`;

  if (hasRoute) {
    const st = p.settings;
    const over = allDays > st.days;
    html += `<h2>3. Etappen</h2><div class="card">
      <div class="row"><label>Start <input type="date" id="startDate" value="${esc(p.startDate ?? "")}"></label>
      <label>Tage <input type="number" id="sDays" min="1" max="60" value="${st.days}"></label></div>
      <div class="row" style="margin-top:6px"><label>km/Tag <input type="number" id="sMin" value="${st.minKm}"> – <input type="number" id="sMax" value="${st.maxKm}"></label>
      <label>Ziel <input type="number" id="sTarget" value="${st.targetKm}"></label>
      <label>Ruhetag nach <input type="number" id="sRest" min="0" max="10" value="${st.restAfter}"> Tagen</label></div>
      <p>${rideDays} Fahrtage + ${allDays - rideDays} Ruhetage = <b class="${over ? "warn" : ""}">${allDays} Tage</b> von ${st.days}.
      ${over ? `<span class="warn">Die Route ist für ${st.days} Tage zu lang: kürzen oder ein Stück mit dem Zug fahren.</span>` : `${st.days - allDays} Puffertage übrig.`}</p>
      <p class="muted">Höhenmeter zählen mit: ${st.hmPerKm} Hm ≈ 1 km mehr. ${p.pinned.length ? `${p.pinned.length} Schlafplatz/-plätze von Hand fixiert. <button class="btn small secondary" id="unpin">Zurücksetzen</button>` : ""}</p>
      <div class="row"><button class="btn secondary" id="sharePlan">Plan teilen</button><button class="btn secondary" id="importPlan">Plan importieren</button></div>
    </div>`;
    html += S.days.map((d) => dayCard(d)).join("");
  } else {
    html += `<div class="row"><button class="btn secondary" id="importPlan">Plan von anderem Handy importieren</button></div>`;
  }
  return html;
}

function dayCard(d: DayPlan): string {
  const date = fmtDate(dateOfDay(d.day));
  if (d.type === "rest") return `<div class="card day rest"><b>Tag ${d.day}</b> <span class="muted">${date}</span> · Ruhetag 🏖️</div>`;
  const s = d.stage!;
  const done = S.plan.done.includes(s.day);
  return `<div class="card day ${done ? "done" : ""}" data-day="${s.day}">
    <div class="row between"><b>Tag ${s.day} <span class="muted">${date}</span></b><b>${km(s.km)}</b></div>
    <div class="muted">↗ ${s.up} Hm ↘ ${s.down} Hm · km ${Math.round(s.fromKm)}–${Math.round(s.toKm)}</div>
    <div>🌙 ${s.end ? `${CAT_INFO[s.end.cat].icon} ${esc(poiName(s.end))}${s.endOffKm > 0.3 ? ` <span class="muted">(${km(s.endOffKm, 1)} abseits)</span>` : ""}` : "Ziel"}</div>
    ${s.lunch ? `<div>🍽️ Mittag: 🏊 ${esc(poiName(s.lunch))}</div>` : ""}
    ${s.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}
    <div class="row" style="margin-top:6px"><button class="btn small secondary" data-zoom="${s.day}">Zeigen</button>
    ${s.end ? `<button class="btn small secondary" data-move="${s.day}">Schlafplatz ändern</button>` : ""}</div>
  </div>`;
}

function bindPlanen() {
  panel().querySelectorAll<HTMLElement>("[data-region]").forEach((tr) =>
    tr.addEventListener("click", () => {
      const r = REGIONS.find((x) => x.id === tr.dataset.region)!;
      mv.fit(r.bbox);
    }),
  );
  $("#addMode")?.addEventListener("click", () => {
    S.addMode = !S.addMode;
    if (S.addMode) toast("Tippe auf die Karte, um Punkte zu setzen");
    render();
  });
  panel().querySelectorAll<HTMLElement>("[data-delwp]").forEach((b) =>
    b.addEventListener("click", () => {
      S.plan.waypoints.splice(Number(b.dataset.delwp), 1);
      savePlan(S.plan);
      updateMap();
      render();
    }),
  );
  $("#calcRoute")?.addEventListener("click", calcRoute);
  $("#importGpx")?.addEventListener("click", async () => {
    const text = await pickFile(".gpx,application/gpx+xml,application/xml,text/xml,*/*");
    if (!text) return;
    try {
      const { name, line } = parseGpx(text);
      S.plan = { ...S.plan, name, line, waypoints: [line[0], line[line.length - 1]], pinned: [], done: [] };
      await savePlan(S.plan);
      recompute();
      mv.fit(bboxOf(line));
      render();
      toast(`Route „${name}“ importiert`);
    } catch (e) {
      toast(String((e as Error).message));
    }
  });
  $("#toggleAll")?.addEventListener("click", () => { S.showAllPois = !S.showAllPois; updateMap(); render(); });
  $("#resetRoute")?.addEventListener("click", async () => {
    S.plan = { ...S.plan, line: [], waypoints: [], pinned: [], done: [] };
    await savePlan(S.plan);
    recompute();
    render();
  });
  const num = (id: string) => Number(($(`#${id}`) as HTMLInputElement).value);
  ["sDays", "sMin", "sMax", "sTarget", "sRest"].forEach((id) =>
    $(`#${id}`)?.addEventListener("change", async () => {
      const st = S.plan.settings;
      st.days = num("sDays") || st.days;
      st.minKm = num("sMin") || st.minKm;
      st.maxKm = Math.max(st.minKm, num("sMax") || st.maxKm);
      st.targetKm = Math.min(st.maxKm, Math.max(st.minKm, num("sTarget") || st.targetKm));
      st.restAfter = Math.max(0, num("sRest"));
      await savePlan(S.plan);
      recompute();
      render();
    }),
  );
  $("#startDate")?.addEventListener("change", async (e) => {
    S.plan.startDate = (e.target as HTMLInputElement).value;
    await savePlan(S.plan);
    render();
  });
  $("#unpin")?.addEventListener("click", async () => { S.plan.pinned = []; await savePlan(S.plan); recompute(); render(); });
  $("#sharePlan")?.addEventListener("click", () =>
    shareFile("radtour-plan.json", exportPlanFile(S.plan, { checks: S.checks }), "application/json", "Tourplan teilen"),
  );
  $("#importPlan")?.addEventListener("click", async () => {
    const text = await pickFile(".json,application/json,*/*");
    if (!text) return;
    try {
      const { plan, checks } = importPlanFile(text);
      S.plan = plan;
      if (checks) { S.checks = { ...S.checks, ...checks }; await saveChecks(S.checks); }
      await savePlan(S.plan);
      recompute();
      if (plan.line.length > 1) mv.fit(bboxOf(plan.line));
      render();
      toast("Plan importiert");
    } catch (e) {
      toast(String((e as Error).message));
    }
  });
  panel().querySelectorAll<HTMLElement>("[data-zoom]").forEach((b) =>
    b.addEventListener("click", () => {
      const s = S.stages.find((x) => x.day === Number(b.dataset.zoom))!;
      zoomStage(s);
    }),
  );
  panel().querySelectorAll<HTMLElement>("[data-move]").forEach((b) =>
    b.addEventListener("click", () => moveStageEnd(Number(b.dataset.move))),
  );
}

function zoomStage(s: Stage) {
  const i0 = S.cum.findIndex((c) => c >= s.fromKm);
  let i1 = S.cum.findIndex((c) => c >= s.toKm);
  if (i1 < 0) i1 = S.cum.length - 1;
  mv.fit(bboxOf(S.plan.line.slice(Math.max(0, i0), i1 + 1)));
}

async function calcRoute() {
  if (S.plan.waypoints.length < 2) return;
  const btn = $("#calcRoute") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Berechne …";
  try {
    // Abschnittsweise, damit lange Touren nicht am Server-Zeitlimit scheitern
    const wps = S.plan.waypoints;
    const line: LonLat[] = [];
    for (let i = 0; i < wps.length - 1; i++) {
      btn.textContent = `Berechne ${i + 1}/${wps.length - 1} …`;
      const part = await brouterRoute([wps[i], wps[i + 1]]);
      line.push(...(i === 0 ? part : part.slice(1)));
    }
    S.plan = { ...S.plan, line, pinned: [], done: [] };
    await savePlan(S.plan);
    S.addMode = false;
    recompute();
    mv.fit(bboxOf(line));
    render();
  } catch (e) {
    toast(`Routing fehlgeschlagen: ${(e as Error).message}. Internet da?`, 4000);
    render();
  }
}

function moveStageEnd(day: number) {
  const s = S.stages.find((x) => x.day === day);
  if (!s || !s.end) return;
  const alts = alternativesNear(S.routePois, s.toKm, 15, S.plan.settings.sleepCorridorKm);
  openSheet(
    `<h3>Schlafplatz für Tag ${day}</h3><p class="muted">Aktuell: ${esc(poiName(s.end))}. Etappe dann:</p>
    ${alts
      .map((a) => {
        const len = a.alongKm - s.fromKm + a.offKm;
        return `<div class="list-item click" data-pick="${a.poi.id}"><span class="ico">${CAT_INFO[a.poi.cat].icon}</span>
        <div class="main"><b>${esc(poiName(a.poi))}</b><div class="muted">${esc(CAT_INFO[a.poi.cat].label)} · ${km(a.offKm, 1)} abseits</div></div>
        <span class="dist">${km(len)}</span></div>`;
      })
      .join("")}`,
    (el) =>
      el.querySelectorAll<HTMLElement>("[data-pick]").forEach((it) =>
        it.addEventListener("click", async () => {
          const id = Number(it.dataset.pick);
          S.plan.pinned = S.plan.pinned.filter((p) => p !== s.end!.id);
          // Fixierungen dieses Tages durch die neue ersetzen
          S.plan.pinned = S.plan.pinned.filter((p) => {
            const rp = S.routePois.find((r) => r.poi.id === p);
            return !rp || rp.alongKm <= s.fromKm || rp.alongKm >= s.toKm + 15;
          });
          S.plan.pinned.push(id);
          await savePlan(S.plan);
          closeSheet();
          recompute();
          render();
        }),
      ),
  );
}

// ---------- Unterwegs ----------
/** Kleinkram nur zeigen, wenn er wirklich am Weg liegt */
const MINOR = new Set<Cat>(["spielplatz", "wc", "wasser", "supermarkt"]);

function renderUnterwegs(): string {
  if (S.plan.line.length < 2) return `<div class="card">Noch keine Route. Plane sie unter <b>Planen</b> oder importiere einen Plan.</div>${bailoutHtml()}`;
  const cur = currentAlong();
  const along = cur && cur.off < 5 ? cur.along : todayStage()?.fromKm ?? 0;
  const ahead = S.routePois.filter((r) => r.alongKm > along - 0.2);
  const nextBad = ahead.find((r) => r.poi.cat === "badplats");
  const stage = todayStage();
  let html = "";

  html += `<div class="card hero">${
    nextBad
      ? `<div class="muted">Nächste Badestelle</div><div class="big">${km(nextBad.alongKm - along + nextBad.offKm, 1)}</div><div>🏊 ${esc(poiName(nextBad.poi))}</div>`
      : `<div>Keine Badestelle mehr auf der Route.</div>`
  }
  ${!S.pos ? `<p class="muted">Kein GPS: Entfernungen ab Etappenstart.</p>` : cur && cur.off >= 5 ? `<p class="warn">Du bist ${km(cur.off, 1)} von der Route entfernt.</p>` : ""}
  </div>`;

  if (stage) {
    const rest = Math.max(0, stage.toKm - along);
    html += `<div class="card"><div class="row between"><b>Heute: Tag ${stage.day}</b><span>${km(rest, 1)} bis zum Ziel</span></div>
      <div>🌙 ${stage.end ? esc(poiName(stage.end)) : "Ziel"} · ↗ ${stage.up} Hm</div>
      ${stage.lunch ? `<div>🍽️ Mittag: ${esc(poiName(stage.lunch))}</div>` : ""}
      <div id="weatherBox">${weatherHtml(stage, along)}</div>
      <div class="row" style="margin-top:8px"><button class="btn" id="osmand">In OsmAnd/Organic Maps öffnen</button>
      <button class="btn secondary" id="doneStage">${S.plan.done.includes(stage.day) ? "Erledigt ✓" : "Etappe erledigt"}</button></div></div>`;
  }

  html += `<h2>Was kommt als Nächstes</h2>${catChips(S.nextCats, ["badplats", "spielplatz", "wasser", "wc", "supermarkt", "vindskydd", "zeltplatz", "camping", "stf", "radladen", "gas", "apotek", "bahnhof"], "next")}
    <div class="card">${
      ahead
        .filter((r) => S.nextCats.has(r.poi.cat) && r.alongKm - along < 80 && r.offKm <= (MINOR.has(r.poi.cat) ? 1 : 3))
        .slice(0, 40)
        .map(
          (r) => `<div class="list-item click" data-poi="${r.poi.id}"><span class="ico">${CAT_INFO[r.poi.cat].icon}</span>
          <div class="main"><b>${esc(poiName(r.poi))}</b><div class="muted">${esc(CAT_INFO[r.poi.cat].label)}${r.offKm > 0.3 ? ` · ${km(r.offKm, 1)} abseits` : ""}${r.poi.x.oh ? ` · ${esc(r.poi.x.oh)}` : ""}</div></div>
          <span class="dist">${km(Math.max(0, r.alongKm - along), 1)}</span></div>`,
        )
        .join("") || `<p class="muted">Nichts in den nächsten 80 km.</p>`
    }</div>`;
  html += bailoutHtml();
  return html;
}

function weatherHtml(stage: Stage, along: number): string {
  const w = S.weather;
  if (!w) return `<p class="muted">${S.online ? "Wetter wird geladen …" : "Wetter nur mit Internet."}</p>`;
  const today = new Date();
  const hrs = w.hours.filter((h) => h.time.toDateString() === today.toDateString() && h.time.getHours() >= 9 && h.time.getHours() <= 16);
  const tomorrow = new Date(today.getTime() + 86400000);
  const hrsT = w.hours.filter((h) => h.time.toDateString() === tomorrow.toDateString() && h.time.getHours() >= 9 && h.time.getHours() <= 16);
  const sum = (arr: WeatherHour[], label: string, fromKm: number, plannedKm: number) => {
    if (!arr.length) return "";
    const ws = arr.reduce((a, h) => a + h.wind, 0) / arr.length;
    // Vektor-Mittel der Windrichtung
    const vx = arr.reduce((a, h) => a + Math.sin((h.windFrom * Math.PI) / 180), 0);
    const vy = arr.reduce((a, h) => a + Math.cos((h.windFrom * Math.PI) / 180), 0);
    const wd = ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360;
    const rain = arr.reduce((a, h) => a + h.precip, 0);
    const temp = Math.max(...arr.map((h) => h.temp ?? -99));
    const hw = headwind(S.plan.line, S.cum, fromKm, fromKm + plannedKm, wd, ws);
    const feas = feasibleKm(plannedKm, hw);
    return `<div style="margin-top:6px"><b>${label}</b>: ${temp > -99 ? `${Math.round(temp)} °C · ` : ""}Wind ${ws.toFixed(1)} m/s aus ${windDirName(wd)} · Regen ${rain.toFixed(1)} mm<br>
      ${hw > 1 ? `<span class="warn">Gegenwind ${hw.toFixed(1)} m/s: eher ${km(feas)} statt ${km(plannedKm)} planen.</span>` : hw < -1 ? `Rückenwind ${(-hw).toFixed(1)} m/s 👍` : "Kaum Gegenwind."}</div>`;
  };
  const next = S.stages.find((s) => s.day === stage.day + 1);
  const fire = w.fire?.find((f) => f.date === today.toISOString().slice(0, 10)) ?? w.fire?.[0];
  const fireTxt = fire && fire.idx !== undefined && fire.idx >= 0
    ? ["", "sehr gering", "gering", "mäßig", "hoch", "sehr hoch", "extrem hoch"][Math.round(fire.idx)] ?? String(fire.idx)
    : null;
  return (
    sum(hrs, "Heute", along, Math.max(1, stage.toKm - along)) +
    (next ? sum(hrsT, "Morgen", next.fromKm, next.km) : "") +
    (fireTxt ? `<div style="margin-top:6px">🔥 Brandrisiko (SMHI): <b>${fireTxt}</b>${fire!.idx! >= 4 ? ` <span class="warn">Eldningsförbud wahrscheinlich, Gaskocher nutzen.</span>` : ""}</div>` : "") +
    `<div class="muted">Feuerverbot gilt je Län: <a href="https://www.msb.se/sv/amnesomraden/skydd-mot-olyckor-och-farliga-amnen/naturolyckor-och-klimat/skogsbrand/brandrisk-och-eldningsforbud/" target="_blank">Infos MSB/Länsstyrelse</a> · Stand ${esc(w.at)}</div>`
  );
}

async function refreshWeather() {
  const ref = S.pos ?? (todayStage()?.end ? ([todayStage()!.end!.lon, todayStage()!.end!.lat] as LonLat) : S.plan.line[0]);
  if (!ref || !S.online) return;
  try {
    const [hours, fire] = await Promise.all([smhiForecast(ref[0], ref[1]), smhiFireRisk(ref[0], ref[1]).catch(() => undefined)]);
    S.weather = { at: new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }), hours, fire };
    await save("weather", { ...S.weather, hours: hours.map((h) => ({ ...h, time: h.time.toISOString() })) });
    if (S.tab === "unterwegs") render();
  } catch {
    /* offline oder SMHI nicht erreichbar: alten Stand behalten */
  }
}

const RULES_BY_REGION: Record<string, string[]> = {
  skane: ["skanetrafiken", "oresundstag"], halland: ["hallandstrafiken", "oresundstag", "vasttrafik"],
  bohuslan: ["vasttrafik"], vastergotland: ["vasttrafik", "jlt"], smaland: ["kalmar", "kronoberg", "jlt"],
  blekinge: ["blekingetrafiken", "oresundstag"], ostergotland: ["ostgotatrafiken", "sormland", "malartag"],
  malardalen: ["sl", "ul", "malartag"], varmland: ["varmland", "vasttrafik"], dalarna: ["dalatrafik"], gotland: [],
};
type Rule = (typeof transportRules)[number];
const TRAILER_TXT: Record<string, string> = { yes: "Anhänger erlaubt", limited: "Anhänger eingeschränkt", no: "Anhänger nicht erlaubt", unknown: "Anhänger: keine Angabe, eher nicht" };

function rulesFor(pt: LonLat | null): Rule[] {
  if (!pt) return [];
  const ids = new Set<string>();
  for (const r of REGIONS) {
    if (pt[0] >= r.bbox[0] && pt[0] <= r.bbox[2] && pt[1] >= r.bbox[1] && pt[1] <= r.bbox[3]) (RULES_BY_REGION[r.id] ?? []).forEach((i) => ids.add(i));
  }
  return (transportRules as Rule[]).filter((r) => ids.has(r.id));
}

function bailoutHtml(): string {
  const ref = S.pos ?? (S.plan.line.length ? S.plan.line[0] : null);
  const stations = ref && S.index ? S.index.nearest(ref, new Set<Cat>(["bahnhof"]), 60, 3) : [];
  const rules = rulesFor(ref);
  return `<h2>Abbruch-Plan (Bail-out)</h2><div class="card">
    ${stations.length ? stations.map((s) => `<div class="list-item click" data-poi="${s.poi.id}"><span class="ico">🚆</span><div class="main"><b>${esc(poiName(s.poi))}</b><div class="muted">${esc(s.poi.x.op ?? "")}</div></div><span class="dist">${km(s.km, 1)}</span></div>`).join("") : `<p class="muted">${ref ? "Kein Bahnhof im Umkreis von 60 km." : "Position unbekannt."}</p>`}
    ${rules.map((r) => `<details><summary><b>${esc(r.name)}</b>: ${esc(TRAILER_TXT[r.trailer] ?? r.trailer)}</summary><p>🚲 ${esc(r.bikesNote)}</p><p>🛺 ${esc(r.trailerNote)}</p>${r.cost ? `<p>💶 ${esc(r.cost)}</p>` : ""}${r.restrictions ? `<p>⏱ ${esc(r.restrictions)}</p>` : ""}<p class="muted"><a href="${esc(r.sourceUrl)}" target="_blank">Quelle</a>, Stand ${esc(r.checkedDate)}</p></details>`).join("")}
    <p><b>Mit Anhänger:</b> Kein Verkehrsverbund erlaubt Kinderanhänger ausdrücklich. Realistisch: Großraumtaxi („storbil“) über die örtliche Taxizentrale bestellen, Anhänger und Kleinkind damit, die anderen mit Rad und Zug.</p>
  </div>`;
}

function bindUnterwegs() {
  panel().querySelectorAll<HTMLElement>("[data-next]").forEach((b) =>
    b.addEventListener("click", () => {
      const c = b.dataset.next as Cat;
      S.nextCats.has(c) ? S.nextCats.delete(c) : S.nextCats.add(c);
      save("nextCats", [...S.nextCats]);
      render();
    }),
  );
  bindPoiClicks();
  $("#osmand")?.addEventListener("click", () => {
    const s = todayStage();
    if (!s) return;
    const i0 = Math.max(0, S.cum.findIndex((c) => c >= s.fromKm));
    let i1 = S.cum.findIndex((c) => c >= s.toKm);
    if (i1 < 0) i1 = S.cum.length - 1;
    const pts = S.plan.line.slice(i0, i1 + 1);
    if (s.end) pts.push([s.end.lon, s.end.lat]);
    shareFile(`etappe-tag-${s.day}.gpx`, toGpx(`Tag ${s.day}: ${s.end ? poiName(s.end) : "Ziel"}`, pts), "application/gpx+xml", "Etappe öffnen mit …");
  });
  $("#doneStage")?.addEventListener("click", async () => {
    const s = todayStage();
    if (!s) return;
    S.plan.done = S.plan.done.includes(s.day) ? S.plan.done.filter((d) => d !== s.day) : [...S.plan.done, s.day];
    await savePlan(S.plan);
    render();
  });
}

function bindPoiClicks() {
  panel().querySelectorAll<HTMLElement>("[data-poi]").forEach((it) =>
    it.addEventListener("click", () => {
      const p = S.index?.all[Number(it.dataset.poi)];
      if (p) showPoi(p);
    }),
  );
}

const SHELTER_TYPES: Record<string, string> = {
  lean_to: "Windschutzhütte (Vindskydd)", basic_hut: "Einfache Hütte", weather_shelter: "Wetterschutz",
  picnic_shelter: "Picknickdach", pavilion: "Pavillon",
};

const HIDDEN_EXTRAS = new Set(["ver", "vsrc", "neu"]);

/** Hinweis, ob ein Vindskydd von einer zweiten Quelle bestätigt ist. */
function verifyBadge(p: Poi): string {
  if (p.cat !== "vindskydd") return "";
  if (p.x.neu)
    return `<p>🟡 <b>Nur bei ${esc(p.x.vsrc || "einer Behörde")} verzeichnet</b>, nicht in OpenStreetMap. Lage kann ungenau sein.</p>`;
  if (p.x.ver)
    return `<p>✅ <b>Bestätigt</b> durch ${esc(p.x.vsrc || (p.x.ver === "nv" ? "Naturvårdsverket" : "Kommune"))} (zweite, unabhängige Quelle).</p>`;
  return `<p>⚪ <b>Nur OpenStreetMap</b>, keine zweite Quelle gefunden. Vorher im Luftbild oder vor Ort prüfen.</p>`;
}

function showPoi(p: Poi) {
  const rows = p.cat === "zeltplatz" ? "" : Object.entries(p.x)
    .filter(([k]) => !HIDDEN_EXTRAS.has(k))
    .map(([k, v]) => {
      const label = EXTRA_LABELS[k] ?? k;
      if (k === "typ") v = SHELTER_TYPES[v] ?? v;
      const val = k === "web" ? `<a href="${esc(v)}" target="_blank">${esc(v)}</a>` : k === "tel" ? `<a href="tel:${esc(v.replace(/\s/g, ""))}">${esc(v)}</a>` : esc(v);
      return `<tr><th>${esc(label)}</th><td>${val}</td></tr>`;
    })
    .join("");
  const dist = S.pos ? ` · ${km(haversineKm(S.pos, [p.lon, p.lat]), 1)} Luftlinie` : "";
  let camp = "";
  if (p.cat === "zeltplatz") {
    const sc = Number(p.x.sc);
    const [col, txt] = sc >= 75 ? ["#2e7d32", "gut"] : sc >= 60 ? ["#f9a825", "brauchbar"] : ["#ef6c00", "mäßig"];
    camp = `<p><b><span style="color:${col}">●</span> ${txt}</b> (Score ${esc(p.x.sc)}/100)</p><ul>
      <li>Untergrund: ${esc(p.x.gr)}</li>
      <li>Nächstes Gebäude: ${esc(p.x.hs)} m (Jedermannsrecht: außer Sicht von Häusern, Faustregel mind. 150–200 m)</li>
      <li>Neigung: ca. ${esc(p.x.sl)}°</li>
      <li>Weg/Zufahrt: ${esc(p.x.ac)} m</li>
      <li>${p.x.wa === "9999" ? "kein See/Fluss in der Nähe" : `Wasser: ${esc(p.x.wa)} m`}</li>
      ${p.x.res ? `<li>⚠️ Liegt in einem Naturschutzgebiet: Zelt-Regeln vor Ort prüfen</li>` : ""}</ul>
      <p class="muted">Berechnet aus offenen Daten (Marktäcke Naturvårdsverket, Höhenmodell Copernicus, OpenStreetMap). Steine, Wurzeln, Hanglage im Kleinen und Privatgrund sieht die Analyse nicht. Höchstens 1–2 Nächte, Abstand halten, nichts hinterlassen.</p>`;
  }
  const hint =
    p.cat === "unterstand"
      ? `<p class="muted">In OpenStreetMap ist hier nur ein Unterstand ohne genaue Art eingetragen (oft ein Picknickdach oder Wetterschutz). Ob man darin schlafen kann, ist unsicher.</p>`
      : verifyBadge(p);
  const sat = `https://www.google.com/maps/@?api=1&map_action=map&center=${p.lat},${p.lon}&zoom=19&basemap=satellite`;
  openSheet(
    `<h3>${CAT_INFO[p.cat].icon} ${esc(poiName(p))}</h3><p class="muted">${esc(CAT_INFO[p.cat].label)}${dist}</p>
    ${hint}
    ${camp}
    ${p.cat === "zeltplatz" ? "" : rows ? `<table>${rows}</table>` : `<p class="muted">Keine weiteren Angaben in OpenStreetMap.</p>`}
    ${p.cat === "vindskydd" || p.cat === "unterstand" || p.cat === "huette" || p.cat === "zeltplatz" ? `<p><a href="${sat}" target="_blank">Luftbild ansehen (online)</a></p>` : ""}
    <div class="row" style="margin-top:10px"><a class="btn" href="geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}(${encodeURIComponent(poiName(p))})">Navigieren</a>
    <button class="btn secondary" id="poiZoom">Auf Karte</button>
    <button class="btn secondary" id="poiSat">Luftbild in der App</button></div>`,
    (el) => {
      el.querySelector("#poiZoom")!.addEventListener("click", () => {
        mv.map.flyTo({ center: [p.lon, p.lat], zoom: 15 });
        closeSheet();
      });
      el.querySelector("#poiSat")!.addEventListener("click", async () => {
        await setSat(true);
        mv.map.flyTo({ center: [p.lon, p.lat], zoom: 17 });
        closeSheet();
      });
    },
  );
}

// ---------- Luftbild ----------
function satOptions(): SatOptions {
  if (S.esriKey) {
    return {
      tiles: `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(S.esriKey)}`,
      maxzoom: 19,
      attribution: "Esri, Maxar, Earthstar Geographics",
    };
  }
  return {
    tiles: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
    maxzoom: 15,
    attribution: "Sentinel-2 cloudless 2016 by EOX IT Services GmbH (Copernicus Sentinel data 2016), CC BY 4.0",
  };
}

function applySat() {
  mv.setSatellite(S.sat ? satOptions() : null);
  $("#btnSat").classList.toggle("on", S.sat);
}

async function setSat(on: boolean) {
  if (on && !S.online) {
    toast("Luftbild braucht Internet");
    S.sat = false;
    applySat();
    return;
  }
  S.sat = on;
  applySat();
  await save("sat", on);
  if (on && !S.esriKey && !(await load("satHintShown", false))) {
    toast("Grobes Satellitenbild (10 m). Für scharfe Luftbilder Esri-Schlüssel in den Einstellungen eintragen.", 6000);
    await save("satHintShown", true);
  }
}

// ---------- Punkt prüfen (Wildcamping-Eignung) ----------
function setPickMode(on: boolean) {
  S.pickMode = on;
  if (on) S.addMode = false;
  mv.setPickMode(on);
  $("#btnPick").classList.toggle("on", on);
  $("#pickhint").hidden = !on;
}

const eigColor = (sc: number): [string, string, string] =>
  sc >= 75 ? ["#2e7d32", "grün", "gut"] : sc >= 60 ? ["#f9a825", "gelb", "brauchbar"] : ["#ef6c00", "orange", "mäßig"];
const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} km` : `${Math.round(m / 10) * 10} m`);
const RADII: [number, string][] = [[200, "200 m"], [500, "500 m"], [1000, "1 km"], [3000, "3 km"]];

function radiusChips() {
  return `<div class="chips">${RADII.map(([r, l]) => `<button class="chip ${S.eigRadius === r ? "on" : ""}" data-rad="${r}">${l}</button>`).join("")}</div>`;
}

async function checkPoint(center: LonLat) {
  setPickMode(false);
  const token = (S.check?.token ?? 0) + 1;
  S.check = { center, token };
  mv.setCheck({ center, radiusM: S.eigRadius, spots: [] });
  const head = `<h3>📍 Punkt prüfen</h3>${radiusChips()}`;
  const bindChips = (el: HTMLElement) =>
    el.querySelectorAll<HTMLElement>("[data-rad]").forEach((b) =>
      b.addEventListener("click", async () => {
        S.eigRadius = Number(b.dataset.rad);
        await save("eignungRadius", S.eigRadius);
        checkPoint(center);
      }),
    );
  const show = (html: string, bind?: (el: HTMLElement) => void) => {
    if (S.check?.token !== token) return;
    // closeSheet() würde die Prüfung löschen, daher Sheet direkt neu füllen
    const keep = S.check;
    openSheet(head + html, (el) => { bindChips(el); bind?.(el); });
    S.check = keep;
  };
  show(`<p class="muted">Prüfe …</p>`);
  const region = regionFor(center[0], center[1]);
  if (!region) return show(`<p class="warn">Dieser Punkt liegt außerhalb der Regionen mit Eignungskarte.</p>`);
  let res: ScanResult;
  try {
    res = scan(await loadGrid(region.id), center, S.eigRadius);
  } catch (e) {
    return show(`<p class="warn">${esc((e as Error).message)}</p>`);
  }
  if (S.check?.token !== token) return;
  const spots = res.spots;
  mv.setCheck({
    center, radiusM: S.eigRadius,
    spots: spots.map((sp, i) => ({ lon: sp.lon, lat: sp.lat, label: String(i + 1), color: eigColor(sp.score)[0] })),
  });
  const here = res.here.suitable
    ? `<p><b>✅ geeignet</b> – dieser Punkt erfüllt alle Regeln.</p>`
    : `<p><b>❌ nicht geeignet</b></p><ul>${res.here.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`;
  const list = spots.length
    ? spots.map((sp, i) => {
        const [col, , txt] = eigColor(sp.score);
        const name = `Schlafplatz ${i + 1}`;
        return `<div class="spot"><div class="hd" data-spot="${i}"><b>${i + 1}. <span style="color:${col}">●</span> ${txt}</b> (${sp.score}/100) · ${fmtM(sp.distM)} ${compass(sp.bearing)}</div>
          <ul>${sp.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
          <div class="row"><a class="btn small" href="geo:${sp.lat},${sp.lon}?q=${sp.lat},${sp.lon}(${encodeURIComponent(name)})">Navigieren</a>
          <button class="btn small secondary" data-sat="${i}">Luftbild</button></div></div>`;
      }).join("")
    : `<p class="muted">Keine geeignete Stelle im Umkreis. Größeren Radius wählen.</p>`;
  show(
    `${here}<h3>Beste Stellen im Umkreis</h3>
    <p class="muted">${res.suitableCount} von ${res.landCount} Landflächen-Rasterzellen im Umkreis sind geeignet.</p>${list}
    <p class="muted">Grundlage: Marktäcke Naturvårdsverket, Copernicus-Höhenmodell, OpenStreetMap; Raster 50 m. Steine, Wurzeln, Privatgrund und Verbotsschilder sieht die Analyse nicht – vor Ort prüfen. Höchstens 1–2 Nächte, Abstand halten.</p>`,
    (el) => {
      el.querySelectorAll<HTMLElement>("[data-spot]").forEach((h) =>
        h.addEventListener("click", () => {
          const sp = spots[Number(h.dataset.spot)];
          mv.map.flyTo({ center: [sp.lon, sp.lat], zoom: 16 });
        }),
      );
      el.querySelectorAll<HTMLElement>("[data-sat]").forEach((b) =>
        b.addEventListener("click", async () => {
          const sp = spots[Number(b.dataset.sat)];
          await setSat(true);
          mv.map.flyTo({ center: [sp.lon, sp.lat], zoom: S.esriKey ? 17 : 15 });
        }),
      );
    },
  );
}

// ---------- Listen ----------
function renderListen(): string {
  const groups = (title: string, list: CheckGroup[], withDue: boolean) => {
    const items = list.flatMap((g) => g.items);
    const doneCount = items.filter((i) => S.checks[i.id]).length + S.custom.filter((c) => S.checks[c.id] && list.some((g) => g.id === c.group)).length;
    const totalCount = items.length + S.custom.filter((c) => list.some((g) => g.id === c.group)).length;
    return `<h2>${title}</h2><div class="bar"><div style="width:${totalCount ? (doneCount / totalCount) * 100 : 0}%"></div></div>
      <p class="progress">${doneCount} von ${totalCount} erledigt</p>
      ${list
        .map(
          (g) => `<div class="card"><h3>${esc(g.title)}</h3>
          ${g.items
            .map((i) => {
              let due = "";
              if (withDue && i.dueDaysBefore && S.plan.startDate) {
                const d = new Date(S.plan.startDate + "T12:00:00");
                d.setDate(d.getDate() - i.dueDaysBefore);
                const late = !S.checks[i.id] && d < new Date();
                due = `<span class="${late ? "warn" : "muted"}"> · bis ${d.toLocaleDateString("de-DE")}</span>`;
              }
              return `<label class="check ${S.checks[i.id] ? "done" : ""}"><input type="checkbox" data-check="${i.id}" ${S.checks[i.id] ? "checked" : ""}>
              <div><div class="t">${esc(i.title)}${due}</div>${i.note ? `<div class="muted">${esc(i.note)}</div>` : ""}</div></label>`;
            })
            .join("")}
          ${S.custom
            .filter((c) => c.group === g.id)
            .map((c) => `<label class="check ${S.checks[c.id] ? "done" : ""}"><input type="checkbox" data-check="${c.id}" ${S.checks[c.id] ? "checked" : ""}><div class="t">${esc(c.title)}</div><button class="btn small danger" data-delcustom="${c.id}" style="margin-left:auto">✕</button></label>`)
            .join("")}
          <div class="row" style="margin-top:6px"><input placeholder="Eigener Punkt" data-newin="${g.id}" style="flex:1"><button class="btn small secondary" data-add="${g.id}">+</button></div>
        </div>`,
        )
        .join("")}`;
  };
  return groups("Vor der Tour", VOR_DER_TOUR, true) + groups("Packliste", PACKLISTE, false) +
    `<div class="row"><button class="btn danger" id="resetChecks">Packliste zurücksetzen</button></div>`;
}

function bindListen() {
  panel().querySelectorAll<HTMLInputElement>("[data-check]").forEach((cb) =>
    cb.addEventListener("change", async () => {
      S.checks[cb.dataset.check!] = cb.checked;
      cb.closest(".check")?.classList.toggle("done", cb.checked);
      await saveChecks(S.checks);
    }),
  );
  panel().querySelectorAll<HTMLElement>("[data-add]").forEach((b) =>
    b.addEventListener("click", async () => {
      const g = b.dataset.add!;
      const inp = panel().querySelector<HTMLInputElement>(`[data-newin="${g}"]`)!;
      if (!inp.value.trim()) return;
      S.custom.push({ id: `custom-${Date.now()}`, group: g, title: inp.value.trim() });
      await saveCustomItems(S.custom);
      render();
    }),
  );
  panel().querySelectorAll<HTMLElement>("[data-delcustom]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      S.custom = S.custom.filter((c) => c.id !== b.dataset.delcustom);
      await saveCustomItems(S.custom);
      render();
    }),
  );
  $("#resetChecks")?.addEventListener("click", async () => {
    for (const g of PACKLISTE) for (const i of g.items) delete S.checks[i.id];
    await saveChecks(S.checks);
    render();
  });
}

// ---------- Notfall ----------
function renderNotfall(): string {
  const near = (cats: Cat[]) =>
    S.pos && S.index
      ? S.index.nearest(S.pos, new Set(cats), 80, 3)
          .map((r) => `<div class="list-item click" data-poi="${r.poi.id}"><span class="ico">${CAT_INFO[r.poi.cat].icon}</span><div class="main"><b>${esc(poiName(r.poi))}</b>
            <div class="muted">${r.poi.x.oh ? esc(r.poi.x.oh) : ""}</div>${r.poi.x.tel ? `<a href="tel:${esc(r.poi.x.tel.replace(/\s/g, ""))}">${esc(r.poi.x.tel)}</a>` : ""}</div><span class="dist">${km(r.km, 1)}</span></div>`)
          .join("") || `<p class="muted">Nichts im Umkreis von 80 km.</p>`
      : `<p class="muted">Für die nächsten Orte bitte GPS erlauben.</p>`;
  return `<div class="card row"><a class="btn danger" href="tel:112" style="font-size:18px">📞 112 Notruf</a><a class="btn secondary" href="tel:1177">1177 Vårdguiden</a>
    <button class="btn secondary" id="smsPos">📍 Standort per SMS</button></div>
    <h2>Nächste Apotheke</h2><div class="card">${near(["apotek"])}</div>
    <h2>Nächste Vårdcentral / Klinik</h2><div class="card">${near(["vard"])}</div>
    <h2>Notfallkarten</h2>
    ${S.people.map((p, i) => `<div class="card"><div class="row between"><b>${esc(p.name)}</b><button class="btn small secondary" data-editp="${i}">Bearbeiten</button></div>
      ${p.birth ? `<div>Geb.: ${esc(p.birth)}</div>` : ""}${p.blood ? `<div>Blutgruppe: ${esc(p.blood)}</div>` : ""}
      ${p.allergies ? `<div class="warn">Allergien: ${esc(p.allergies)}</div>` : ""}${p.meds ? `<div>Medikamente: ${esc(p.meds)}</div>` : ""}${p.notes ? `<div class="muted">${esc(p.notes)}</div>` : ""}</div>`).join("")}
    <div class="card content">${NOTFALL_INFO}</div>
    <h2>Schwedisch für den Notfall</h2><div class="card"><table>${SCHWEDISCH_SAETZE.map((s) => `<tr><td>${esc(s.de)}</td><td><b>${esc(s.sv)}</b></td></tr>`).join("")}</table></div>`;
}

function bindNotfall() {
  bindPoiClicks();
  $("#smsPos")?.addEventListener("click", () => {
    if (!S.pos) return toast("Position noch unbekannt");
    const [lon, lat] = S.pos;
    const body = `Unser Standort: ${lat.toFixed(5)}, ${lon.toFixed(5)} https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=16/${lat.toFixed(5)}/${lon.toFixed(5)}`;
    location.href = `sms:?body=${encodeURIComponent(body)}`;
  });
  panel().querySelectorAll<HTMLElement>("[data-editp]").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.editp);
      const p = S.people[i];
      const f = (k: keyof Person, label: string) => `<label style="display:block;margin:6px 0">${label}<br><input data-f="${k}" value="${esc(p[k] ?? "")}" style="width:100%"></label>`;
      openSheet(
        `<h3>Notfallkarte</h3>${f("name", "Name")}${f("birth", "Geburtsdatum")}${f("blood", "Blutgruppe")}${f("allergies", "Allergien")}${f("meds", "Medikamente")}${f("notes", "Sonstiges (z.B. Versicherungsnr.)")}
        <button class="btn" id="saveP">Speichern</button>`,
        (el) => el.querySelector("#saveP")!.addEventListener("click", async () => {
          el.querySelectorAll<HTMLInputElement>("[data-f]").forEach((inp) => ((p as any)[inp.dataset.f!] = inp.value.trim()));
          await savePeople(S.people);
          closeSheet();
          render();
        }),
      );
    }),
  );
}

// ---------- Mehr ----------
function renderMehr(): string {
  const packFor = (r: Region) => S.packs.find((p) => p.region === r.id);
  return `<h2>Offline-Karten</h2>
    <p class="muted">Vor der Abfahrt im WLAN laden. Ein Paket pro Region, je etwa 30–150 MB. Orte, Etappen und Listen funktionieren auch ohne Kartenpaket offline.</p>
    <div class="card">${REGIONS.map((r) => {
      const p = packFor(r);
      return `<div class="list-item"><div class="main"><b>${esc(r.name)}</b><div class="muted">${p ? `geladen ${esc(p.date)} · ${(p.bytes / 1e6).toFixed(0)} MB` : "nicht geladen"}</div><div class="progress" id="prog-${r.id}"></div></div>
        ${p ? `<button class="btn small danger" data-delpack="${r.id}">Löschen</button>` : `<button class="btn small" data-getpack="${r.id}">Laden</button>`}</div>`;
    }).join("")}</div>
    <div class="card"><label>Kartenquelle <select id="mapSource"><option value="auto">Automatisch (online, sonst Paket)</option>
      ${S.packs.map((p) => `<option value="${p.region}" ${S.mapSource === p.region ? "selected" : ""}>Offline: ${esc(REGIONS.find((r) => r.id === p.region)?.name ?? p.region)}</option>`).join("")}</select></label></div>
    <h2>Luftbild (Esri)</h2><div class="card"><p class="muted">Kostenloses Konto auf location.arcgis.com anlegen, unter Developer credentials einen API-Schlüssel mit dem Recht 'Basemaps' erstellen und hier einfügen. Der Schlüssel bleibt nur auf diesem Handy.</p>
      <input type="password" id="esriKey" placeholder="API-Schlüssel" value="${esc(S.esriKey)}" autocomplete="off" style="width:100%">
      <div class="row" style="margin-top:8px"><button class="btn small" id="esriSave">Speichern</button><button class="btn small danger" id="esriDel">Löschen</button></div></div>
    <h2>Erinnerungen</h2><div class="card"><p>Während der Tour täglich um 8:30 „Wind und Etappe checken“ und um 15:30 „Camp aufbauen, Wasser auffüllen, Zeckencheck“.</p>
      <button class="btn" id="notify">Erinnerungen einplanen</button></div>
    <h2>Xiaomi-Handys einrichten</h2><div class="card content">${XIAOMI_HILFE}</div>
    <h2>Allemansrätten</h2><div class="card content">${ALLEMANSRAETT}</div>
    <h2>Fähren nach Schweden</h2><div class="card">${(transportRules as Rule[]).filter((r) => r.type === "ferry").map((r) => `<details><summary><b>${esc(r.name)}</b></summary><p>🚲 ${esc(r.bikesNote)}</p><p>🛺 ${esc(r.trailerNote)}</p>${r.cost ? `<p>💶 ${esc(r.cost)}</p>` : ""}<p class="muted"><a href="${esc(r.sourceUrl)}" target="_blank">Quelle</a>, Stand ${esc(r.checkedDate)}</p></details>`).join("")}</div>
    <h2>Über die App</h2><div class="card muted">Ortsdaten: © OpenStreetMap-Mitwirkende (ODbL), Stand ${esc(S.index?.generated ?? "?")}. Karten: OpenFreeMap / Protomaps. Routing: BRouter. Wetter und Brandrisiko: SMHI (CC BY 4.0). Zugregeln: eigene Recherche, vor der Reise prüfen.</div>`;
}

function bindMehr() {
  panel().querySelectorAll<HTMLElement>("[data-getpack]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.getpack!;
      const prog = $(`#prog-${id}`);
      (b as HTMLButtonElement).disabled = true;
      try {
        await downloadPack(id, (pct, mb) => (prog.textContent = pct >= 0 ? `${pct} % (${mb.toFixed(0)} MB)` : `${mb.toFixed(0)} MB …`));
        S.packs = await listPacks();
        toast("Kartenpaket geladen");
      } catch (e) {
        toast(`Download fehlgeschlagen: ${(e as Error).message}`, 4000);
      }
      render();
    }),
  );
  panel().querySelectorAll<HTMLElement>("[data-delpack]").forEach((b) =>
    b.addEventListener("click", async () => {
      await deletePack(b.dataset.delpack!);
      S.packs = await listPacks();
      if (S.mapSource === b.dataset.delpack) S.mapSource = "auto";
      render();
    }),
  );
  $("#mapSource")?.addEventListener("change", async (e) => {
    S.mapSource = (e.target as HTMLSelectElement).value;
    await save("mapSource", S.mapSource);
    await chooseMapStyle();
  });
  $("#notify")?.addEventListener("click", scheduleReminders);
  const setKey = async (k: string) => {
    S.esriKey = k;
    await save("esriKey", k);
    if (S.sat) applySat();
    toast(k ? "Schlüssel gespeichert" : "Schlüssel gelöscht");
    render();
  };
  $("#esriSave")?.addEventListener("click", () => setKey($<HTMLInputElement>("#esriKey").value.trim()));
  $("#esriDel")?.addEventListener("click", () => setKey(""));
}

async function scheduleReminders() {
  if (!S.plan.startDate) return toast("Bitte zuerst ein Startdatum setzen");
  try {
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== "granted") return toast("Benachrichtigungen nicht erlaubt");
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    const n: any[] = [];
    const days = Math.max(S.plan.settings.days, S.days.length);
    for (let d = 1; d <= days; d++) {
      const date = dateOfDay(d)!;
      const morning = new Date(date); morning.setHours(8, 30, 0, 0);
      const camp = new Date(date); camp.setHours(15, 30, 0, 0);
      if (morning > new Date()) n.push({ id: 1000 + d, title: `Tag ${d}: guten Morgen!`, body: "Wind und Etappe in der App checken.", schedule: { at: morning, allowWhileIdle: true } });
      if (camp > new Date()) n.push({ id: 2000 + d, title: "15:30 – Camp-Zeit", body: "Camp aufbauen, Wasser auffüllen, Zeckencheck.", schedule: { at: camp, allowWhileIdle: true } });
    }
    await LocalNotifications.schedule({ notifications: n });
    toast(`${n.length} Erinnerungen eingeplant`);
  } catch (e) {
    toast(`Erinnerungen gehen nur in der Android-App (${(e as Error).message})`, 4000);
  }
}

// ---------- GPS ----------
async function startGps() {
  try {
    if (Capacitor.isNativePlatform()) {
      const perm = await Geolocation.requestPermissions();
      if (perm.location === "denied") return;
    }
    await Geolocation.watchPosition({ enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 }, (pos) => {
      if (!pos) return;
      const prev = S.pos;
      S.pos = [pos.coords.longitude, pos.coords.latitude];
      S.posAccuracy = pos.coords.accuracy;
      mv?.setPosition(S.pos);
      // Panel nur bei spürbarer Bewegung neu zeichnen (Akku)
      if (!prev || haversineKm(prev, S.pos) > 0.2) {
        if (S.tab === "unterwegs" || S.tab === "notfall") render();
      }
    });
  } catch {
    /* GPS nicht verfügbar */
  }
}

// ---------- Start ----------
async function init() {
  S.plan = await loadPlan();
  S.checks = await loadChecks();
  S.custom = await loadCustomItems();
  S.people = await loadPeople();
  S.mapSource = await load("mapSource", "auto");
  S.esriKey = await load("esriKey", "");
  S.eigRadius = await load("eignungRadius", 500);
  const wantSat = await load("sat", false);
  const vis = await load<Cat[] | null>("visibleCats", null);
  if (vis) S.visible = new Set(vis);
  const nc = await load<Cat[] | null>("nextCats", null);
  if (nc) S.nextCats = new Set(nc);
  const w = await load<any>("weather", null);
  if (w) S.weather = { ...w, hours: w.hours.map((h: any) => ({ ...h, time: new Date(h.time) })) };

  mv = createMap($("#map"), BLANK_STYLE);
  mv.onPoiClick(showPoi);
  mv.map.on("click", (e) => {
    if (!S.addMode || S.tab !== "planen") return;
    S.plan.waypoints.push([e.lngLat.lng, e.lngLat.lat]);
    savePlan(S.plan);
    updateMap();
    render();
  });
  mv.map.on("style.load", updateMap);
  mv.onPick((p) => checkPoint(p));
  $("#btnPick").addEventListener("click", () => setPickMode(!S.pickMode));
  $("#btnSat").addEventListener("click", () => setSat(!S.sat));
  await initSplitter();

  document.querySelectorAll<HTMLElement>("nav#tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab as Tab)));
  setTab(S.plan.line.length > 1 ? "unterwegs" : "planen");

  S.online = await isOnline();
  await chooseMapStyle();
  if (wantSat) await setSat(true);
  window.addEventListener("online", async () => { S.online = await isOnline(); chooseMapStyle(); refreshWeather(); render(); });
  window.addEventListener("offline", () => { S.online = false; chooseMapStyle(); render(); });

  try {
    S.busy = "Lade Ortsdaten …";
    S.index = await loadPois();
    try { await loadCamp(S.index); } catch (e) { console.log(`[pois] Zeltplatz-Fehler: ${(e as Error).message}`); }
    S.busy = "";
  } catch (e) {
    S.busy = `Ortsdaten fehlen: ${(e as Error).message}`;
    console.log(`[pois] Fehler: ${(e as Error).message}`);
  }
  recompute();
  console.log(`[app] ${S.index?.all.length ?? 0} Orte, ${S.stages.length} Etappen`);
  if (S.plan.line.length > 1) mv.fit(bboxOf(S.plan.line));
  render();
  startGps();
  refreshWeather();
  setInterval(refreshWeather, 30 * 60 * 1000);
}

init();
