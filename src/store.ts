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

export async function save(key: string, value: unknown): Promise<void> {
  await Preferences.set({ key, value: JSON.stringify(value) });
}
