import { readFileSync } from "node:fs"
import { join } from "node:path"

import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const useCountryReadiness = vi.fn()
vi.mock("@/hooks/use-country-readiness", () => ({
  useCountryReadiness: (...args: unknown[]) => useCountryReadiness(...args),
}))

import CountryReadinessAlert from "@/components/country-readiness-alert"

const COUNTRY_RULE_FORM = readFileSync(
  join(__dirname, "..", "..", "..", ".github", "ISSUE_TEMPLATE", "country_rule.yml"),
  "utf8",
)

function issueLink() {
  return new URL(screen.getByTestId("company-country-open-issue").getAttribute("href") ?? "")
}

function renderFor(
  readiness: { countryCode: string; present: string[]; missing: string[] },
  countryName?: string,
) {
  useCountryReadiness.mockReturnValue({ data: { ...readiness, complete: false } })
  render(<CountryReadinessAlert countryCode={readiness.countryCode} countryName={countryName} />)
}

describe("CountryReadinessAlert issue link", () => {
  beforeEach(() => useCountryReadiness.mockReset())

  it("opens the country rule form with the title and the rule pre-filled", () => {
    renderFor(
      { countryCode: "PT", present: ["country-policy"], missing: ["vat-rates", "tax-systems"] },
      "Portugal",
    )

    const url = issueLink()
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/invoicerr-app/invoicerr/issues/new")
    expect(url.searchParams.get("template")).toBe("country_rule.yml")
    expect(url.searchParams.get("title")).toBe("Support request for Portugal (PT)")
    expect(url.searchParams.get("rule")).toBe(
      "Country: Portugal (PT)\nAlready supported: document rules\nMissing: VAT rates, tax system",
    )
    expect(url.searchParams.has("body")).toBe(false)
  })

  it("selects the country in the form when the country already has a data file", () => {
    renderFor({ countryCode: "PT", present: ["country-policy"], missing: ["vat-rates"] }, "Portugal")

    const country = issueLink().searchParams.get("country")
    expect(country).toBe("Portugal (PT)")
    expect(COUNTRY_RULE_FORM).toContain(`        - ${country}\n`)
  })

  it("selects Other when the country has no data file at all", () => {
    renderFor({ countryCode: "BE", present: [], missing: ["country-policy", "vat-rates"] }, "Belgique")

    const url = issueLink()
    const country = url.searchParams.get("country")
    expect(country).toBe("Other (say which in the rule below)")
    expect(COUNTRY_RULE_FORM).toContain(`        - ${country}\n`)
    expect(url.searchParams.get("rule")).toContain("Country: Belgique (BE)")
  })
})
