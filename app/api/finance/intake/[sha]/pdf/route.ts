// GET /api/finance/intake/[sha]/pdf → the invoice PDF (inline) from the evidence store.
import { requirePrincipal } from "@/lib/core/auth";
import { FinanceError } from "@/lib/core/domain";
import { financeError } from "@/lib/core/server";
import { readIntakePdf } from "@/lib/finance/intake/intake";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHA = /^[a-f0-9]{64}$/;

export async function GET(request: Request, { params }: { params: { sha: string } }) {
  try {
    await requirePrincipal(request);
    if (!SHA.test(params.sha)) throw new FinanceError("BAD_SHA", false, 400);
    const pdf = await readIntakePdf(params.sha);
    if (!pdf) throw new FinanceError("INTAKE_NOT_FOUND", false, 404);
    const safeName = pdf.fileName.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "invoice.pdf";
    return new Response(pdf.bytes as BodyInit, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${safeName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (e) { return financeError(e); }
}
