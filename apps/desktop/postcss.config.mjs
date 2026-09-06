/**
 * Tailwind v4 has a single PostCSS plugin -- `autoprefixer` and
 * `postcss-import` are built in and must not be added again.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
