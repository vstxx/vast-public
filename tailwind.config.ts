import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif'
        ]
      },
      colors: {
        vast: {
          black: '#050507',
          ink: '#0a0b0f',
          panel: '#111218',
          panel2: '#171922',
          line: '#252834',
          soft: '#9aa0ad',
          bright: '#f3f5f8',
          cyan: '#74e7ff',
          blue: '#89a7ff',
          lilac: '#b7a7ff',
          amber: '#f0b86b'
        },
        token: {
          bg: 'var(--vast-bg)',
          ink: 'var(--vast-ink)',
          surface: 'var(--vast-surface)',
          surfaceStrong: 'var(--vast-surface-strong)',
          border: 'var(--vast-border)',
          text: 'var(--vast-text)',
          muted: 'var(--vast-muted)',
          accent: 'var(--vast-accent)'
        }
      },
      boxShadow: {
        glass: '0 24px 80px rgba(0,0,0,0.36)',
        glow: '0 0 40px rgba(116,231,255,0.14)'
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(.2,.8,.2,1)'
      }
    }
  },
  plugins: []
} satisfies Config
