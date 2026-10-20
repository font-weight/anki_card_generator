import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({resolve:{alias:{'@english-reader/storage':fileURLToPath(new URL('./storage-placeholder.ts',import.meta.url))}},test:{environment:'jsdom',include:['tests/security/**/*.test.ts'],restoreMocks:true}});
