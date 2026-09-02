/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4fb',
          100: '#d9e6f5',
          600: '#1f4e78',
          700: '#193f60',
          900: '#0f2740',
        },
      },
    },
  },
  plugins: [],
}
