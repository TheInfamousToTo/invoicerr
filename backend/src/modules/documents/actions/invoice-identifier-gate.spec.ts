import { vi, type Mock } from 'vitest';

import prisma from '@/prisma/prisma.service';

import {
  draftInvoiceContext,
  invoiceActionRegistry,
  issuanceDocument,
  rejection,
  stubIssuanceCollaborators,
} from '../__tests__/invoice-action-harness';
import { createTestCompany } from '../__tests__/issuable-client';
import { seedCountryIdentifierRequirements } from '../country-identifiers/seed';
import * as takeNumber from '../numbering/take-number';
import * as persistence from '../persistence';
import { INVOICE_IDENTIFIERS_MISSING_CODE } from './invoice-identifier-readiness';

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

async function run(action: 'validate' | 'send', companyId: string, clientId: string) {
  (persistence.findOwnedDocument as Mock).mockResolvedValue(issuanceDocument(clientId, 'invoice', 'draft'));
  (takeNumber.takeDocumentNumberForTransitionWithStatus as Mock).mockResolvedValue({
    document: issuanceDocument(clientId, 'invoice', action === 'validate' ? 'validated' : 'sending'),
    numbered: { number: 1, displayNumber: 'INV-2026-0001' },
  });
  return invoiceActionRegistry().resolve('invoice', action)!(draftInvoiceContext(companyId, clientId));
}

describe("Validate refuses an invoice missing an identifier its seller's country requires", () => {
  beforeAll(async () => {
    await seedCountryIdentifierRequirements(prisma);
  });

  afterAll(async () => {
    await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } });
  });

  afterEach(() => vi.resetAllMocks());

  beforeEach(() => stubIssuanceCollaborators());

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
