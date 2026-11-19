import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', '*.vsix'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
  {
    // Parsing, model, layout and validation code must stay free of the
    // vscode module so it can be unit-tested in plain Node.
    // The pure parts of src/views and the webview UI follow the same rule.
    files: [
      'src/input/**',
      'src/model/**',
      'src/bpmn/**',
      'src/xsd/**',
      'src/twx/**',
      'src/validate/**',
      'src/views/exportFiles.ts',
      'src/views/protocol.ts',
      'src/views/viewModel.ts',
      'src/views/viewerSession.ts',
      'src/views/webviewHtml.ts',
      'src/views/watchPattern.ts',
      'webview/**',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'vscode', message: 'Keep this layer vscode-free (unit-testable in plain Node).' }] }],
    },
  },
);
