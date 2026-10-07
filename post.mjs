import { cleanup, reportFailure } from './builder.mjs';

try {
  await cleanup();
} catch (error) {
  reportFailure(error, 'warning');
}
