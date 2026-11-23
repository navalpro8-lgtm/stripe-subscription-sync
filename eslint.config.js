import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'examples/**/node_modules/', 'examples/**/.next/', 'examples/**/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (the example's sandbox harness).
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly', setTimeout: 'readonly',
        structuredClone: 'readonly', Request: 'readonly',
      },
    },
  },
);
