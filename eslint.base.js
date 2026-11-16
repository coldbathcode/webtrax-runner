// ESLint flat config shared by every runner package. Self-contained on
// purpose: the runner imports nothing from outside runner/ (ADR 0010), not
// even the monorepo's @webtrax/config. test/independence.test.ts enforces it.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export function runner() {
  return tseslint.config(
    { ignores: ['dist/**', '.turbo/**', 'node_modules/**', 'schema/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    { languageOptions: { globals: { ...globals.node } } },
    { files: ['**/*.ts', '**/*.mts'], rules: { 'no-undef': 'off' } },
    { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
  )
}

export default runner
