import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const tempDir = () => mkdtempSync(join(tmpdir(), 'orchestrator-'))

export function sampleBrief(overrides = {}) {
  return {
    title: 't', goal: 'g', constraints: [], acceptance: ['a'], refs: [], ...overrides,
  }
}
