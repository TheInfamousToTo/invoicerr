import { vi, type Mock } from 'vitest';

import prisma from '@/prisma/prisma.service';

import { createTestCompany } from '../__tests__/issuable-client';
import * as b2gRouting from '../b2g-routing/b2g-routing';
import { seedCountryIdentifierRequirements } from '../country-identifiers/seed';
import * as countryPolicy from '../country-policy/country-policy';
import * as takeNumber from '../numbering/take-number';
import * as persistence from '../persistence';
import * as taxLoadAndResolve from '../tax/load-and-resolve';
import * as mandate from '../transports/channel-policy/mandate';
import * as companyTransport from '../transports/company-transport';
import { TransportRegistry } from '../transports/transport-registry';
import * as atcudIssuance from './atcud-issuance';
import { ActionRegistry } from './action-registry';
import { INVOICE_IDENTIFIERS_MISSING_CODE } from './invoice-identifier-readiness';
import { registerInvoiceActions } from './invoice-actions';
import * as vatCurrencyIssuance from '../vat-currency/vat-currency-issuance';
import * as applyStockOnIssuance from '../stock/apply-stock-on-issuance';

vi.mock('../tax/load-and-resolve');
vi.mock('../numbering/take-number');
vi.mock('../b2g-routing/b2g-routing');
vi.mock('../transports/channel-policy/mandate');
vi.mock('../country-policy/country-policy');
vi.mock('../transports/company-transport');
vi.mock('../persistence');

type Identifiers = Record<string, string>;

interface CountryFixture {
  country: string;
  countryCode: string;
  city: string;
}

const FRANCE: CountryFixture = { country: 'France', countryCode: 'FR', city: 'Paris' };
const GERMANY: CountryFixture = { country: 'Germany', countryCode: 'DE', city: 'Berlin' };
const POLAND: CountryFixture = { country: 'Poland', countryCode: 'PL', city: 'Warszawa' };

const createdCompanyIds: string[] = [];

function identifierRows(identifiers: Identifiers) {
  return Object.entries(identifiers).map(([scheme, value]) => ({ scheme, value }));
}

async function seller(where: CountryFixture, identifiers: Identifiers, exemptVat = false) {
  const company = await createTestCompany(
    `Seller ${where.countryCode} ${Object.keys(identifiers).join(' ')}`,
  );
  createdCompanyIds.push(company.id);
  return prisma.company.update({
    where: { id: company.id },
    data: {
      ...where,
      exemptVat,
      partyIdentifiers: { create: identifierRows(identifiers) },
    },
  });
}

async function buyer(
  companyId: string,
  where: CountryFixture,
  type: 'COMPANY' | 'INDIVIDUAL',
  identifiers: Identifiers,
) {
  return prisma.client.create({
    data: {
      companyId,
      name: `Buyer ${where.countryCode} ${type}`,
      type,
      address: '1 Client Street',
      postalCode: '00001',
      ...where,
      partyIdentifiers: { create: identifierRows(identifiers) },
    },
  });
}

function documentFor(clientId: string, status: string) {
  return {
    id: 'doc-1',
    typeId: 'invoice',
    status,
    data: documentData(clientId),
    createdAt: new Date(),
    updatedAt: new Date(),
    number: status === 'draft' ? undefined : 1,
    displayNumber: status === 'draft' ? undefined : 'INV-2026-0001',
  };
}

function documentData(clientId: string) {
  return {
    client: clientId,
    issueDate: '2026-10-23',
    dueDate: '2026-11-22',
    currency: 'EUR',
    lines: [{ description: 'Consulting', quantity: 1, unit: 'unit', unitPrice: 100, vatRate: '20' }],
  };
}

function invoiceRegistry() {
  const transportRegistry = new TransportRegistry();
  transportRegistry.register('email', 'Email', { send: vi.fn().mockResolvedValue({ message: 'queued' }) });
  const registry = new ActionRegistry();
  registerInvoiceActions(registry, { transportRegistry, queueDispatcher: { enqueueAction: vi.fn() } });
  return registry;
}

async function run(action: 'validate' | 'send', companyId: string, clientId: string) {
  (persistence.findOwnedDocument as Mock).mockResolvedValue(documentFor(clientId, 'draft'));
  (takeNumber.takeDocumentNumberForTransitionWithStatus as Mock).mockResolvedValue({
    document: documentFor(clientId, action === 'validate' ? 'validated' : 'sending'),
    numbered: { number: 1, displayNumber: 'INV-2026-0001' },
  });
  const handler = invoiceRegistry().resolve('invoice', action);
  return handler!({
    companyId,
    typeId: 'invoice',
    documentId: 'doc-1',
    data: documentData(clientId),
    params: {},
    currentStatus: 'draft',
  });
}

async function rejection(promise: Promise<unknown>): Promise<{ message: string; response: any }> {
  try {
    await promise;
  } catch (error) {
    return error as { message: string; response: any };
  }
  throw new Error('expected the action to be refused');
}

describe("Validate refuses an invoice missing an identifier its seller's country requires", () => {
  beforeAll(async () => {
    await seedCountryIdentifierRequirements(prisma);
  });

  afterAll(async () => {
    await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  });

  afterEach(() => vi.resetAllMocks());

  beforeEach(() => {
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
  });

  it('a French seller under the franchise en base validates without a VAT number', async () => {
    const company = await seller(FRANCE, { LEGAL_ID: '732829320' }, true);
    const client = await buyer(company.id, FRANCE, 'COMPANY', { LEGAL_ID: '552100554' });

    const result = await run('validate', company.id, client.id);

    expect(result.changed).toBe(true);
    expect(takeNumber.takeDocumentNumberForTransitionWithStatus).toHaveBeenCalledTimes(1);
  });

  it('a VAT-registered French seller without its VAT number is refused, naming it', async () => {
    const company = await seller(FRANCE, { LEGAL_ID: '732829320' });
    const client = await buyer(company.id, FRANCE, 'COMPANY', { LEGAL_ID: '552100554' });

    const error = await rejection(run('validate', company.id, client.id));

    expect(error.message).toMatch(/N° TVA intracommunautaire/);
    expect(error.response).toMatchObject({
      code: INVOICE_IDENTIFIERS_MISSING_CODE,
      params: {
        clientId: client.id,
        missing: [{ party: 'SELLER', scheme: 'VAT', label: 'N° TVA intracommunautaire' }],
      },
    });
    expect(takeNumber.takeDocumentNumberForTransitionWithStatus).not.toHaveBeenCalled();
  });

  it('Send on a draft is refused the same way, before any number is taken', async () => {
    const company = await seller(FRANCE, { LEGAL_ID: '732829320' });
    const client = await buyer(company.id, FRANCE, 'COMPANY', { LEGAL_ID: '552100554' });

    const error = await rejection(run('send', company.id, client.id));

    expect(error.response.code).toBe(INVOICE_IDENTIFIERS_MISSING_CODE);
    expect(takeNumber.takeDocumentNumberForTransitionWithStatus).not.toHaveBeenCalled();
  });

  it("an intra-EU business buyer without its VAT number is refused, named under its own country's label", async () => {
    const company = await seller(FRANCE, { LEGAL_ID: '732829320', VAT: 'FR44732829320' });
    const client = await buyer(company.id, GERMANY, 'COMPANY', {});

    const error = await rejection(run('validate', company.id, client.id));

    expect(error.response).toMatchObject({
      code: INVOICE_IDENTIFIERS_MISSING_CODE,
      params: {
        missing: [{ party: 'BUYER', scheme: 'VAT', label: 'Umsatzsteuer-Identifikationsnummer (USt-IdNr.)' }],
      },
    });
    expect(takeNumber.takeDocumentNumberForTransitionWithStatus).not.toHaveBeenCalled();
  });

  it('a French domestic business buyer without its SIREN is refused before a number is taken', async () => {
    const company = await seller(FRANCE, { LEGAL_ID: '732829320', VAT: 'FR44732829320' });
    const client = await buyer(company.id, FRANCE, 'COMPANY', {});

    const error = await rejection(run('validate', company.id, client.id));

    expect(error.message).toMatch(/SIREN \/ SIRET/);
    expect(takeNumber.takeDocumentNumberForTransitionWithStatus).not.toHaveBeenCalled();
  });

  it('a private buyer in another member state is not asked for a VAT number', async () => {
    const company = await seller(FRANCE, { LEGAL_ID: '732829320', VAT: 'FR44732829320' });
    const client = await buyer(company.id, GERMANY, 'INDIVIDUAL', {});

    const result = await run('validate', company.id, client.id);

    expect(result.changed).toBe(true);
  });

  it('a Polish seller is refused for a domestic business buyer without its NIP', async () => {
    const company = await seller(POLAND, { LEGAL_ID: '5260250274' });
    const client = await buyer(company.id, POLAND, 'COMPANY', {});

    const error = await rejection(run('validate', company.id, client.id));

    expect(error.response).toMatchObject({
      code: INVOICE_IDENTIFIERS_MISSING_CODE,
      params: { missing: [{ party: 'BUYER', scheme: 'LEGAL_ID', label: 'NIP' }] },
    });
    expect(takeNumber.takeDocumentNumberForTransitionWithStatus).not.toHaveBeenCalled();
  });
});
