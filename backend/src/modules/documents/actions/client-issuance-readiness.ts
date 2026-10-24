import { BadRequestException } from '@nestjs/common';

import prisma from '@/prisma/prisma.service';

import { findMissingInvoiceIdentifiers } from './invoice-identifier-readiness';

export const CLIENT_INCOMPLETE_CODE = 'CLIENT_INCOMPLETE';

export type MissingClientAddressField = 'address' | 'city';

interface MissingClientFields {
  address: MissingClientAddressField[];
  identifiers: { scheme: string; label: string }[];
}

export interface ClientIncompleteParams {
  clientId: string;
  clientName: string;
  address: MissingClientAddressField[];
  identifiers: { scheme: string; label: string }[];
}

interface ClientAddress {
  address: string | null;
  city: string | null;
}

const isBlank = (value: string | null | undefined): boolean => !value || value.trim() === '';

export function findMissingClientAddress(client: ClientAddress): MissingClientAddressField[] {
  const missing: MissingClientAddressField[] = [];
  if (isBlank(client.address)) missing.push('address');
  if (isBlank(client.city)) missing.push('city');
  return missing;
}

function describeMissing(clientName: string, missing: MissingClientFields): string {
  const names = [...missing.address, ...missing.identifiers.map((identifier) => identifier.label)];
  return `Client "${clientName}" is incomplete. Missing: ${names.join(', ')}. Complete the client before issuing an invoice.`;
}

/**
 * Refuses to number an invoice for a client with no postal address and city. Drafts and quotes never
 * reach this. A missing identifier alone is `assertInvoiceIdentifiersPresent`'s refusal; it is named
 * here too, from the same rules, so one edit completes the client.
 */
export async function assertClientReadyForInvoice(
  companyId: string,
  clientId: string | undefined,
): Promise<void> {
  if (!clientId) return;
  const client = await prisma.client.findFirst({
    where: { id: clientId, companyId },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      contacts: { where: { isPrimary: true }, select: { firstName: true, lastName: true }, take: 1 },
    },
  });
  if (!client) return;

  const address = findMissingClientAddress(client);
  if (address.length === 0) return;
  const { missing: invoiceIdentifiers } = await findMissingInvoiceIdentifiers(companyId, client.id);
  const missing: MissingClientFields = {
    address,
    identifiers: invoiceIdentifiers
      .filter((identifier) => identifier.party === 'BUYER')
      .map(({ scheme, label }) => ({ scheme, label })),
  };

  const primary = client.contacts[0];
  const clientName =
    client.name || [primary?.firstName, primary?.lastName].filter(Boolean).join(' ') || client.id;
  const params: ClientIncompleteParams = {
    clientId: client.id,
    clientName,
    address: missing.address,
    identifiers: missing.identifiers,
  };
  throw new BadRequestException({
    message: describeMissing(clientName, missing),
    code: CLIENT_INCOMPLETE_CODE,
    params,
  });
}
