import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // The module is linked from the repository root (file:../..), which is outside this folder.
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
};

export default config;
