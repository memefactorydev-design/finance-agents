// Helpers shared by the orders-intake routes (not a route itself).
import { FinanceError } from "@/lib/core/domain";
import type { OrderAckState } from "@/lib/finance/orders/orders-intake";

export const SHA = /^[a-f0-9]{64}$/;
export const STATES: (OrderAckState | "all" | "open")[] = ["open", "unmatched", "matched", "not_ack", "duplicate", "rejected", "all"];
export function requireSha(sha: string): string {
  if (!SHA.test(sha)) throw new FinanceError("BAD_SHA", false, 400);
  return sha;
}
export function evidenceResponse(file: { bytes: Uint8Array; fileName: string; contentType: string }): Response {
  const isText = file.contentType === "text/plain";
  const safeName = file.fileName.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || (isText ? "acknowledgement.txt" : "acknowledgement.pdf");
  return new Response(Buffer.from(file.bytes), { headers: { "Content-Type": isText ? "text/plain; charset=utf-8" : "application/pdf", "Content-Disposition": `inline; filename="${safeName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
