import { Capacitor, CapacitorHttp } from "@capacitor/core";

/** JSON abrufen; in der App über natives HTTP (keine CORS-Probleme), im Browser per fetch. */
export async function getJson(url: string): Promise<any> {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({ url, responseType: "json", connectTimeout: 15000, readTimeout: 60000 });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${String(typeof res.data === "string" ? res.data : JSON.stringify(res.data)).slice(0, 200)}`);
    return typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
