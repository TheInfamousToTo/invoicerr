import { BadRequestException } from '@nestjs/common';

import prisma from '@/prisma/prisma.service';

import {
  MissingInvoiceIdentifier,
  invoiceBuyer,
  invoiceSeller,
  missingInvoiceIdentifiers,
} from '../country-identifiers/printed-identifiers';

export const INVOICE_IDENTIFIERS_MISSING_CODE = 'INVOICE_IDENTIFIERS_MISSING';

export interface InvoiceIdentifiersMissingParams {
  clientId?: string;
  missing: MissingInvoiceIdentifier[];
}

const PARTY_NAMES = { SELLER: 'seller', BUYER: 'buyer' } as const;

const partyIdentifierSelect = {
  countryCode: true,
  country: true,
  partyIdentifiers: { select: { scheme: true, value: true } },
} as const;

/**
 * Refuses to number an invoice that lacks an identifier the seller's country requires on it, read
 * from that country's `identifiers.invoiceRequirements` with the same conditions the working-copy
 * PDF uses to flag a missing one.
 */
export async function assertInvoiceIdentifiersPresent(
  companyId: string,
  clientId: string | undefined,
): Promise<void> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { ...partyIdentifierSelect, exemptVat: true },
  });
  if (!company) return;
  const client = clientId
    ? await prisma.client.findFirst({
        where: { id: clientId, companyId },
        select: { ...partyIdentifierSelect, type: true },
      })
    : null;

  const missing = missingInvoiceIdentifiers(
    invoiceSeller(company),
    client ? invoiceBuyer(client) : undefined,
  );
  if (missing.length === 0) return;

  const names = missing.map((identifier) => `${identifier.label} (${PARTY_NAMES[identifier.party]})`);
  const params: InvoiceIdentifiersMissingParams = { clientId: client ? clientId : undefined, missing };
  throw new BadRequestException({
    message: `This invoice is missing identifiers its seller's country requires: ${names.join(', ')}. Complete them before issuing it.`,
    code: INVOICE_IDENTIFIERS_MISSING_CODE,
    params,
  });
}
