import { vi } from 'vitest';

import * as atcudIssuance from '../actions/atcud-issuance';
import { ActionRegistry } from '../actions/action-registry';
import { registerInvoiceActions } from '../actions/invoice-actions';
import * as b2gRouting from '../b2g-routing/b2g-routing';
import * as countryPolicy from '../country-policy/country-policy';
import * as applyStockOnIssuance from '../stock/apply-stock-on-issuance';
import * as taxLoadAndResolve from '../tax/load-and-resolve';
import * as mandate from '../transports/channel-policy/mandate';
import * as companyTransport from '../transports/company-transport';
import { TransportRegistry } from '../transports/transport-registry';
import * as vatCurrencyIssuance from '../vat-currency/vat-currency-issuance';

/**
 * What a spec driving the invoice's "validate"/"send" handlers over real Postgres needs around them.
 * The spec itself must `vi.mock` '../tax/load-and-resolve', '../numbering/take-number',
 * '../b2g-routing/b2g-routing', '../transports/channel-policy/mandate',
 * '../country-policy/country-policy', '../transports/company-transport' and '../persistence':
 * mocks are hoisted per file.
 */
export function issuanceDocumentData(clientId: string) {
  return {
    client: clientId,
    issueDate: '2026-09-15',
    dueDate: '2026-09-30',
    currency: 'EUR',
    lines: [{ description: 'Consulting', quantity: 1, unit: 'unit', unitPrice: 100, vatRate: '20' }],
  };
}

export function issuanceDocument(clientId: string, typeId: 'invoice' | 'quote', status: string) {
  return {
    id: 'doc-1',
    typeId,
    status,
    data: issuanceDocumentData(clientId),
    createdAt: new Date(),
    updatedAt: new Date(),
    number: status === 'draft' ? undefined : 1,
    displayNumber: status === 'draft' ? undefined : 'INV-2026-0001',
  };
}

export function draftInvoiceContext(companyId: string, clientId: string) {
  return {
    companyId,
    typeId: 'invoice',
    documentId: 'doc-1',
    data: issuanceDocumentData(clientId),
    params: {},
    currentStatus: 'draft',
  };
}

export function invoiceActionRegistry() {
  const transportRegistry = new TransportRegistry();
  transportRegistry.register('email', 'Email', { send: vi.fn().mockResolvedValue({ message: 'queued' }) });
  const registry = new ActionRegistry();
  registerInvoiceActions(registry, { transportRegistry, queueDispatcher: { enqueueAction: vi.fn() } });
  return registry;
}

/** Stubs everything issuance touches besides the gates under test: no mandate, email transport,
 *  domestic tax, no B2G routing, and no post-numbering bookkeeping. */
export function stubIssuanceCollaborators() {
  vi.mocked(countryPolicy.resolveCompanyCountryCode).mockResolvedValue('DE');
  vi.mocked(mandate.activeChannelMandateForOperation).mockReturnValue(undefined);
  vi.mocked(companyTransport.getCompanyInvoiceTransportId).mockResolvedValue('email');
  vi.mocked(taxLoadAndResolve.resolveInvoiceCrossBorderTaxForCompany).mockImplementation(
    async (_companyId, data) => ({ data, crossBorder: false, warnings: [] }) as never,
  );
  vi.mocked(b2gRouting.resolveClientB2gRouting).mockResolvedValue({ applies: false } as never);
  vi.spyOn(atcudIssuance, 'attachAtcudToNumberedDocument').mockResolvedValue(undefined as never);
  vi.spyOn(vatCurrencyIssuance, 'attachVatNationalCurrencyToNumberedDocument').mockResolvedValue(
    undefined as never,
  );
  vi.spyOn(applyStockOnIssuance, 'applyStockOnIssuance').mockResolvedValue(undefined as never);
}

export interface Refusal {
  message: string;
  response: { code?: string; [key: string]: unknown };
}

export async function rejection(promise: Promise<unknown>): Promise<Refusal> {
  try {
    await promise;
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('expected the action to be refused');
}
