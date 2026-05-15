export function supportsModernRegexFeatures(): boolean {
  try {
    new RegExp('', 'd')
    new RegExp('[[]]', 'v')
    new RegExp('(?<=a)b')
    new RegExp('(?<!a)b')
    new RegExp('(?<label>a)')
    return true
  } catch {
    return false
  }
}
