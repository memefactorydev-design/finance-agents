// The project money model the finance system runs on. A Project is a won
// job / order for one customer: contract value, payment schedule, receipts,
// invoices, supplier purchase orders and milestone dates. Projects come from
// your CRM through a connector (REST pull, webhook push, MCP) or are kept
// here by hand; receipts and invoices recorded in this app live in a finance
// overlay so a CRM re-sync never loses them.
export const SCHEDULE_KEYS = ["deposit", "survey_payment", "delivery_balance", "install_deposit", "install_day1", "install_stage1", "retention"] as const;
export type ScheduleKey = (typeof SCHEDULE_KEYS)[number];
export type ScheduleGroup = "order" | "installation";

export interface ScheduleLine { pct: number | null; amount: number | null; overridden: boolean; dueDate?: string | null; invoiceId?: string | null; note?: string }
export interface InstallationContract { value: number | null; vatRate?: number | null; retentionApplies: boolean }
export interface OrderFinance { vatRate: number; schedule: Partial<Record<ScheduleKey, ScheduleLine>>; installation: InstallationContract | null; updatedAt: string; updatedBy?: string }

export const PAYMENT_METHODS = ["Bank Transfer", "Card", "Cash", "Finance", "Other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_CONFIRMATION_SOURCES = ["bank_statement", "owner", "finance_provider", "card_terminal", "agent"] as const;
export type PaymentConfirmationSource = (typeof PAYMENT_CONFIRMATION_SOURCES)[number];
export const PAYMENT_CONFIRMATION_LABEL: Record<PaymentConfirmationSource, string> = {
  bank_statement: "Seen on the bank statement",
  owner: "Confirmed by the owner",
  finance_provider: "Finance provider payout confirmed",
  card_terminal: "Card terminal receipt",
  agent: "Recorded by a finance agent on instruction",
};
export interface PaymentConfirmation { source: PaymentConfirmationSource; by: string; at: string; ref?: string | null }
export interface Payment { id: string; amount: number; date: string; method: PaymentMethod; note?: string; scheduleKey?: ScheduleKey | null; confirmation?: PaymentConfirmation | null }

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";
export interface InvoiceItem { description: string; qty: number; unitPrice: number }
export interface Invoice { id: string; number: string; date: string; dueDate?: string; items: InvoiceItem[]; vatRate: number; status: InvoiceStatus; sentAt?: string | null; note?: string; scheduleKey?: ScheduleKey | null; raisedBy?: string | null; emailedTo?: string | null; paymentLink?: string | null; paidAt?: string | null }

export const EXTRA_COST_CATEGORIES = ["Labour", "Materials", "Remedial", "Delivery", "Other"] as const;
export type ExtraCostCategory = (typeof EXTRA_COST_CATEGORIES)[number];
export interface ExtraCost { id: string; amount: number; date: string; category: ExtraCostCategory; description: string; addedBy: string; addedAt: string }

// ---------------------------------------------------------- supplier orders
export type OrderStatus = "draft" | "pending_signoff" | "signed_off" | "sent" | "acknowledged" | "discrepancy" | "confirmed" | "cancelled";
export type OrderType = "contract" | "addon" | "remedial";
export interface OrderLine { code: string; description: string; qty: number; unitCost: number; unitSell?: number; catalog?: string; position?: number; subPosition?: number }
export interface AckLine { code: string; description?: string; qty: number; unitCost: number; position?: string; lineTotal?: number }
export interface AckExtra { label: string; amount: number }
export type AckDiscrepancyField = "qty" | "unitCost" | "missing_from_ack" | "extra_in_ack" | "extra_charge" | "total";
export const ACK_DISCREPANCY_LABEL: Record<AckDiscrepancyField, string> = { qty: "Quantity", unitCost: "Unit price", missing_from_ack: "Not acknowledged", extra_in_ack: "Extra line", extra_charge: "Extra charge", total: "Total differs" };
export interface AckDiscrepancy { lineCode: string; field: AckDiscrepancyField; ordered: string; acknowledged: string; position?: string; delta?: number }
export interface OrderAck { filename?: string; receivedAt: string; lines: AckLine[]; discrepancies: AckDiscrepancy[]; status: "match" | "discrepancy"; extractedBy?: "ai" | "manual" | "webhook"; supplierRef?: string | null; expectedDate?: string | null; extras?: AckExtra[]; subtotal?: number | null; vat?: number | null; total?: number | null; currency?: string | null; source?: "pdf" | "body" | "manual" | "webhook"; mailbox?: string; messageId?: string; appliedBy?: string; how?: string }
export interface SupplierOrder {
  id: string;
  reference: string;             // the PO number suppliers quote
  supplierName: string;
  supplierId?: string | null;    // supplier profile vendorId when known
  status: OrderStatus;
  orderType: OrderType;
  lines: OrderLine[];
  orderedNet?: number | null;    // overrides Σ qty × unitCost when the CRM gives a total
  ack?: OrderAck | null;
  sentAt?: string | null;
  createdAt: string;
  updatedAt?: string;
  notes?: string | null;
}
export const orderedCost = (o: SupplierOrder) => (o.orderedNet != null ? o.orderedNet : o.lines.reduce((s, l) => s + l.qty * l.unitCost, 0));
export const acknowledgedCost = (o: SupplierOrder) => (o.ack ? o.ack.lines.reduce((s, l) => s + l.qty * l.unitCost, 0) + (o.ack.extras || []).reduce((s, x) => s + x.amount, 0) : null);

// ------------------------------------------------------------------ project
export type ProjectStatus = "active" | "completed" | "cancelled" | "lost";
export interface CostStageSummary { revenue: number; totalCost: number; profit: number; marginPct: number; capturedAt: string; note?: string | null; byCatalogue?: { catalogue: string; lines: number; cost: number; sell: number }[] }
export interface Project {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  postcode?: string | null;
  address?: string | null;
  designer?: string | null;        // salesperson / account owner (commission)
  status: ProjectStatus;
  opsStage?: string | null;        // free text from the CRM ("Survey", "Delivery"…)
  wonDate: string | null;
  wonValue: number | null;         // NET order value ex VAT, excluding installation
  orderFinance?: OrderFinance | null;
  payments?: Payment[] | null;
  invoices?: Invoice[] | null;
  extraCosts?: ExtraCost[] | null;
  supplierOrders?: SupplierOrder[] | null;
  costing?: { sales?: CostStageSummary | null; order?: CostStageSummary | null } | null;
  // milestones (ISO dates, "N/A" or null)
  surveyOrderAt?: string | null;
  deliveryDate?: string | null;
  installStart?: string | null;
  installEnd?: string | null;
  signOff1At?: string | null;
  signOff2At?: string | null;
  stage1Date?: string | null;
  stage2Date?: string | null;
  supplyOnly?: boolean | null;
  completedAt?: string | null;
  closedAt?: string | null;
  qbo?: { customerId?: string | null; classId?: string | null; className?: string | null } | null;
  notes?: string | null;
  source: { kind: "manual" | "rest" | "webhook" | "mcp"; externalId?: string | null; syncedAt?: string | null };
  createdAt: string;
  updatedAt: string;
}
export const projectName = (p: Pick<Project, "firstName" | "lastName">) => `${p.firstName || ""} ${p.lastName || ""}`.trim();

// What the finance overlay keeps when the CRM owns the project record.
export interface ProjectFinanceOverlay { payments?: Payment[]; invoices?: Invoice[]; extraCosts?: ExtraCost[]; orderFinance?: OrderFinance | null; qbo?: Project["qbo"]; supplierOrderAcks?: Record<string, OrderAck>; updatedAt: string }
