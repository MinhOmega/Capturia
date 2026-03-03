import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://MinhOmega.github.io',
  base: '/Capturia/',
  integrations: [tailwind()],
});
