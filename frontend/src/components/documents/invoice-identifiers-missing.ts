import type { TFunction } from "i18next"

/** Server-side code `invoice-identifier-readiness.ts`'s own `INVOICE_IDENTIFIERS_MISSING_CODE` names
 *  a 400 with, mirrored by hand like the other coded refusals of `use-document-action-runner.ts`. */
export const INVOICE_IDENTIFIERS_MISSING_CODE = "INVOICE_IDENTIFIERS_MISSING"

export interface MissingInvoiceIdentifier {
  party: "SELLER" | "BUYER"
  scheme: string
  label: string
}

export interface InvoiceIdentifiersMissingParams {
  clientId?: string
  missing?: MissingInvoiceIdentifier[]
}

export interface InvoiceIdentifiersMissingNotice {
  message: string
  action?: { label: string; path: string }
}

export function invoiceIdentifiersMissingNotice(
  t: TFunction,
  language: string,
  params: InvoiceIdentifiersMissingParams,
): InvoiceIdentifiersMissingNotice {
  const missing = params.missing ?? []
  const names = missing.map((identifier) =>
    identifier.party === "SELLER"
      ? t("documents.form.messages.invoiceIdentifierMissingSeller", { label: identifier.label })
      : t("documents.form.messages.invoiceIdentifierMissingBuyer", { label: identifier.label }),
  )
  const message = t("documents.form.messages.invoiceIdentifiersMissing", {
    fields: new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(names),
  })

  if (missing.some((identifier) => identifier.party === "SELLER")) {
    return {
      message,
      action: {
        label: t("documents.form.messages.invoiceIdentifiersEditCompany"),
        path: "/settings/company",
      },
    }
  }
  if (params.clientId) {
    return {
      message,
      action: {
        label: t("documents.form.messages.clientIncompleteAction"),
        path: `/clients?edit=${params.clientId}`,
      },
    }
  }
  return { message }
}
