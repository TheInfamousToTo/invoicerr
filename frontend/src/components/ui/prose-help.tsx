import { AlertTriangle } from "lucide-react"
import type * as React from "react"
import { useId } from "react"

import { FieldHelp } from "@/components/ui/field-help"
import { cn } from "@/lib/utils"

type ProseHelpProps = Readonly<{
  title: React.ReactNode
  children: React.ReactNode
  tone?: "note" | "warning"
  dataCy?: string
  className?: string
}>

// A title with a `?`: the prose opens on hover, focus and tap. A warning keeps its title visible as a status.
export function ProseHelp({ title, children, tone = "note", dataCy, className }: ProseHelpProps) {
  const id = useId()
  const warning = tone === "warning"
  return (
    <div
      data-cy={dataCy}
      data-slot="prose-help"
      className={cn(
        "flex items-center gap-1.5 text-xs",
        warning
          ? "rounded-md bg-warning px-2 py-1.5 font-medium text-warning-foreground"
          : "text-muted-foreground",
        className,
      )}
    >
      {warning && <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />}
      <span className="min-w-0" aria-describedby={id}>
        {title}
      </span>
      <FieldHelp
        id={id}
        label={typeof title === "string" ? title : undefined}
        dataCy={dataCy ? `${dataCy}-help` : undefined}
        className={
          warning
            ? "text-warning-foreground hover:text-warning-foreground/80 data-[state=open]:text-warning-foreground"
            : undefined
        }
      >
        {children}
      </FieldHelp>
    </div>
  )
}

// Several server texts in one popover, one paragraph each.
export function ProseParagraphs({ texts }: Readonly<{ texts: readonly string[] }>) {
  return texts.map((text) => (
    <span key={text} className="block not-first:mt-2">
      {text}
    </span>
  ))
}
