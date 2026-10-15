// JSON shapes the finance UI reads from /api/finance/**. These mirror the
// original system's route payloads with one rename (leadId → projectId,
// leadName → projectName). Domain types (Project, Invoice, Payment…) come
// from lib/crm/types; everything else is declared here so the client never
// imports server-only modules.
import type { Invoice, PaymentConfirmation, Payment, Project, ScheduleKey, AckLine, AckExtra, AckDiscrepancy } from "@/lib/crm/types";
import type { ResolvedLine, ScheduleTotals, FinanceDefaults } from "@/lib/crm/schedule";
import type { QuickBooksStatus } from "@/lib/qbo/status";
import type { SetupState } from "@/lib/core/setup";
import type { SyncResult } from "@/lib/crm/connectors";
import type { SupplierProfile, Dispute, Commitment } from "@/lib/finance/suppliers";
import type { Brief, Task } from "@/lib/finance/briefs";

export type { Invoice, Payment, Project, ScheduleKey, ResolvedLine, ScheduleTotals, FinanceDefaults, QuickBooksStatus, SetupState, SyncResult, SupplierProfile, Dispute, Commitment, Brief, Task };

// ------------------------------------------------------- finance overview
export interface DueLine {
  projectId: string; client: string; designer: string | null; opsStage: string | null;
  key: ScheduleKey; label: string; group: ResolvedLine["group"];
  amountGross: number; outstandingGross: number; dueDate: string | null; status: ResolvedLine["status"];
  invoiceNumber: string | null; invoiceStatus: Invoice["status"] | null;
}
export interface CollectionRow {
  projectId: string; client: string; designer: string | null; opsStage: string | null; wonDate: string | null;
  net: number; gross: number; taken: number; outstanding: number; overdue: number;
  nextDue: DueLine | null; invoices: { total: number; paid: number; sent: number; draft: number }; lines: ResolvedLine[];
}
export interface InvoiceRow { projectId: string; client: string; designer: string | null; invoice: Invoice; gross: number; lineLabel: string | null; overdue: boolean; confirmation: PaymentConfirmation | null }
export type PnlStage = "sales" | "order" | "supplier" | "completion";
export interface Pnl { stage: PnlStage; available: boolean; frozen: boolean; capturedAt?: string; source?: string; salePrice: number; addonSell: number; revenue: number; breakdown: { contract: number; addon: number; remedial: number; extra: number }; cost: number; profit: number; marginPct: number; warnings: string[]; snapshotId?: string }
export interface SupplierDrift { ordered: number; acknowledged: number; delta: number; extras: number; acknowledgedOrders: number; totalOrders: number }
export interface PnlComparison {
  sales: Pnl; order: Pnl; supplier: Pnl; completion: Pnl; supplierDrift: SupplierDrift | null;
  deltas: { salesToOrder: PnlDelta | null; orderToSupplier: PnlDelta | null; orderToCompletion: PnlDelta | null };
  extraSpend: { remedial: number; extra: number; addonCost: number; addonSell: number; total: number };
  postCompletion: { orders: number; cost: number; extras: number; extraCost: number } | null;
}
export interface PnlDelta { profit: number; marginPts: number; cost: number }
export interface PnlRow { projectId: string; client: string; designer: string | null; opsStage: string | null; net: number; comparison: PnlComparison }
export interface FinanceOverview {
  generatedAt: string; defaults: FinanceDefaults; projects: number; source: string;
  pnlCoverage: { eligible: number; loaded: number; truncated: boolean; snapshotsAvailable: boolean };
  kpis: {
    contractNet: number; contractGross: number; taken: number; outstanding: number; overdue: number; dueNext14: number; dueNext30: number; uninvoicedDue: number;
    invoices: Record<"draft" | "sent" | "paid", { count: number; value: number }>;
    pnl: { salesProfit: number; salesMargin: number | null; salesCount: number; orderProfit: number; orderMargin: number | null; orderCount: number; supplierProfit: number; supplierMargin: number | null; supplierCount: number; completionProfit: number; completionMargin: number | null; completionCount: number };
  };
  collections: CollectionRow[]; dueLines: DueLine[]; invoices: InvoiceRow[]; pnl: PnlRow[];
}

// ------------------------------------------------------- projects
export interface ProjectSchedule { lines: ResolvedLine[]; totals: ScheduleTotals; contractGross: number; contractNet: number }
export interface ProjectResponse { project: Project; schedule: ProjectSchedule }
// What every write to /api/finance/projects/[id]/finance returns.
export interface FinanceMutationResult { project: Project; schedule: ProjectSchedule; invoice?: Invoice; payment?: Payment | null; removedPayments?: Payment[] }
export interface ProjectNote { id: string; projectId: string; text: string; by: string; at: string }

// ------------------------------------------------------- status / jobs
export interface StatusResponse { setup: SetupState; quickbooks: QuickBooksStatus; crm: SyncResult | null }
export interface CronResponse { ok: boolean; job: string; results: Record<string, unknown>; ms: number }

// ------------------------------------------------------- cashflow
export interface BankAccount { id: string; name: string; type: "Bank" | "Credit Card"; subType: string | null; currency: string; balance: number; hidden?: boolean }
export type Bucket = "overdue" | "next7" | "next14" | "next30" | "later" | "undated";
export type InboundStage = "deposit" | "survey" | "delivery_balance" | "installation" | "retention";
export interface InboundLine { projectId: string; client: string; designer: string | null; stage: InboundStage; label: string; amount: number; dueDate: string | null; status: string; invoiceNumber: string | null; bucket: Bucket }
export interface Week { start: string; end: string; inbound: number; outbound: number; commitments: number; net: number; closing: number; inboundLines: number; outboundItems: number }
export interface SupplierOutlook { vendor: string; vendorId: string | null; open: number; overdue: number; disputed: number; maxDaysOverdue: number; nextDue: string | null; payFriday: string | null; blockAfterDaysOverdue: number | null; blockRisk: boolean; onHold: boolean; proformaOnly: boolean; pressure: SupplierProfile["pressure"] | null; paymentMethods: SupplierProfile["paymentMethods"] | null }
export interface CommitmentOutlook { id: string; kind: Commitment["kind"]; name: string; amount: number; frequency: Commitment["frequency"]; nextDue: string | null; balance: number | null }
export interface CashflowOutlook {
  asOf: string; fetchedAt: string;
  bank: { accounts: BankAccount[]; cash: number; creditCards: number; net: number; source: string };
  inbound: { total: number; byStage: Record<InboundStage, number>; buckets: Record<Bucket, number>; lines: InboundLine[]; source: string };
  outbound: { total: number; overdue: number; buckets: Record<Bucket, number>; underReview: number; unapplied: number; suppliers: SupplierOutlook[]; source: string };
  commitments: { total90: number; items: CommitmentOutlook[]; source: string };
  position: { available: number; in30: number; out30: number; projected30: number; low: { week: string; closing: number } | null };
  weeks: Week[]; notes: string[];
}

// ------------------------------------------------------- supplier balances
export interface VendorBalanceItem { id: string | null; date: string | null; type: string; num: string | null; dueDate: string | null; amount: number; openBalance: number; daysOverdue: number | null; disputed: boolean }
export interface VendorBalance { vendor: string; vendorId: string | null; open: number; bills: number; unapplied: number; disputed: number; overdue: number; nextDue: string | null; items: VendorBalanceItem[] }
export interface VendorBalanceReport {
  source: string; realm: string; asOf: string; reportDate: string | null; currency: string; columns: string[];
  totalOpen: number; totalBills: number; totalUnapplied: number; totalDisputed: number; disputedCount: number; disputeCutoff: string | null; totalOverdue: number;
  buckets: { overdue: number; next7: number; next14: number; next30: number; later: number; undated: number };
  vendors: VendorBalance[]; fetchedAt: string;
}

// ------------------------------------------------------- supplier invoices (intake)
export type IntakeState = "proposed" | "posted" | "held" | "rejected" | "duplicate" | "not_invoice";
export interface IntakeArrival { mailbox: string; messageId: string; attachmentId: string; fileName: string; receivedAt: string; from: string | null; subject: string | null; conversationId: string | null }
export interface ExtractedInvoice { documentType: string; documentCount: number; supplierIdentity: string; documentNumber: string; currency: string; invoiceDateText: string; confirmedIsoDate: string | null; projectReference: string | null; poReference: string | null; net: string; vat: string; gross: string; lines: { id: string; description: string; sku: string | null; itemFamily: string; useContext: string; net: string; vat: string; gross: string }[] }
export interface IntakeResolvedLine { description: string; amount: number; vat: number; accountId: string | null; accountName: string | null; classId: string | null; className: string | null; taxCodeId: string | null; vatKind: string | null; accountSource: string }
export interface ClassCandidate { classId: string; className: string; source: string; projectId?: string | null; poReference?: string | null; token?: string | null }
export interface IntakeResolution {
  vendorId: string | null; vendorName: string | null; vendorScore: number; vendorSource: string; vendorProposed?: { displayName: string; email: string | null };
  docNumber: string; txnDate: string | null; dateNote: string | null; lines: IntakeResolvedLine[];
  classId: string | null; className: string | null; classScore: number; classCandidates: ClassCandidate[]; projectId: string | null;
  matchedPo: { reference: string; projectId: string; projectName: string; orderType: string } | null;
  dueDate: string | null; termName: string | null; totals: { net: number; vat: number; gross: number; linesNet: number }; currency: string;
}
export interface OwnerApproval { status: "requested" | "approved" | "rejected"; ref: string; requestedAt: string; decision: "approve" | "reject" | null; decidedBy: string | null; decidedAt: string | null }
export interface IntakeRecord {
  sha256: string; state: IntakeState; arrivals: IntakeArrival[];
  evidence: { id: string; sha256: string; contentType: string; size: number };
  extraction: ExtractedInvoice | null; extractionError: string | null; extractionSource?: "text" | "vision" | null;
  resolution: IntakeResolution | null; reasons: string[]; confidence: number;
  qbo: { billId: string | null; attachableId: string | null; postedAt: string | null; dryRun: unknown | null; lastEditedAt?: string | null; lastEditDryRun?: unknown | null };
  decidedBy: string | null; decidedAt: string | null; ownerApproval?: OwnerApproval | null; createdAt: string; updatedAt: string;
}
export interface MailboxHealth { mailbox: string; enabled: boolean; ok: boolean | null; error: string | null; checkedAt: string | null; watermark: string | null; mailboxes?: MailboxHealth[] }
export interface IntakeListResponse { posting: boolean; intakeEnabled: boolean; state: string; counts: Record<string, number>; mailboxes: MailboxHealth[]; items: IntakeRecord[] }
export interface IntakeOptions { vendors: { id: string; name: string }[]; accounts: { id: string; name: string }[]; classes: { id: string; name: string }[]; taxCodes: { id: string; name: string }[] }
export interface IntakeRunSummary { skipped?: string; startedAt: string; ms: number; dryRun: boolean; posting: boolean; scanned: number; pdfs: number; graphCalls: number; created: number; arrivals: number; proposed: number; posted: number; held: number; duplicate: number; notInvoice: number; redirectDrafts: number; errors: string[] }
export interface ResolveOverrides { vendorId?: string | null; docNumber?: string | null; txnDate?: string | null; dueDate?: string | null; classId?: string | null; allowNoClass?: boolean; lines?: { accountId?: string | null; classId?: string | null; taxCodeId?: string | null; amount?: number | null; description?: string | null }[] }
export interface PostedEdit { lines?: { index: number; accountId?: string | null; classId?: string | null; taxCodeId?: string | null }[]; dueDate?: string | null; docNumber?: string | null; privateNote?: string | null }
export type AutopilotMode = "manual" | "assisted" | "full";
export interface AutopilotConfig { mode: AutopilotMode; minConfidence: number; requireClass: boolean; requireKnownVendor: boolean; updatedBy: string | null; updatedAt: string | null }
export interface AutopilotResponse { posting: boolean; autopilot: AutopilotConfig; suppliersOnAutoPost: number; suppliers: number }
export type DecisionAction = "post" | "hold" | "reject" | "reprocess" | "edit_posted" | "promote" | "demote";
export interface CodingShape { vendorId: string | null; classId: string | null; className: string | null; accounts: string[]; vatKinds: string[] }
export interface CodingDecision { sha256: string; vendorId: string | null; vendorName: string | null; docNumber: string | null; action: DecisionAction; by: string; at: string; autopilot: boolean; dryRun: boolean; confidence: number; proposed: CodingShape; final: CodingShape; changed: { vendor: boolean; class: boolean; account: boolean; vat: boolean }; evidence: { invoiceTextTokens: string[]; senderDomain: string | null; fileName: string | null }; note: string | null }
export interface AgreementStats { decisions: number; proposals: number; posted: number; autoPosted: number; held: number; rejected: number; edited: number; classAgreement: number | null; accountAgreement: number | null; vatAgreement: number | null; avgConfidence: number | null }
export interface VendorStats extends AgreementStats { vendorId: string; vendorName: string | null; autoPost: boolean; lastDecisionAt: string | null }
export interface DecisionStats { since: string | null; overall: AgreementStats; vendors: VendorStats[]; last: CodingDecision[]; autopilot: AutopilotConfig; suppliersOnAutoPost: number; suppliers: number }
export interface DecisionsResponse { decisions: CodingDecision[]; stats: DecisionStats }

// ------------------------------------------------------- order acknowledgements
export type OrderAckState = "matched" | "unmatched" | "not_ack" | "duplicate" | "rejected";
export interface OrderAckArrival { mailbox: string; messageId: string; attachmentId: string | null; fileName: string; receivedAt: string; from: string | null; subject: string | null }
export interface OrderAckExtraction { lines: AckLine[]; acknowledgementRef: string | null; expectedDate: string | null; textChars: number; extractedAt: string | null; extras?: AckExtra[]; subtotal?: number | null; vat?: number | null; total?: number | null; currency?: string | null }
export interface OrderAckRecord {
  sha256: string; state: OrderAckState; kind?: "pdf" | "body"; arrivals: OrderAckArrival[];
  evidence: { id: string; sha256: string; contentType: string; size: number };
  supplier: { id: string | null; name: string | null; score: number; source: string };
  order: { id: string | null; reference: string | null; projectId: string | null; projectName: string | null; score: number; source: string };
  extraction: OrderAckExtraction | null;
  ack: { status: "match" | "discrepancy"; discrepancies: AckDiscrepancy[]; appliedAt: string; supplierCost?: number; orderedCost?: number } | null;
  reasons: string[]; decidedBy: string | null; decidedAt: string | null; createdAt: string; updatedAt: string;
}
export interface OrdersIntakeListResponse { mailbox: MailboxHealth; state: string; counts: Record<string, number>; items: OrderAckRecord[] }
export interface OpenOrder { id: string; reference: string; projectId: string; projectName: string; supplierId: string | null; supplierName: string; status: string; sentAt: string | null; createdAt: string }
export interface OrdersIntakeRunSummary { skipped?: string; startedAt: string; ms: number; scanned: number; pdfs: number; bodies?: number; graphCalls: number; created: number; matched: number; unmatched: number; notAck: number; duplicate: number; errors: string[] }

// ------------------------------------------------------- suppliers / disputes
export type SupplierRow = SupplierProfile & { activeDisputes?: number };
export interface SuppliersResponse { profiles: SupplierRow[]; total: number; pending: number }
export interface DisputesResponse { status: string; total: number; totalAmount: number; disputes: Dispute[]; postingEnabled: boolean }
export interface CommitmentsResponse { commitments: Commitment[] }

// ------------------------------------------------------- briefs / tasks
export interface BriefsResponse { briefs: Brief[]; channels: string[] }
export interface TasksResponse { tasks: Task[] }
