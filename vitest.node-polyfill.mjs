import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const workerThreads = require('node:worker_threads');

if (typeof workerThreads.markAsUncloneable !== 'function') {
  workerThreads.markAsUncloneable = () => {};
}
