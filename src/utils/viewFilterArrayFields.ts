import type { FilterCondition } from '../types'
import { evaluatePropertyArrayCondition } from './viewFilterArrayProperties'

export type ViewFilterArrayKind = 'property' | 'relationship'

interface ArrayFieldCondition {
  cond: FilterCondition
  values: string[]
  arrayKind: ViewFilterArrayKind
  condVal: string
  regex: RegExp | null
}

function toStringValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function conditionList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map(toStringValue) : null
}

class WikilinkValue {
  private readonly trimmed: string

  constructor(private readonly raw: string) {
    this.trimmed = raw.trim()
  }

  get isBracketed(): boolean {
    return this.trimmed.startsWith('[[')
  }

  get normalizedStem(): string {
    return this.stem.toLowerCase()
  }

  get candidates(): string[] {
    const pipe = this.inner.indexOf('|')
    if (pipe >= 0) return [this.trimmed, this.inner.slice(0, pipe), this.inner.slice(pipe + 1)]
    return [this.trimmed, this.inner]
  }

  includesStem(target: WikilinkValue): boolean {
    return this.normalizedStem.includes(target.normalizedStem)
  }

  equals(target: WikilinkValue): boolean {
    const targetParts = target.parts
    return this.parts.some((part) => targetParts.some((targetPart) => part === targetPart))
  }

  private get parts(): string[] {
    const pipe = this.inner.indexOf('|')
    if (pipe >= 0) return [this.inner.substring(0, pipe).toLowerCase(), this.inner.substring(pipe + 1).toLowerCase()]
    return [this.inner.toLowerCase()]
  }

  private get stem(): string {
    return this.inner.split('|')[0] ?? this.inner
  }

  private get inner(): string {
    return this.trimmed.replace(/^\[\[/, '').replace(/\]\]$/, '')
  }
}

class RelationshipArrayField {
  private readonly links: WikilinkValue[]

  constructor(values: string[]) {
    this.links = values.map((value) => new WikilinkValue(value))
  }

  contains(targetValue: string): boolean {
    const target = new WikilinkValue(targetValue)
    return this.links.some((link) => target.isBracketed ? link.equals(target) : link.includesStem(target))
  }

  equals(targetValue: string): boolean {
    return this.links.length === 1 && this.links[0]?.equals(new WikilinkValue(targetValue)) === true
  }

  matchesAny(targets: string[] | null): boolean {
    return targets?.some((target) => this.links.some((link) => link.equals(new WikilinkValue(target)))) ?? false
  }

  matchesRegex(regex: RegExp): boolean {
    return this.links.some((link) => link.candidates.some((candidate) => regex.test(candidate)))
  }
}

const RELATIONSHIP_ARRAY_OPERATORS = {
  contains: (field, value) => field.contains(value),
  not_contains: (field, value) => !field.contains(value),
  equals: (field, value) => field.equals(value),
  not_equals: (field, value) => !field.equals(value),
  any_of: (field, _value, cond) => field.matchesAny(conditionList(cond.value)),
  none_of: (field, _value, cond) => !field.matchesAny(conditionList(cond.value)),
} satisfies Partial<Record<FilterCondition['op'], (field: RelationshipArrayField, value: string, cond: FilterCondition) => boolean>>

function textMatchResult(op: FilterCondition['op'], matched: boolean): boolean {
  if (op === 'contains' || op === 'equals') return matched
  if (op === 'not_contains' || op === 'not_equals') return !matched
  return false
}

function evaluateRelationshipArrayCondition(cond: FilterCondition, values: string[], condVal: string, regex: RegExp | null): boolean {
  const { op } = cond
  const field = new RelationshipArrayField(values)
  if (regex) return textMatchResult(op, field.matchesRegex(regex))
  return RELATIONSHIP_ARRAY_OPERATORS[op]?.(field, condVal, cond) ?? false
}

export function evaluateArrayFieldCondition({ cond, values, arrayKind, condVal, regex }: ArrayFieldCondition): boolean {
  if (arrayKind === 'property') return evaluatePropertyArrayCondition(cond, values, condVal, regex)
  return evaluateRelationshipArrayCondition(cond, values, condVal, regex)
}
