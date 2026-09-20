import tempelEslintConfig from '@tempel/eslint';

export default [
  {
    ignores: ['dist/**', '.jscpd/**', 'coverage/**'],
  },
  ...tempelEslintConfig,
];
