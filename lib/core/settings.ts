// Small typed settings rows (SETTINGS#<key>) on top of the store.
import { upsert } from "./store";
import { company, financeStore } from "./server";

export async function getSettings<T>(key: string): Promise<T | null> {
  const row = await financeStore().get<T & { updatedAt?: string; updatedBy?: string }>(company(), `SETTINGS#${key}`);
  return (row?.data as T) ?? null;
}
export async function updateSettings<T extends object>(key: string, data: T, by?: string): Promise<T> {
  return upsert<T>(financeStore(), company(), `SETTINGS#${key}`, (cur) => ({ ...(cur || {}), ...data, updatedAt: new Date().toISOString(), ...(by ? { updatedBy: by } : {}) }) as T);
}
