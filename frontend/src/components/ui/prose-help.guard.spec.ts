import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

import { findPermanentProse } from "./prose-help.guard"

const SRC = join(__dirname, "..", "..")

// Short status lines kept visible on purpose: each is one line, and hiding it would hide the status itself.
const ONE_LINE_STATUSES = new Set([
  "components/documents/document-totals.tsx",
  "components/widgets/widget-renderers/metric-widget.tsx",
])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx$/.test(name) && !/\.spec\.tsx$/.test(name) ? [path] : []
  })
}

describe("explanatory prose guard", () => {
  it.each([
    [
      "a list of server warnings rendered as paragraphs",
      `<div className="rounded-md bg-warning p-2">
        {warnings.map((warning) => <p key={warning}>{warning}</p>)}
      </div>`,
    ],
    [
      "a nested list of notes",
      `<ul>{period.consolidated.notes.map((note) => <li key={note}>{note}</li>)}</ul>`,
    ],
    ["a prefixed warnings list", `{lineTotalWarnings.map((warning) => <p key={warning}>{warning}</p>)}`],
    [
      "a retention citation interpolated into a visible line",
      `<p>{t("documents.archive.retainUntil", { date, basis: archive.retentionBasis })}</p>`,
    ],
    ["a statute quote passed to a row", `<SettingsListRow meta={obligation.provenance.sourceText} />`],
    ["a resolution note held in a variable", `const quote = provenance?.resolutionNote`],
    ["a server disclaimer in an alert", `<AlertDescription>{report?.disclaimer}</AlertDescription>`],
    ["a long explanation key", `<p>{t("documents.correction.limitation")}</p>`],
  ])("flags %s", (_case, source) => {
    expect(findPermanentProse(source)).toHaveLength(1)
  })

  it.each([
    [
      "warnings behind a ProseHelp",
      `<ProseHelp tone="warning" title={title}>
        {warnings.map((warning) => <span key={warning}>{warning}</span>)}
      </ProseHelp>`,
    ],
    ["a citation behind a ProseHelp", `<ProseHelp title={date}>{archive.retentionBasis}</ProseHelp>`],
    [
      "a quote behind a FieldHelp",
      `<FieldHelp id={id}>{provenance.kind === "legal" ? provenance.sourceText : provenance.resolutionNote}</FieldHelp>`,
    ],
    ["a type declaration", `interface P { sourceText?: string; resolutionNote?: string }`],
    ["warnings joined into a native tooltip", `<Badge title={period.warnings.join(" ")} />`],
    [
      "comments that name the fields",
      `// the backend's own \`data.limitation\` and \`provenance.sourceText\`
      {/* never \`warnings.map(\` here */}`,
    ],
    ["a warnings count", `{warnings.length > 0 && <Badge>{warnings.length}</Badge>}`],
  ])("leaves %s alone", (_case, source) => {
    expect(findPermanentProse(source)).toEqual([])
  })

  it("finds no explanatory prose rendered permanently anywhere in the app", () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !ONE_LINE_STATUSES.has(relative(SRC, path)))
      .flatMap((path) =>
        findPermanentProse(readFileSync(path, "utf8")).map(
          (hit) => `${relative(SRC, path)}:${hit.line}: ${hit.text}`,
        ),
      )
    expect(
      offenders,
      "Explanatory prose goes behind a `?` (<ProseHelp>); a warning keeps a one-line status as its title.",
    ).toEqual([])
  })
})
