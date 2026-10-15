import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export const money = (v: number, currency = "GBP", fraction = 0) => new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(v || 0);
export const money2 = (v: number, currency = "GBP") => money(v, currency, 2);
export const formatDate = (d: string | Date | null | undefined) => (d ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(d)) : "—");
export const formatDateTime = (d: string | Date | null | undefined) => (d ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(d)) : "—");
