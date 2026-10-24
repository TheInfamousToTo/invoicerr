import i18next from "i18next"
import { describe, expect, it } from "vitest"

import en from "@/locales/en/translation.json"
import fr from "@/locales/fr/translation.json"

import { invoiceIdentifiersMissingNotice } from "./invoice-identifiers-missing"

async function translator(language: "en" | "fr") {
  const instance = i18next.createInstance()
  await instance.init({
    lng: language,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: { en: { translation: en }, fr: { translation: fr } },
  })
  return instance.t
}

const sellerVat = { party: "SELLER" as const, scheme: "VAT", label: "N° TVA intracommunautaire" }
const buyerVat = {
  party: "BUYER" as const,
  scheme: "VAT",
  label: "Umsatzsteuer-Identifikationsnummer (USt-IdNr.)",
}

describe("the refusal of an invoice missing identifiers its seller's country requires", () => {
  it("names each missing identifier under its country's label and says whose it is", async () => {
    const notice = invoiceIdentifiersMissingNotice(await translator("en"), "en", {
      clientId: "client-1",
      missing: [sellerVat, buyerVat],
    })

    expect(notice.message).toBe(
      "Add N° TVA intracommunautaire (your company) and Umsatzsteuer-Identifikationsnummer (USt-IdNr.) " +
        "(client) before validating or sending this invoice.",
    )
  })

  it("is translated", async () => {
    const notice = invoiceIdentifiersMissingNotice(await translator("fr"), "fr", { missing: [sellerVat] })

    expect(notice.message).toBe(
      "Ajoutez N° TVA intracommunautaire (votre entreprise) avant de valider ou d'envoyer cette facture.",
    )
  })

  it("leads to the company settings when the company is missing one", async () => {
    const notice = invoiceIdentifiersMissingNotice(await translator("en"), "en", {
      clientId: "client-1",
      missing: [sellerVat, buyerVat],
    })

    expect(notice.action).toEqual({ label: "Edit company", path: "/settings/company" })
  })

  it("leads to the client when only the client is missing one", async () => {
    const notice = invoiceIdentifiersMissingNotice(await translator("en"), "en", {
      clientId: "client-1",
      missing: [buyerVat],
    })

    expect(notice.action).toEqual({ label: "Edit client", path: "/clients?edit=client-1" })
  })
})
