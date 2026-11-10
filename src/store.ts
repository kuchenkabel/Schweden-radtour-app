import { Preferences } from "@capacitor/preferences";

/** Kleiner Key-Value-Speicher (Android: SharedPreferences, Browser: localStorage). */
export async function load<T>(key: string, fallback: T): Promise<T> {
  try {
    const { value } = await Preferences.get({ key });
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

let onChange: ((key: string) => void) | null = null;
/** Wird nach jedem save() aufgerufen (für den Sync). */
export function setChangeListener(fn: ((key: string) => void) | null) {
  onChange = fn;
}

export async function save(key: string, value: unknown): Promise<void> {
  await saveQuiet(key, value);
  onChange?.(key);
}

/** Speichern, ohne den Sync auszulösen (z. B. beim Übernehmen vom anderen Gerät). */
export async function saveQuiet(key: string, value: unknown): Promise<void> {
  await Preferences.set({ key, value: JSON.stringify(value) });
}
