import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({resolve:{alias:Object.fromEntries(['contracts','storage','services','note-templates'].map(n=>[`@english-reader/${n}`,resolve(`packages/${n}/src/index.ts`)]))},test:{environment:'jsdom',include:['tests/**/*.test.ts','tests/**/*.test.tsx'],exclude:['tests/e2e/**','tests/*.test.ts'],restoreMocks:true}});
