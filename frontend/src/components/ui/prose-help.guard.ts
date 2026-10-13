// Text-based, like field-help.guard.ts, so it runs in the unit test job without a TypeScript program.

export type ProseHit = { line: number; text: string }

// Server-composed prose: lists of warnings or notes, and the fields that carry a citation or a caveat.
const PROSE_LIST = /\b[\w$.?]*(?:warnings|Warnings|notes|Notes)\s*\.map\(/g
const PROSE_FIELD =
  /\.(retentionBasis|sourceText|resolutionNote|disclaimer|limitation|explanations|retentionStale)\b/g
const HELP_OPEN = /<(ProseHelp|FieldHelp)\b/g
const HELP_CLOSE = /<\/(ProseHelp|FieldHelp)>/g

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length
}

function insideHelp(before: string): boolean {
  return (before.match(HELP_OPEN)?.length ?? 0) > (before.match(HELP_CLOSE)?.length ?? 0)
}

// Comments are blanked, newlines kept, so a comment naming a field is not a hit and line numbers hold.
function withoutComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ")
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, (match, lead: string) => lead + blank(match.slice(lead.length)))
}

// Explanatory prose goes behind a `?` (<ProseHelp> or <FieldHelp>); rendering it anywhere else shows it permanently.
export function findPermanentProse(raw: string): ProseHit[] {
  const source = withoutComments(raw)
  const hits: ProseHit[] = []
  for (const pattern of [PROSE_LIST, PROSE_FIELD]) {
    for (const match of source.matchAll(pattern)) {
      if (insideHelp(source.slice(0, match.index))) continue
      hits.push({ line: lineOf(source, match.index), text: match[0] })
    }
  }
  return hits.sort((a, b) => a.line - b.line)
}
