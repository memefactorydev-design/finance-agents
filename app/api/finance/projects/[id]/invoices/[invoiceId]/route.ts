import { NextResponse } from "next/server";
import { requirePrincipal } from "@/lib/core/auth";
import { getConnections } from "@/lib/core/config";
import { financeError } from "@/lib/core/server";
import { requireProject } from "@/lib/crm/projects";
import { invoiceTotal } from "@/lib/crm/schedule";
import { invoiceHtml } from "@/lib/finance/invoices";
export const dynamic = "force-dynamic";

// GET /api/finance/projects/[id]/invoices/[invoiceId]?format=html — a print
// view of one invoice (save as PDF from the browser); JSON otherwise. No PDF
// is generated server-side and nothing is sent to the client.
export async function GET(request: Request, { params }: { params: { id: string; invoiceId: string } }) {
  try {
    await requirePrincipal(request);
    const project = await requireProject(params.id);
    const invoice = (project.invoices || []).find((i) => i.id === params.invoiceId);
    if (!invoice) return NextResponse.json({ error: { code: "INVOICE_NOT_FOUND", message: "Invoice not found on project" } }, { status: 404 });
    if (new URL(request.url).searchParams.get("format") === "html") {
      return new Response(invoiceHtml(project, invoice, await getConnections()), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json({ invoice: { ...invoice, total: invoiceTotal(invoice) } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) { return financeError(e); }
}
