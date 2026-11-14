// 跨 DSH 版本契约短语判定：
//   phrase = 字符串                          → 单一写法
//   phrase = ['a', 'b']                      → 任一同义写法命中即可
//   phrase = [{ name: 'rc.3', phrase: 'a' }] → 同上，并回报命中的是哪一版形状
// 注意：每个写法都是精确子串，不是宽松正则；所有写法都不在时判未命中（红），
// 这样平台再改形状时探针会红，而不是继续绿。
export function matchesPhrase(text, phrase, { absent = false } = {}) {
  const variants = (Array.isArray(phrase) ? phrase : [phrase]).map(item => typeof item === 'string'
    ? { name: undefined, phrase: item }
    : item)
  const found = variants
    .map(variant => ({ ...variant, at: text.indexOf(variant.phrase) }))
    .filter(variant => variant.at !== -1)
  const hit = absent ? found.length === 0 : found.length > 0
  return {
    hit,
    at: found.length === 0 ? -1 : found[0].at,
    matched: found.length === 0 ? undefined : found[0].name,
  }
}
