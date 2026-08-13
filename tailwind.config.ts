import type { Config } from 'tailwindcss';

export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				keep: {
					default: '#ffffff',
					red: '#f28b82',
					orange: '#f6aea0',
					yellow: '#f7d875',
					green: '#b3e2a1',
					teal: '#98e9d9',
					blue: '#a9d5f4',
					darkblue: '#9bb8f3',
					purple: '#c6b3f2',
					pink: '#f9c2d8',
					brown: '#d6c5b0',
					gray: '#f0f0f0'
				}
			},
			fontFamily: {
				sans: ['"Google Sans"', '"Roboto"', 'system-ui', 'Arial', 'sans-serif'],
				roboto: ['"Roboto"', 'system-ui', 'sans-serif']
			}
		}
	},
	darkMode: 'class'
} satisfies Config;
