/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,html}'],
  // Touch screens leave a sticky :hover on whatever element a finger last
  // touched, so every `hover:` utility in the app doubles as a false
  // "selected" marker on the tablet: issue #88 saw it on the settings nav rows
  // (hover:text-white hover:bg-[#2c4a7a]) and on the skin cards
  // (hover:border-[#385a92], which leaves a blue outline around a skin that is
  // not active). This flag wraps the hover/group-hover/peer-hover variants in
  // @media (hover: hover), so hover styling only exists on pointers that can
  // really hover. Keep it on; the per-component touch overrides it replaces
  // had to re-state resting colours and drifted from them.
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      colors: {
        'base-400': '#9ca3af',
        'base-500': '#6b7280',
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: ['light'],
    logs: false,
  },
}
