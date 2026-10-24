import { vi, type Mock } from 'vitest';

import prisma from '@/prisma/prisma.service';

import {
  ISSUABLE_CLIENT_FIELDS,
  ISSUABLE_FRENCH_SELLER_FIELDS,
  NAME_ONLY_CLIENT_FIELDS,
  createTestCompany,
} from '../__tests__/issuable-client';
import {
  draftInvoiceContext,
  invoiceActionRegistry,
  issuanceDocument,
  rejection,
  stubIssuanceCollaborators,
} from '../__tests__/invoice-action-harness';
import { seedCountryIdentifierRequirements } from '../country-identifiers/seed';
import { buildQuoteDescriptor } from '../descriptors/quote.descriptor';
import { DocumentTypeRegistry } from '../descriptors/type-registry';
import * as takeNumber from '../numbering/take-number';
import * as persistence from '../persistence';
import { EntityReferenceRegistry } from '../references/reference-registry';
import { ActionRegistry } from './action-registry';
import { CLIENT_INCOMPLETE_CODE, findMissingClientAddress } from './client-issuance-readiness';
import { registerQuoteActions } from './quote-actions';

vi.mock('../tax/load-and-resolve');
vi.mock('../numbering/take-number');
vi.mock('../b2g-routing/b2g-routing');
vi.mock('../transports/channel-policy/mandate');
vi.mock('../country-policy/country-policy');
vi.mock('../transports/company-transport');
vi.mock('../persistence');

let seededCompanyId = '';
const companyId = () => seededCompanyId;
const documentFor = issuanceDocument;
const ctxFor = (clientId: string) => draftInvoiceContext(companyId(), clientId);

describe('issuing an invoice requires a complete client; a quote does not', () => {
  let incompleteId = '';
  let completeId = '';

  beforeAll(async () => {
    await seedCountryIdentifierRequirements(prisma);
    const company = await createTestCompany('Issuance Gate Co');
    seededCompanyId = company.id;
    await prisma.company.update({ where: { id: company.id }, data: ISSUABLE_FRENCH_SELLER_FIELDS });
    const incomplete = await prisma.client.create({
      data: { companyId: company.id, name: 'Name Only SARL', ...NAME_ONLY_CLIENT_FIELDS },
    });
    incompleteId = incomplete.id;
    const complete = await prisma.client.create({
      data: { companyId: company.id, name: 'Complete SARL', ...ISSUABLE_CLIENT_FIELDS },
    });
    completeId = complete.id;
  });

  afterAll(async () => {
    await prisma.company.delete({ where: { id: seededCompanyId } }).catch(() => undefined);
  });

  afterEach(() => vi.resetAllMocks());

  beforeEach(() => stubIssuanceCollaborators());

  it('Validate is refused for a client with no address, city or catalog-required identifier, naming each', async () => {
    (persistence.findOwnedDocument as Mock).mockResolvedValue(documentFor(incompleteId, 'invoice', 'draft'));
    const handler = invoiceActionRegistry().resolve('invoice', 'validate');

    const error = await rejection(handler!(ctxFor(incompleteId)));

    expect(error.message).toMatch(/Name Only SARL/);
    expect(error.message).toMatch(/address, city, SIREN \/ SIRET/);
    expect(error.response).toMatchObject({
      code: CLIENT_INCOMPLETE_CODE,
      params: {
        clientId: incompleteId,
        clientName: 'Name Only SARL',
        address: ['address', 'city'],
        identifiers: [{ scheme: 'LEGAL_ID', label: 'SIREN / SIRET' }],
      },
    });
    expect(takeNumber.takeDocumentNumberForTransitionWithStatus).not.toHaveBeenCalled();
  });

  it('a private client missing its address is asked for the address only, never a SIREN', async () => {
    const individual = await prisma.client.create({
      data: { companyId: companyId(), type: 'INDIVIDUAL', name: 'Jeanne Martin', ...NAME_ONLY_CLIENT_FIELDS },
    });
    (persistence.findOwnedDocument as Mock).mockResolvedValue(documentFor(individual.id, 'invoice', 'draft'));
    const handler = invoiceActionRegistry().resolve('invoice', 'validate');

    const error = await rejection(handler!(ctxFor(individual.id)));

    expect(error.response).toMatchObject({
      code: CLIENT_INCOMPLETE_CODE,
      params: { address: ['address', 'city'], identifiers: [] },
    });
  });

  it('Send is refused the same way, before any number is taken', async () => {
    (persistence.findOwnedDocument as Mock).mockResolvedValue(documentFor(incompleteId, 'invoice', 'draft'));
    const handler = invoiceActionRegistry().resolve('invoice', 'send');

    const error = await rejection(handler!(ctxFor(incompleteId)));

    expect(error.response.code).toBe(CLIENT_INCOMPLETE_CODE);
    expect(takeNumber.takeDocumentNumberForTransitionWithStatus).not.toHaveBeenCalled();
  });

  it('Validate succeeds once the client carries its address, city and required identifier', async () => {
    (persistence.findOwnedDocument as Mock).mockResolvedValue(documentFor(completeId, 'invoice', 'draft'));
    (takeNumber.takeDocumentNumberForTransitionWithStatus as Mock).mockResolvedValue({
      document: documentFor(completeId, 'invoice', 'validated'),
      numbered: { number: 1, displayNumber: 'INV-2026-0001' },
    });
    const handler = invoiceActionRegistry().resolve('invoice', 'validate');

    const result = await handler!(ctxFor(completeId));

    expect(result.changed).toBe(true);
    expect(takeNumber.takeDocumentNumberForTransitionWithStatus).toHaveBeenCalledTimes(1);
  });

  it('Send succeeds once the client is complete', async () => {
    const draft = documentFor(completeId, 'invoice', 'draft');
    (persistence.findOwnedDocument as Mock).mockResolvedValue(draft);
    (takeNumber.takeDocumentNumberForTransitionWithStatus as Mock).mockResolvedValue({
      document: documentFor(completeId, 'invoice', 'sending'),
      numbered: { number: 1, displayNumber: 'INV-2026-0001' },
    });
    const handler = invoiceActionRegistry().resolve('invoice', 'send');

    const result = await handler!(ctxFor(completeId));

    expect(result.changed).toBe(true);
    expect(result.document).toMatchObject({ status: 'sending' });
  });

  it('a quote for the incomplete client still sends', async () => {
    (persistence.findOwnedDocument as Mock).mockResolvedValue(documentFor(incompleteId, 'quote', 'draft'));
    (takeNumber.takeDocumentNumberForTransitionWithStatus as Mock).mockResolvedValue({
      document: documentFor(incompleteId, 'quote', 'sending'),
      numbered: { number: 1, displayNumber: 'QUOTE-2026-0001' },
    });
    (takeNumber.takeDocumentNumberForTransition as Mock).mockResolvedValue(undefined);
    const typeRegistry = new DocumentTypeRegistry();
    typeRegistry.register(buildQuoteDescriptor());
    const registry = new ActionRegistry();
    registerQuoteActions(registry, {
      clientsService: { getClientById: vi.fn().mockResolvedValue(null) } as never,
      mailService: { sendForCompany: vi.fn() } as never,
      typeRegistry,
      referenceRegistry: new EntityReferenceRegistry(),
      queueDispatcher: { enqueueAction: vi.fn() },
    });

    const result = await registry.resolve('quote', 'send')!({
      ...ctxFor(incompleteId),
      typeId: 'quote',
      params: { recipient: 'client@example.com' },
    });

    expect(result.changed).toBe(true);
  });
});

describe('findMissingClientAddress', () => {
  it('treats blank strings as missing', () => {
    expect(findMissingClientAddress({ address: '  ', city: '' })).toEqual(['address', 'city']);
  });

  it('reports nothing for a complete address', () => {
    expect(findMissingClientAddress({ address: '1 Rue', city: 'Paris' })).toEqual([]);
  });
});
