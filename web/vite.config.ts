import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: true,
    port: 38091,
    proxy: {
      '/health': 'http://localhost:38090',
      '/api': 'http://localhost:38090',
    },
  },
});