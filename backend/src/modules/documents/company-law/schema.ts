import { SUPPORTED_RENDER_LANGUAGES, RenderLanguage } from '../rendering/language/supported-languages';

/** The seller's legal form, share capital and trade register a country requires on its documents. */

export interface LegalProvenance {
  kind: 'legal';
  /** The exact text this fact is based on, quoted, not paraphrased. */
  sourceText: string;
  /** ISO date (yyyy-mm-dd) this text was last checked against its source. */
  sourceCheckedAt: string;
}

export interface UnverifiedProvenance {
  kind: 'unverified';
  resolutionNote: string;
}

export type CompanyLawProvenance = LegalProvenance | UnverifiedProvenance;

export type CompanyLawFieldKind = 'text' | 'money';

export interface CompanyLawField {
  /** Stored on the company under this key; quoted by a template as `{key}`. */
  key: string;
  kind: CompanyLawFieldKind;
  /** The country's own name for it, shown beside the input and in a missing marker. */
  label: string;
}

export interface CompanyLegalForm {
  /** Stored on the company; prefixed with the country code, e.g. `FR_SAS`. */
  code: string;
  name: string;
  /** What `{legalForm}` prints: the designation the law accepts. */
  designation: string;
  notes?: string;
}

export interface CompanyLawMention {
  id: string;
  /** Document type ids (`DocumentTypeDescriptor.id`) the mention is printed on. */
  documentTypes: string[];
  legalForms: string[];
  /** `false`: printed once every placeholder is filled, never asked for. */
  required: boolean;
  template: Record<RenderLanguage, string>;
  provenance: CompanyLawProvenance;
  notes?: string;
}

export interface CountryCompanyLawFile {
  countryCode: string;
  /** The country's own name for the legal form, used in a missing marker. */
  legalFormLabel: string;
  legalForms: CompanyLegalForm[];
  fields: CompanyLawField[];
  mentions: CompanyLawMention[];
  notes?: string;
}

export type CompanyLawPlaceholder =
  | { kind: 'legalForm' }
  | { kind: 'field'; key: string }
  | { kind: 'identifier'; scheme: string };

export type TemplatePart = { text: string } | { placeholder: CompanyLawPlaceholder };

const PLACEHOLDER = /\{([^{}]+)\}/g;
const FIELD_KEY = /^[a-z][A-Za-z0-9]*$/;
const SCHEME = /^[A-Z][A-Z0-9_]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_KINDS: readonly CompanyLawFieldKind[] = ['text', 'money'];

function parsePlaceholder(token: string): CompanyLawPlaceholder | undefined {
  if (token === 'legalForm') return { kind: 'legalForm' };
  if (token.startsWith('identifier:')) {
    const scheme = token.slice('identifier:'.length);
    return SCHEME.test(scheme) ? { kind: 'identifier', scheme } : undefined;
  }
  return FIELD_KEY.test(token) ? { kind: 'field', key: token } : undefined;
}

/** Splits a template into literal text and placeholders; an unreadable placeholder is kept as text. */
export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const placeholder = parsePlaceholder(match[1]);
    if (!placeholder) continue;
    if (match.index > last) parts.push({ text: template.slice(last, match.index) });
    parts.push({ placeholder });
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}

const placeholderKey = (placeholder: CompanyLawPlaceholder) =>
  placeholder.kind === 'legalForm'
    ? 'legalForm'
    : placeholder.kind === 'field'
      ? placeholder.key
      : `identifier:${placeholder.scheme}`;

export class InvalidCompanyLawSectionError extends Error {}

function assertValidProvenance(mention: CompanyLawMention, fail: (reason: string) => never): void {
  const provenance = mention.provenance as
    | { kind?: string; sourceText?: string; sourceCheckedAt?: string; resolutionNote?: string }
    | undefined;
  if (provenance?.kind === 'legal') {
    if (!provenance.sourceText?.trim()) fail(`mention "${mention.id}" quotes no sourceText.`);
    if (!ISO_DATE.test(provenance.sourceCheckedAt ?? ''))
      fail(`mention "${mention.id}" has no sourceCheckedAt date.`);
    return;
  }
  if (provenance?.kind === 'unverified') {
    if (!provenance.resolutionNote?.trim())
      fail(`mention "${mention.id}" is unverified with no resolutionNote.`);
    return;
  }
  fail(`mention "${mention.id}" has no valid provenance (kind must be "legal" or "unverified").`);
}

function assertValidTemplate(
  mention: CompanyLawMention,
  fieldKeys: Set<string>,
  fail: (reason: string) => never,
): void {
  let reference: string | undefined;
  for (const language of SUPPORTED_RENDER_LANGUAGES) {
    const template = mention.template?.[language];
    if (!template?.trim()) fail(`mention "${mention.id}" has no "${language}" template.`);
    const tokens = [...template.matchAll(PLACEHOLDER)].map((match) => match[1]);
    for (const token of tokens) {
      const placeholder = parsePlaceholder(token);
      if (!placeholder) fail(`mention "${mention.id}" uses unreadable placeholder "{${token}}".`);
      if (placeholder.kind === 'field' && !fieldKeys.has(placeholder.key))
        fail(`mention "${mention.id}" uses undeclared field "{${token}}".`);
    }
    const signature = tokens.toSorted().join(',');
    reference ??= signature;
    if (signature !== reference)
      fail(`mention "${mention.id}" uses different placeholders in its "${language}" template.`);
  }
}

/** Refused at load time: a section the resolver could only half read would print a wrong mention. */
export function assertValidCompanyLawSection(file: CountryCompanyLawFile, context: string): void {
  function fail(reason: string): never {
    throw new InvalidCompanyLawSectionError(`${context}: ${reason}`);
  }
  if (!file.legalFormLabel?.trim()) fail('declares no legalFormLabel.');
  if (!Array.isArray(file.legalForms) || file.legalForms.length === 0) fail('declares no legal form.');

  const formCodes = new Set<string>();
  for (const form of file.legalForms) {
    if (!form.code?.trim() || !form.name?.trim() || !form.designation?.trim())
      fail(`legal form "${form.code}" needs a code, a name and a designation.`);
    // A company keeps its legal form across a change of country, so a code must never mean a form elsewhere.
    if (!form.code.startsWith(`${file.countryCode}_`))
      fail(`legal form "${form.code}" must start with "${file.countryCode}_".`);
    if (formCodes.has(form.code)) fail(`legal form "${form.code}" is declared twice.`);
    formCodes.add(form.code);
  }

  const fieldKeys = new Set<string>();
  for (const field of file.fields ?? []) {
    if (!FIELD_KEY.test(field.key ?? '') || field.key === 'legalForm')
      fail(`field key "${field.key}" must be camelCase and not "legalForm".`);
    if (!FIELD_KINDS.includes(field.kind)) fail(`field "${field.key}" has unknown kind "${field.kind}".`);
    if (!field.label?.trim()) fail(`field "${field.key}" has no label.`);
    if (fieldKeys.has(field.key)) fail(`field "${field.key}" is declared twice.`);
    fieldKeys.add(field.key);
  }

  const mentionIds = new Set<string>();
  for (const mention of file.mentions ?? []) {
    if (!mention.id?.trim()) fail('a mention has no id.');
    if (mentionIds.has(mention.id)) fail(`mention "${mention.id}" is declared twice.`);
    mentionIds.add(mention.id);
    if (typeof mention.required !== 'boolean')
      fail(`mention "${mention.id}" does not say whether it is required.`);
    if (!Array.isArray(mention.documentTypes) || mention.documentTypes.length === 0)
      fail(`mention "${mention.id}" names no document type.`);
    if (!Array.isArray(mention.legalForms) || mention.legalForms.length === 0)
      fail(`mention "${mention.id}" names no legal form.`);
    for (const code of mention.legalForms) {
      if (!formCodes.has(code)) fail(`mention "${mention.id}" names undeclared legal form "${code}".`);
    }
    assertValidTemplate(mention, fieldKeys, fail);
    assertValidProvenance(mention, fail);
  }
}

export function templatePlaceholders(template: string): CompanyLawPlaceholder[] {
  const seen = new Map<string, CompanyLawPlaceholder>();
  for (const part of parseTemplate(template)) {
    if ('placeholder' in part) seen.set(placeholderKey(part.placeholder), part.placeholder);
  }
  return [...seen.values()];
}
