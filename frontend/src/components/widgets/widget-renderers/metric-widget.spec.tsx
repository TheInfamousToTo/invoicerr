import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { MetricWidget } from "@/components/widgets/types"
import { MetricWidgetRenderer } from "./metric-widget"

/** A metric with no `link`, so the tile renders as a plain `Card` and needs no router. */
function metric(overrides: Partial<MetricWidget> = {}): MetricWidget {
  return {
    id: "invoice:issued-this-month:EUR",
    kind: "metric",
    label: "Invoiced this month",
    value: 150,
    unit: "EUR",
    ...overrides,
  } as MetricWidget
}

describe("MetricWidgetRenderer variation chip (issue #598)", () => {
  it("shows the variation against the previous period", () => {
    render(<MetricWidgetRenderer widget={metric({ previousValue: 100 })} />)

    expect(screen.getByTestId("widget-invoice:issued-this-month:EUR-trend")).toHaveTextContent("+50%")
  })

  it("never puts a chip next to a current value of 0", () => {
    render(<MetricWidgetRenderer widget={metric({ value: 0, previousValue: 100 })} />)

    const trend = screen.getByTestId("widget-invoice:issued-this-month:EUR-trend")
    expect(trend).toBeEmptyDOMElement()
    expect(screen.queryByText("-100%")).not.toBeInTheDocument()
  })

  it("keeps the chip's row on a tile without a previous value, so tiles stay the same height", () => {
    render(<MetricWidgetRenderer widget={metric({ previousValue: undefined })} />)

    const trend = screen.getByTestId("widget-invoice:issued-this-month:EUR-trend")
    expect(trend).toBeEmptyDOMElement()
    expect(trend).toHaveClass("min-h-4")
  })
})
