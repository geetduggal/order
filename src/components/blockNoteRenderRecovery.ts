const BLOCKNOTE_MISSING_ID_ERROR = "Block doesn't have id"
const BLOCKNOTE_RECOVERY_BOUNDARY_NAME = 'BlockNoteRenderRecoveryBoundary'
const RECOVERED_BLOCKNOTE_RENDER_ERROR_MARK = '__tolariaRecoveredBlockNoteRenderError'

type MarkedRecoveredBlockNoteRenderError = Error & {
  [RECOVERED_BLOCKNOTE_RENDER_ERROR_MARK]?: true
}

function hasRecoveredRenderErrorMark(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return Reflect.get(error as MarkedRecoveredBlockNoteRenderError, RECOVERED_BLOCKNOTE_RENDER_ERROR_MARK) === true
}

export function isRecoverableBlockNoteRenderError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(BLOCKNOTE_MISSING_ID_ERROR)
}

export function markRecoveredBlockNoteRenderError(error: unknown): void {
  if (!isRecoverableBlockNoteRenderError(error)) return
  const markedError = error as MarkedRecoveredBlockNoteRenderError
  Reflect.set(markedError, RECOVERED_BLOCKNOTE_RENDER_ERROR_MARK, true)
}

export function isRecoveredBlockNoteRenderError(
  error: unknown,
  componentStack: string,
): boolean {
  return isRecoverableBlockNoteRenderError(error)
    && (
      hasRecoveredRenderErrorMark(error)
      || componentStack.includes(BLOCKNOTE_RECOVERY_BOUNDARY_NAME)
    )
}
