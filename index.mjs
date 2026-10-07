import { reportFailure, setup } from './builder.mjs';

try {
  await setup();
} catch (error) {
  reportFailure(error);
  process.exitCode = 1;
}
